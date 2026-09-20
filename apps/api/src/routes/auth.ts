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

// Sign-in lockout: block an IP for 15 minutes after 3 failed attempts.
// Counts FAILURES only (not requests) — a successful sign-in clears the
// counter. Stored in D1 so the block holds across Workers isolates.
const LOCKOUT_MAX_FAILURES = 3
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

auth.use('/sign-in/email', async (c, next) => {
  if (c.req.method !== 'POST') return next()

  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  const now = Date.now()
  const db = c.env.DB

  const row = await db
    .prepare('SELECT count, last_attempt FROM login_failures WHERE ip = ?')
    .bind(ip)
    .first<{ count: number; last_attempt: number }>()

  if (row && row.count >= LOCKOUT_MAX_FAILURES && now - row.last_attempt < LOCKOUT_WINDOW_MS) {
    const retryAfter = Math.ceil((row.last_attempt + LOCKOUT_WINDOW_MS - now) / 1000)
    return c.json(
      { message: 'Too many failed sign-in attempts. Please try again later.' },
      429,
      { 'X-Retry-After': String(retryAfter) }
    )
  }

  await next()

  const status = c.res.status
  if (status === 401 || status === 403) {
    const count = row && now - row.last_attempt < LOCKOUT_WINDOW_MS ? row.count + 1 : 1
    await db
      .prepare(
        'INSERT INTO login_failures (ip, count, last_attempt) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, last_attempt = excluded.last_attempt'
      )
      .bind(ip, count, now)
      .run()
  } else if (status >= 200 && status < 300 && row) {
    await db.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run()
  }
})

// Handle all auth routes via Better Auth
auth.all('/*', async (c) => {
  const baseURL = c.req.url.split('/auth')[0] + '/auth'

  if (!c.env.BETTER_AUTH_SECRET) {
    return c.json({ error: 'BETTER_AUTH_SECRET not configured' }, 500)
  }

  const authInstance = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL, {
    token: c.env.FASTMAIL_API_TOKEN,
    from: c.env.AUTH_EMAIL_FROM,
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
