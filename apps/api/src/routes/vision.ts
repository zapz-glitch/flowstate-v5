/**
 * Vision Analysis Routes (Dashboard / Session Auth)
 *
 * On-demand AI vision analysis of property photos.
 * Separated from the main analysis workflow so users can trigger it manually.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { createVisionService } from '../services/vision'

const visionRoute = new Hono<{ Bindings: Env }>()

// ─── POST /vision/analyze ────────────────────────────────────────────────────

visionRoute.post('/analyze', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json<{
    photoUrls: string[]
    propertyContext?: {
      address?: string
      squareFeet?: number
      yearBuilt?: number
    }
  }>()

  if (!body.photoUrls || !Array.isArray(body.photoUrls) || body.photoUrls.length === 0) {
    return c.json({ error: 'photoUrls is required and must be a non-empty array' }, 400)
  }

  // Limit to 10 photos max
  const photoUrls = body.photoUrls.slice(0, 10)

  const visionService = createVisionService(c.env)
  if (!visionService.isAvailable()) {
    return c.json({ error: 'Vision analysis not available — OPENROUTER_API_KEY not configured' }, 503)
  }

  const startTime = Date.now()
  const result = await visionService.analyzePropertyCondition(photoUrls, body.propertyContext)
  const durationMs = Date.now() - startTime

  if (!result.success) {
    return c.json({ error: result.error || 'Vision analysis failed' }, 500)
  }

  return c.json({
    success: true,
    data: result.data,
    cached: (result as { cached?: boolean }).cached ?? false,
    durationMs,
  })
})

export default visionRoute
