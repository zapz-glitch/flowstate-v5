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

/** Batch probe — the production fan-out (startCompEvidenceBatch, 15 lanes)
 *  with wall-clock timings so latency work is measurable. Body:
 *  { comps: [{address, city, state, zipCode, propertyId?, ...}] } */
dev.post('/comp-condition-batch', async (c) => {
  const body = await c.req.json<{
    comps?: Array<Record<string, unknown>>
    gatherOnly?: boolean
    perCompTimeoutMs?: number
    lanes?: number
  }>()
  const comps = (body.comps ?? []).map((b, i) => ({
    propertyId: (b.propertyId as string) ?? `dev-b${i}`,
    address: b.address as string,
    city: b.city as string,
    state: b.state as string,
    zipCode: b.zipCode as string,
    salePrice: b.salePrice as number | undefined,
    saleDate: b.saleDate as string | undefined,
    yearBuilt: b.yearBuilt as number | undefined,
    squareFeet: b.squareFeet as number | undefined,
  }))
  if (!comps.length) return c.json({ error: 'comps required' }, 400)
  const { startCompEvidenceBatch } = await import('../services/comp-evidence')
  const gatherOnly = body.gatherOnly === true
  const t0 = Date.now()
  const out = await startCompEvidenceBatch(c.env, comps, {
    subject: { squareFeet: 1800 },
    gatherOnly,
    perCompTimeoutMs: body.perCompTimeoutMs as number | undefined,
    lanes: body.lanes as number | undefined,
  })
  const wallMs = Date.now() - t0
  return c.json({
    success: true,
    wallMs,
    gatherOnly,
    data: comps.map((cp) => {
      const ev = out.get(cp.propertyId)
      return {
        propertyId: cp.propertyId,
        source: ev?.listing?.source ?? null,
        photoCount: ev?.listing?.photoCount ?? 0,
        tier: ev?.condition?.tier ?? null,
        model: ev?.condition?.model ?? null,
        classifyMs: ev?.condition?.durationMs ?? null,
        skipped: ev?.skippedReason ?? (ev == null ? 'lane timeout' : null),
      }
    }),
  })
})

/** Streaming-pool probe — gatherOnly + startCompClassifyPool + onComp feed,
 *  exactly the eval's wiring. Returns per-comp evidence fields and the
 *  condition the pool stamped (or why it skipped). */
dev.post('/comp-classify-pool', async (c) => {
  const body = await c.req.json<{ comps?: Array<Record<string, unknown>> }>()
  const comps = (body.comps ?? []).map((b, i) => ({
    propertyId: (b.propertyId as string) ?? `dev-p${i}`,
    address: b.address as string,
    city: b.city as string,
    state: b.state as string,
    zipCode: b.zipCode as string,
    salePrice: b.salePrice as number | undefined,
    saleDate: b.saleDate as string | undefined,
    yearBuilt: b.yearBuilt as number | undefined,
    squareFeet: b.squareFeet as number | undefined,
  }))
  if (!comps.length) return c.json({ error: 'comps required' }, 400)
  const { startCompEvidenceBatch } = await import('../services/comp-evidence')
  const t0 = Date.now()
  const evidence = await startCompEvidenceBatch(c.env, comps, {
    subject: { squareFeet: 1800 },
    gatherOnly: true,
  })
  const gatherMs = Date.now() - t0
  const totalMs = Date.now() - t0
  return c.json({
    success: true,
    gatherMs,
    classifyTailMs: totalMs - gatherMs,
    totalMs,
    data: comps.map((cp) => {
      const ev = evidence.get(cp.propertyId)
      return {
        propertyId: cp.propertyId,
        source: ev?.listing?.source ?? null,
        photoCount: ev?.listing?.photoCount ?? 0,
        tier: ev?.condition?.tier ?? null,
        model: ev?.condition?.model ?? null,
        skipped: ev?.skippedReason ?? (ev == null ? 'lane timeout' : null),
      }
    }),
  })
})

export default dev

/** Token warm probe — runs the same scheduled-handler path live so token
 *  health is verifiable without waiting for a cron tick. */
/** Direct probe for the Decisions observable lane — one comp call + one
 *  subject call with tiny fixtures; surfaces the real error instead of the
 *  eval lane's swallowed catch. */
dev.post('/observable-probe', async (c) => {
  const { decisionsCompObservables, decisionsSubjectObservables, computePocketBenchmark } = await import('../services/evaluation/observable')
  const bench = computePocketBenchmark(
    { id: 'subj', censusBlockGroup: '1', censusTract: 't' } as never,
    [
      { id: 'c1', salePrice: 400000, squareFeet: 1500, pricePerSqft: 267, sameBlockGroup: true },
      { id: 'c2', salePrice: 500000, squareFeet: 1600, pricePerSqft: 312, sameBlockGroup: true },
      { id: 'c3', salePrice: 300000, squareFeet: 1400, pricePerSqft: 214, sameBlockGroup: true },
      { id: 'c4', salePrice: 380000, squareFeet: 1450, pricePerSqft: 262, sameBlockGroup: false, censusTract: 't' },
    ] as never[],
  )
  const out: Record<string, unknown> = { benchmark: bench }
  try {
    out.comp = await decisionsCompObservables(c.env, {
      comp: { propertyId: 'c1', address: '1 Main St', salePrice: 400000, squareFeet: 1500 },
      salePrice: 400000, ppsf: 267,
      description: 'Updated 3/2 with new kitchen.', benchmark: bench,
    })
  } catch (e) { out.compError = String(e) }
  try {
    out.subject = await decisionsSubjectObservables(c.env, {
      subject: { address: '1 Main St', squareFeet: 1400, bedrooms: 3, bathrooms: 2 },
      photoUrls: [], coverPhotoUrl: null, description: 'Needs work.',
      benchmark: bench, askPrice: 350000, askPpsf: 250,
    })
  } catch (e) { out.subjectError = String(e) }
  return c.json(out)
})

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
