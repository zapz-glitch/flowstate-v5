/**
 * Dev-only verification routes — 404 in non-development environments.
 * These exist so E2E tests can exercise new services (Clef comp-condition,
 * listing evidence) through the real worker without a full analyze run.
 */
import { Hono } from 'hono'
import type { Env } from '../types'
import { gatherCompConditionEvidence } from '../services/comp-evidence'
import { isClefAvailable } from '../services/clef'

const dev = new Hono<{ Bindings: Env }>()

dev.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'Not found' }, 404)
  await next()
})

/** Service liveness — checks the AI binding is wired. */
dev.get('/clef-status', (c) => c.json({ clefAvailable: isClefAvailable(c.env) }))

/**
 * POST /dev/comp-condition
 * Fetch a comp's listing evidence (Zillow→Redfin→Realtor) and classify its
 * condition with Clef. Body: { address, city, state, zipCode,
 * propertyId?, salePrice?, saleDate?, yearBuilt?, squareFeet? }
 */
dev.post('/comp-condition', async (c) => {
  const body = await c.req.json<{
    address?: string
    city?: string
    state?: string
    zipCode?: string
    propertyId?: string
    salePrice?: number
    saleDate?: string
    yearBuilt?: number
    squareFeet?: number
  }>()
  if (!body.address || !body.city || !body.state || !body.zipCode) {
    return c.json({ error: 'address, city, state, zipCode required' }, 400)
  }
  const evidence = await gatherCompConditionEvidence(c.env, {
    propertyId: body.propertyId ?? 'dev-probe',
    address: body.address,
    city: body.city,
    state: body.state,
    zipCode: body.zipCode,
    salePrice: body.salePrice,
    saleDate: body.saleDate,
    yearBuilt: body.yearBuilt,
    squareFeet: body.squareFeet,
  })
  return c.json({ success: true, data: evidence })
})

export default dev

/** Token warm probe — runs the same scheduled-handler path live so token
 *  health is verifiable without waiting for a cron tick. */
dev.post('/attom-token-warm', async (c) => {
  const { warmAttomMcpToken } = await import('../services/property-api/providers/attom-mcp')
  await warmAttomMcpToken(c.env)
  const kv = await c.env.API_CACHE.get('attom-mcp:creds', 'json') as { expiresAt?: number } | null
  return c.json({
    ok: true,
    kvExpiry: kv?.expiresAt ? new Date(kv.expiresAt * 1000).toISOString() : null,
    mode: c.env.ATTOM_MCP_API_KEY ? 'api-key'
      : c.env.ATTOM_MCP_CLIENT_SECRET ? 'm2m' : 'oauth-pair',
  })
})

/** Geo probe — fetchCensusGeography against a coordinate inside the worker. */
dev.get('/geo-probe', async (c) => {
  const { fetchCensusGeography } = await import('../services/geo/census-geocoder')
  const lat = Number(c.req.query('lat'))
  const lng = Number(c.req.query('lng'))
  const geo = await fetchCensusGeography(lat, lng, c.env.API_CACHE, c.env.FIRECRAWL_API_KEY, c.env.GEOCODIO_API_KEY)
  return c.json({ lat, lng, geo, hasKey: !!c.env.GEOCODIO_API_KEY })
})
