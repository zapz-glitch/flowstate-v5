/**
 * Health Check Routes (no auth required)
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { createPropertyApi } from '../services/property-api'

const health = new Hono<{ Bindings: Env }>()

/**
 * GET /health
 * Health check endpoint
 */
health.get('/', async (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
})

/**
 * GET /health/db
 * Database health check
 */
health.get('/db', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>()
    return c.json({
      status: result?.ok === 1 ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return c.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Database check failed',
        timestamp: new Date().toISOString(),
      },
      500
    )
  }
})

/**
 * GET /health/keys
 * CoreLogic API key status
 */
health.get('/keys', async (c) => {
  try {
    const propertyApi = createPropertyApi(c.env)
    const keyStatus = propertyApi.getKeyStatus()

    return c.json({
      status: keyStatus.configured ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      provider: 'corelogic',
      configured: keyStatus.configured,
      hasToken: keyStatus.hasToken,
      message: keyStatus.configured
        ? 'CoreLogic API credentials configured'
        : 'CoreLogic API credentials not configured (CORELOGIC_CLIENT_ID and CORELOGIC_CLIENT_SECRET)',
    })
  } catch (error) {
    return c.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get key status',
        timestamp: new Date().toISOString(),
      },
      500
    )
  }
})

export default health
