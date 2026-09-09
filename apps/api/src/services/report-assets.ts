import type { Env } from '../types'

export interface ReportAssetSource {
  url: string
  kind: 'photo' | 'screenshot'
  capturedAt?: string
  sourcePageUrl?: string
  source?: 'zillow' | 'redfin' | 'realtor'
}
export interface ReportAsset extends ReportAssetSource {
  id: string
  propertyId: string
  sourceUrl: string
  capturedAt: string
  contentType: string
  bytes: number
}
const MAX_BYTES = 5 * 1024 * 1024
export function safeAssetUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
    return ['photos.zillowstatic.com', 'ssl.cdn-redfin.com', 'ap.rdcpix.com', 'ar.rdcpix.com'].includes(url.hostname) ||
      (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/firecrawl-scrape-media/'))
  } catch { return false }
}
export function assetKey(jobId: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(jobId) || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid report asset ID')
  return `reports/${jobId}/${id}`
}

export async function deleteReportAssets(env: Pick<Env, 'REPORT_ASSETS'>, jobId: string, hasRecordedAssets: boolean) {
  const prefix = assetKey(jobId, '00000000-0000-0000-0000-000000000000').replace(/[^/]+$/, '')
  if (!env.REPORT_ASSETS) {
    if (hasRecordedAssets) throw new Error('Report asset storage unavailable')
    return
  }
  // Keep the report row until every page is deleted; partial failures are retryable.
  for (let page = 0; page < 100; page++) {
    const result = await env.REPORT_ASSETS.list({ prefix, limit: 1000 })
    const keys = result.objects.map(object => object.key)
    if (keys.some(key => !key.startsWith(prefix))) throw new Error('Unexpected report asset prefix')
    if (keys.length) await env.REPORT_ASSETS.delete(keys)
    if (!result.truncated) return
  }
  throw new Error('Report asset cleanup needs another attempt')
}
async function imageBytes(response: Response): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!response.ok || response.status !== 200) throw new Error(`Asset HTTP ${response.status}`)
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new Error('Unsupported asset type')
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Asset exceeds size limit')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) throw new Error('Asset exceeds size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const signature = contentType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : contentType === 'image/png' ? [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)
    : new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP'
  if (!signature) throw new Error('Asset bytes do not match image type')
  return { bytes, contentType }
}

export async function persistReportAssets(env: Pick<Env, 'REPORT_ASSETS' | 'ENVIRONMENT' | 'V4_STAGING_ASSETS_ENABLED'>, jobId: string, propertyId: string, sources: ReportAssetSource[], options: { fetcher?: typeof fetch } = {}) {
  const assets: ReportAsset[] = [], errors: string[] = []
  const enabled = env.ENVIRONMENT === 'development' || (env.ENVIRONMENT === 'staging' && env.V4_STAGING_ASSETS_ENABLED === 'true')
  if (!enabled || !env.REPORT_ASSETS) return { assets, errors: ['Private report asset storage unavailable'] }
  const candidates = [...new Map(sources.map(source => [source.url, source])).values()].slice(0, 4)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const source = candidates[cursor++]
      try {
        if (!safeAssetUrl(source.url)) throw new Error('Untrusted asset host')
        const id = crypto.randomUUID(), key = assetKey(jobId, id)
        const response = await (options.fetcher ?? fetch)(source.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
        const { bytes, contentType } = await imageBytes(response)
        const capturedAt = source.capturedAt && Number.isFinite(Date.parse(source.capturedAt)) ? source.capturedAt : new Date().toISOString()
        await env.REPORT_ASSETS!.put(key, bytes, { httpMetadata: { contentType }, customMetadata: {
          jobId, propertyId, sourceUrl: source.url, capturedAt, kind: source.kind,
          sourcePageUrl: source.sourcePageUrl ?? '', source: source.source ?? '',
        }, onlyIf: { etagDoesNotMatch: '*' } })
        assets.push({ ...source, id, propertyId, sourceUrl: source.url, capturedAt, contentType, bytes: bytes.length, url: `/user/reports/${encodeURIComponent(jobId)}/assets/${id}` })
      } catch (error) { errors.push(error instanceof Error && /^(Asset |Unsupported |Untrusted |Invalid )/.test(error.message) ? error.message : 'Asset capture failed') }
    }
  }))
  return { assets, errors }
}
