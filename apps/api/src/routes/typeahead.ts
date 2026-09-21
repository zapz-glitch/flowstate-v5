/**
 * Address Typeahead Route
 *
 * Proxies to CoreLogic typeahead API for address autocomplete.
 * Session-authenticated (dashboard cookies).
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { corelogicTypeahead } from '../services/property-api/providers/corelogic'

const typeahead = new Hono<{ Bindings: Env }>()

/** 5 minutes — typeahead suggestions are stable; repeated prefixes are free. */
const TYPEAHEAD_CACHE_TTL_SECONDS = 300

typeahead.get('/', async (c) => {
  const input = c.req.query('input')
  if (!input || input.length < 3) {
    return c.json({ results: [] })
  }

  // Require session auth
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const cacheKey = `typeahead:${input.trim().toLowerCase().replace(/\s+/g, ' ')}`
  if (c.env.API_CACHE) {
    try {
      const cached = await c.env.API_CACHE.get(cacheKey)
      if (cached) return c.json({ results: JSON.parse(cached) })
    } catch { /* cache best-effort */ }
  }

  try {
    const results = await corelogicTypeahead(c.env, input)
    if (c.env.API_CACHE) {
      c.executionCtx.waitUntil(
        c.env.API_CACHE.put(cacheKey, JSON.stringify(results), {
          expirationTtl: TYPEAHEAD_CACHE_TTL_SECONDS,
        }).catch(() => { /* cache best-effort */ })
      )
    }
    return c.json({ results })
  } catch (error) {
    console.error('[Typeahead] Error:', error instanceof Error ? error.message : error)
    return c.json({ error: 'Address provider unavailable. Retry the search shortly.' }, 502)
  }
})

export default typeahead
