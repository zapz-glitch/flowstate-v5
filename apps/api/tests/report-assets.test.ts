import assert from 'node:assert/strict'
import { persistReportAssets, safeAssetUrl, deleteReportAssets } from '../src/services/report-assets'
import { signAccessToken } from '../src/lib/share-token'
import { createReportAssetRoutes } from '../src/routes/report-assets'

const jpeg = new Uint8Array([255,216,255,224,1,2,3])
const stored = new Map<string, any>()
const bucket = { put: async (key: string, bytes: Uint8Array, options: any) => { stored.set(key, { bytes, ...options }); return {} }, get: async (key: string) => { const item = stored.get(key); return item ? { body: item.bytes, httpMetadata: item.httpMetadata, httpEtag: 'test-etag' } : null } }
const env = { ENVIRONMENT: 'development', REPORT_ASSETS: bucket } as any
const source = { url: 'https://photos.zillowstatic.com/fp/photo.jpg', kind: 'photo', capturedAt: '2026-09-08T00:00:00Z', source: 'zillow' } as const
const capture = (response: () => Response) => persistReportAssets(env, 'job_test', 'property', [source], { fetcher: async (_url, init) => { assert.equal(init?.redirect, 'manual'); return response() } })
assert.equal(safeAssetUrl('https://photos.zillowstatic.com.attacker.example/a.jpg'), false)
assert.equal(safeAssetUrl('http://photos.zillowstatic.com/a.jpg'), false)
assert.equal(safeAssetUrl('https://user:pass@photos.zillowstatic.com/a.jpg'), false)
assert.equal(safeAssetUrl('https://storage.googleapis.com/another-bucket/image.png'), false)
for (const response of [
  () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
  () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
  () => new Response('html', { headers: { 'Content-Type': 'image/jpeg' } }),
  () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '99999999' } }),
  () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/jpeg' } }),
]) { const result = await capture(response); assert.equal(result.assets.length, 0); assert.equal(result.errors.length, 1) }
assert.equal(stored.size, 0)
for (const [environment, enabled, expected] of [['staging', 'true', 1], ['staging', 'false', 0], ['production', 'true', 0]] as const) {
  const result = await persistReportAssets({ ...env, ENVIRONMENT: environment, V4_STAGING_ASSETS_ENABLED: enabled }, 'job_stage', 'property', [source], { fetcher: async () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }) })
  assert.equal(result.assets.length, expected)
}
stored.clear()
const result = await capture(() => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }))
assert.equal(result.assets.length, 1)
assert.equal(result.assets[0].capturedAt, source.capturedAt)
assert.equal(result.assets[0].sourceUrl, source.url)
assert.equal(stored.size, 1)
const blocked = await persistReportAssets({ ...env, ENVIRONMENT: 'production' }, 'job_test', 'property', [source], { fetcher: async () => { throw new Error('Must not fetch in production') } })
assert.equal(blocked.assets.length, 0)
assert.equal(stored.size, 1)
assert.equal([...stored.values()][0].customMetadata.propertyId, 'property')
assert.deepEqual([...stored.values()][0].onlyIf, { etagDoesNotMatch: '*' })
const path = result.assets[0].url.replace('/user/reports', '')
let storageReads = 0
const db = (owner: boolean, shared = false) => ({ prepare: () => ({ bind: (...values: string[]) => { assert.deepEqual(values, ['job_test']); return { first: async () => owner ? { user_id: 'owner', is_shared: shared ? 1 : 0 } : null } } }) })
const routeEnv = { ...env, DB: db(false), REPORT_ASSETS: { ...bucket, get: async (key: string) => { storageReads++; return bucket.get(key) } } }
assert.equal((await createReportAssetRoutes(async () => null).request(path, {}, routeEnv)).status, 401)
const route = createReportAssetRoutes(async () => ({ user: { id: 'owner' } }) as any)
assert.equal((await route.request(path, {}, routeEnv)).status, 404)
assert.equal(storageReads, 0)
const allowed = await route.request(path, {}, { ...routeEnv, DB: db(true) })
assert.equal(allowed.status, 200)
assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store')
assert.equal(allowed.headers.get('X-Content-Type-Options'), 'nosniff')
assert.deepEqual(new Uint8Array(await allowed.arrayBuffer()), jpeg)
const secret = 'test-report-share-secret'
const anonymous = createReportAssetRoutes(async () => null)
const shareEnv = { ...routeEnv, DB: db(true, true), BETTER_AUTH_SECRET: secret }
for (const [job, ttl, expected] of [['job_test', 60000, 200], ['job_other', 60000, 404], ['job_test', -1000, 404]] as const) {
  const token = await signAccessToken(job, secret, ttl)
  const response = await anonymous.request(path, { headers: { Cookie: `report_access=${token}` } }, shareEnv)
  assert.equal(response.status, expected)
}
const token = await signAccessToken('job_test', secret)
assert.equal((await anonymous.request(path, { headers: { Cookie: `report_access=${token}` } }, { ...shareEnv, DB: db(true, false) })).status, 404)
assert.equal((await createReportAssetRoutes(async () => ({ user: { id: 'other' } }) as any).request(path, {}, shareEnv)).status, 404)
const deleted: string[][] = []
let pages = 0
await deleteReportAssets({ REPORT_ASSETS: {
  list: async ({ prefix }: any) => { assert.equal(prefix, 'reports/job_test/'); return { objects: [{ key: `${prefix}${++pages}` }], truncated: pages === 1 } },
  delete: async (keys: string[]) => { deleted.push(keys) },
} } as any, 'job_test', true)
assert.deepEqual(deleted, [['reports/job_test/1'], ['reports/job_test/2']])
await assert.rejects(deleteReportAssets({}, 'job_test', true), /unavailable/)
await deleteReportAssets({}, 'job_test', false)
await assert.rejects(deleteReportAssets({ REPORT_ASSETS: { list: async () => ({ objects: [{ key: 'reports/job_other/asset' }], truncated: false }), delete: async () => { throw new Error('must not delete') } } } as any, 'job_test', true), /prefix/)
await assert.rejects(deleteReportAssets({ REPORT_ASSETS: { list: async () => ({ objects: [{ key: 'reports/job_test/asset' }], truncated: false }), delete: async () => { throw new Error('storage offline') } } } as any, 'job_test', true), /storage offline/)
console.log('Report assets: allowlist, redirects, bounded bytes, image types, provenance, auth and report ownership passed')
