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

  try {
    const results = await corelogicTypeahead(c.env, input)
    return c.json({ results })
  } catch (error) {
    console.error('[Typeahead] Error:', error instanceof Error ? error.message : error)
    return c.json({ results: [] })
  }
})

export default typeahead
