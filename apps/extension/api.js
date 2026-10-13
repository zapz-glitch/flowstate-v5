// Talks to the Flowstate API. `fetchFn` is passed in so tests can stand in for the network.

const UNREACHABLE = 'Could not reach Flowstate. Check your connection and the API address in the options.'
const BAD_KEY = 'Flowstate did not accept the API key. Check it in the extension options.'

async function call(fetchFn, url, init, timeoutMs = 15_000) {
  let response
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { failed: UNREACHABLE }
  }
  const body = await response.json().catch(() => null)
  if (response.status === 401 || response.status === 403) return { failed: BAD_KEY, status: response.status }
  if (!response.ok || body?.success === false) return { failed: body?.error || `Flowstate answered with error ${response.status}.`, status: response.status }
  return { body }
}

const keyHeaders = (apiKey) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` })

/** The two numbers shown in the popup and the notification. */
export function summarize(result) {
  const valuation = result?.valuation ?? {}
  return { arv: valuation.arv ?? null, offer: valuation.buyPrice ?? null }
}

/** Starts an evaluation. The API answers at once with a saved result for a repeat address. */
export async function startAnalysis({ apiUrl, apiKey, address }, fetchFn = fetch) {
  const { body, failed } = await call(fetchFn, `${apiUrl}/v1/analyze`, {
    method: 'POST',
    headers: keyHeaders(apiKey),
    // Same request the dashboard search sends; thresholds come from the user's saved settings.
    body: JSON.stringify({ address, searchOptions: { radiusMiles: 1, monthsBack: 12 }, marketData: { enabled: true } }),
  }, 90_000) // the route looks the property up before it answers
  if (failed) return { state: 'error', error: failed }
  const { jobId, result } = body?.data ?? {}
  if (!jobId) return { state: 'error', error: 'Flowstate did not return a job.' }
  return result ? { state: 'done', jobId, ...summarize(result) } : { state: 'running', jobId }
}

/** Polls one evaluation. */
export async function checkJob({ apiUrl, apiKey, jobId }, fetchFn = fetch) {
  const { body, failed, status } = await call(fetchFn, `${apiUrl}/v1/analyze/jobs/${encodeURIComponent(jobId)}`, { headers: keyHeaders(apiKey) })
  if (failed) return status ? { state: 'error', error: failed } : { state: 'running' }
  const data = body?.data ?? {}
  if (data.status === 'complete') return { state: 'done', ...summarize(data.result) }
  if (data.status === 'error') return { state: 'error', error: data.error || 'The evaluation failed.' }
  return { state: 'running' }
}

/** The newest saved report for an address, or null. Uses the dashboard sign-in, not the API key. */
export async function findExistingReport({ apiUrl, address }, fetchFn = fetch) {
  const { body } = await call(fetchFn, `${apiUrl}/user/reports/by-property?address=${encodeURIComponent(address)}`, { credentials: 'include' }, 4_000) // never hold a send up for long
  const report = body?.reports?.[0]
  return report?.jobId ? { jobId: report.jobId, arv: report.arv ?? null, offer: report.maxAllowableOffer ?? null } : null
}

/** A cheap authenticated read, so the options page can confirm a pasted key. */
export async function verifyKey({ apiUrl, apiKey }, fetchFn = fetch) {
  const { failed } = await call(fetchFn, `${apiUrl}/v1/analyze/defaults`, { headers: keyHeaders(apiKey) })
  return failed ? { ok: false, error: failed } : { ok: true }
}
