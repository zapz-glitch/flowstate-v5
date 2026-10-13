import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkJob, findExistingReport, startAnalysis, verifyKey } from '../api.js'

// A stand-in for fetch: records the call and answers with the given status + JSON.
function fakeFetch(status, body) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (status === 0) throw new TypeError('Failed to fetch')
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return Object.assign(fn, { calls })
}
const conn = { apiUrl: 'http://localhost:8787', apiKey: 'fs_test' }

test('starting an evaluation reports running, already done, or why it failed', async () => {
  const running = fakeFetch(200, { success: true, data: { jobId: 'job_1', result: null } })
  assert.deepEqual(await startAnalysis({ ...conn, address: '1 A St, Tampa, FL 33604' }, running), { state: 'running', jobId: 'job_1' })
  const { url, init } = running.calls[0]
  assert.equal(url, 'http://localhost:8787/v1/analyze')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer fs_test')
  assert.deepEqual(JSON.parse(init.body), { address: '1 A St, Tampa, FL 33604', searchOptions: { radiusMiles: 1, monthsBack: 12 }, marketData: { enabled: true } })

  const cached = fakeFetch(200, { success: true, data: { jobId: 'job_old', cached: true, result: { valuation: { arv: 290606.4, buyPrice: 171986 } } } })
  assert.deepEqual(await startAnalysis({ ...conn, address: 'x' }, cached), { state: 'done', jobId: 'job_old', arv: 290606.4, offer: 171986 })

  assert.deepEqual(await startAnalysis({ ...conn, address: 'x' }, fakeFetch(401, { success: false, error: 'Invalid API key' })), { state: 'error', error: 'Flowstate did not accept the API key. Check it in the extension options.' })
  assert.deepEqual(await startAnalysis({ ...conn, address: 'x' }, fakeFetch(400, { success: false, error: 'Property not found' })), { state: 'error', error: 'Property not found' })
  assert.deepEqual(await startAnalysis({ ...conn, address: 'x' }, fakeFetch(0)), { state: 'error', error: 'Could not reach Flowstate. Check your connection and the API address in the options.' })
})

test('checking a job reports still running, done with numbers, or failed', async () => {
  const job = { ...conn, jobId: 'job_1' }
  const processing = fakeFetch(200, { success: true, data: { jobId: 'job_1', status: 'processing' } })
  assert.deepEqual(await checkJob(job, processing), { state: 'running' })
  assert.equal(processing.calls[0].url, 'http://localhost:8787/v1/analyze/jobs/job_1')
  assert.equal(processing.calls[0].init.headers.Authorization, 'Bearer fs_test')
  assert.deepEqual(await checkJob(job, fakeFetch(200, { success: true, data: { status: 'awaiting_agent' } })), { state: 'running' })
  assert.deepEqual(await checkJob(job, fakeFetch(200, { success: true, data: { status: 'complete', result: { valuation: { arv: 300000, buyPrice: 180000 } } } })), { state: 'done', arv: 300000, offer: 180000 })
  assert.deepEqual(await checkJob(job, fakeFetch(200, { success: true, data: { status: 'error', error: 'No comps found' } })), { state: 'error', error: 'No comps found' })
  assert.deepEqual(await checkJob(job, fakeFetch(404, { success: false, error: 'Job not found' })), { state: 'error', error: 'Job not found' })
  // A dropped connection is not a failed evaluation — keep waiting.
  assert.deepEqual(await checkJob(job, fakeFetch(0)), { state: 'running' })
})

test('an address that already has a report is found through the signed-in session', async () => {
  const found = fakeFetch(200, { reports: [{ jobId: 'job_new', propertyAddress: '910 E ESKIMO AVE, TAMPA, FL 33604', arv: 290606, maxAllowableOffer: 171986 }, { jobId: 'job_older', arv: 1, maxAllowableOffer: 1 }] })
  assert.deepEqual(await findExistingReport({ apiUrl: 'http://localhost:8787', address: '910 E Eskimo Ave, Tampa, FL 33604' }, found), { jobId: 'job_new', arv: 290606, offer: 171986 })
  assert.equal(found.calls[0].url, 'http://localhost:8787/user/reports/by-property?address=910%20E%20Eskimo%20Ave%2C%20Tampa%2C%20FL%2033604')
  assert.equal(found.calls[0].init.credentials, 'include')
  // No report, signed out, or offline all mean "nothing found" — the send carries on.
  assert.equal(await findExistingReport({ apiUrl: 'x', address: 'y' }, fakeFetch(200, { reports: [] })), null)
  assert.equal(await findExistingReport({ apiUrl: 'x', address: 'y' }, fakeFetch(401, { error: 'Not authenticated' })), null)
  assert.equal(await findExistingReport({ apiUrl: 'x', address: 'y' }, fakeFetch(0)), null)
})

test('the options page can tell a working key from a bad one', async () => {
  const good = fakeFetch(200, { success: true, data: {} })
  assert.deepEqual(await verifyKey(conn, good), { ok: true })
  assert.equal(good.calls[0].url, 'http://localhost:8787/v1/analyze/defaults')
  assert.equal(good.calls[0].init.headers.Authorization, 'Bearer fs_test')
  assert.deepEqual(await verifyKey(conn, fakeFetch(401, { success: false, error: 'Invalid API key' })), { ok: false, error: 'Flowstate did not accept the API key. Check it in the extension options.' })
  assert.deepEqual(await verifyKey(conn, fakeFetch(0)), { ok: false, error: 'Could not reach Flowstate. Check your connection and the API address in the options.' })
})
