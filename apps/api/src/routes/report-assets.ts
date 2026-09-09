import { Hono } from 'hono'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { assetKey } from '../services/report-assets'
import { getCookie } from 'hono/cookie'
import { verifyAccessToken } from '../lib/share-token'

export function createReportAssetRoutes(sessionResolver = getSession) {
  const route = new Hono<{ Bindings: Env }>()
  route.get('/:jobId/assets/:assetId', async c => {
    const session = await sessionResolver(c)
    const accessToken = getCookie(c, 'report_access')
    if (!session?.user && !accessToken) return c.json({ error: 'Not authenticated' }, 401)
    let key: string
    try { key = assetKey(c.req.param('jobId'), c.req.param('assetId')) }
    catch { return c.json({ error: 'Asset not found' }, 404) }
    const report = await c.env.DB.prepare('SELECT user_id, is_shared FROM saved_reports WHERE job_id = ? LIMIT 1')
      .bind(c.req.param('jobId')).first<{ user_id: string; is_shared: number }>()
    const owner = report && session?.user?.id === report.user_id
    const shared = report?.is_shared === 1 && accessToken && c.env.BETTER_AUTH_SECRET &&
      await verifyAccessToken(accessToken, c.env.BETTER_AUTH_SECRET) === c.req.param('jobId')
    if (!owner && !shared) return c.json({ error: 'Asset not found' }, 404)
    const asset = await c.env.REPORT_ASSETS?.get(key)
    if (!asset) return c.json({ error: 'Asset not found' }, 404)
    return new Response(asset.body, { headers: {
      'Content-Type': asset.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'", ETag: asset.httpEtag,
    } })
  })
  return route
}
export default createReportAssetRoutes()
