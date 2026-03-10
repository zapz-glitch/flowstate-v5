/**
 * Auth Routes - Better Auth Handler for Hono
 *
 * Handles all auth endpoints: /auth/*
 * - POST /auth/sign-in/email
 * - POST /auth/sign-up/email
 * - POST /auth/sign-out
 * - GET /auth/session
 * - etc.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'

const auth = new Hono<{ Bindings: Env }>()

// Handle all auth routes via Better Auth
auth.all('/*', async (c) => {
  const baseURL = c.req.url.split('/auth')[0] + '/auth'

  if (!c.env.BETTER_AUTH_SECRET) {
    return c.json({ error: 'BETTER_AUTH_SECRET not configured' }, 500)
  }

  const authInstance = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL, {
    host: c.env.SMTP_HOST,
    port: c.env.SMTP_PORT,
    user: c.env.SMTP_USER,
    pass: c.env.SMTP_PASS,
    from: c.env.SMTP_FROM,
  }, c.env.DASHBOARD_URL)

  // Convert Hono request to standard Request
  const request = c.req.raw

  try {
    const response = await authInstance.handler(request)
    return response
  } catch (error) {
    console.error('Auth error:', error)
    return c.json(
      {
        error: 'Authentication error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

export default auth
