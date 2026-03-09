/**
 * SSE Stream Route
 *
 * Handles Server-Sent Events connections for real-time job updates.
 * Mounted OUTSIDE of the /v1 auth-protected routes because EventSource
 * cannot set custom headers — authentication is via signed URL token.
 *
 * Security:
 * - Uses short-lived HMAC-SHA256 signed tokens (5 minute expiry)
 * - Tokens are scoped to specific user, job, and property
 * - Origin header validation
 * - User existence verified in database
 *
 * Flow:
 * 1. Dashboard calls POST /v1/analyze/stream-token to get a signed token
 * 2. Dashboard opens EventSource at /sse/analyze/:jobId?token=xxx
 * 3. This route verifies the token and forwards to the Durable Object
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { verifyWsToken } from '../utils/ws-token'

const sseStream = new Hono<{ Bindings: Env }>()

// Allowed origins for SSE connections
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://dashboard.flowstate.homes',
  'https://app.flowstate.homes',
]

/**
 * GET /sse/analyze/:jobId
 *
 * SSE endpoint for real-time job updates.
 * Streams progress events as Server-Sent Events.
 *
 * Authentication via signed token in query parameter:
 * - token: HMAC-SHA256 signed token containing userId, jobId, propertyKey
 *
 * Token is obtained from POST /v1/analyze/stream-token (authenticated endpoint)
 */
sseStream.get('/analyze/:jobId', async (c) => {
  try {
    const jobIdParam = c.req.param('jobId')
    console.log(`[SSE Stream] Connection attempt for job: ${jobIdParam}`)

    // Validate Origin header (CSRF protection)
    const origin = c.req.header('Origin')
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      console.error(`[SSE Stream] Rejected connection from origin: ${origin}`)
      return c.json(
        { success: false, error: 'Origin not allowed' },
        403
      )
    }

    // Get signed token from query params
    const token = c.req.query('token')

    if (!token) {
      return c.json(
        { success: false, error: 'Missing authentication token' },
        401
      )
    }

    // Verify signed token
    const secret = c.env.DASHBOARD_INTERNAL_SECRET
    if (!secret) {
      console.error('[SSE Stream] DASHBOARD_INTERNAL_SECRET not configured')
      return c.json(
        { success: false, error: 'Server configuration error' },
        500
      )
    }

    const payload = await verifyWsToken(token, secret)

    if (!payload) {
      return c.json(
        { success: false, error: 'Invalid or expired token' },
        401
      )
    }

    // Verify job ID matches token
    if (payload.jid !== jobIdParam) {
      console.error(`[SSE Stream] Job ID mismatch: ${payload.jid} !== ${jobIdParam}`)
      return c.json(
        { success: false, error: 'Token not valid for this job' },
        403
      )
    }

    // Verify user still exists
    const user = await c.env.DB.prepare(`SELECT id FROM user WHERE id = ?`)
      .bind(payload.uid)
      .first<{ id: string }>()

    if (!user) {
      return c.json(
        { success: false, error: 'User not found' },
        401
      )
    }

    // Get the job DO using the property key from the token
    const doId = c.env.ANALYSIS_JOB.idFromName(`${payload.uid}:${payload.pk}`)
    const jobDO = c.env.ANALYSIS_JOB.get(doId)

    console.log(`[SSE Stream] Forwarding to DO: ${payload.uid}:${payload.pk}`)

    // Forward to the DO's SSE endpoint
    return jobDO.fetch(new Request('http://internal/sse'))
  } catch (error) {
    console.error('[SSE Stream] Error:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to establish stream',
      },
      500
    )
  }
})

export default sseStream
