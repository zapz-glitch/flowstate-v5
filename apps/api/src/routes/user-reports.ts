/**
 * User Reports Routes (Session Auth)
 *
 * Authenticated endpoints for listing and viewing saved analysis reports.
 * Uses session auth via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc, sql } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { savedReports } from '../db/schema'

const userReports = new Hono<{ Bindings: Env }>()

async function getSession(c: any) {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)
  try {
    return await auth.api.getSession({ headers: c.req.raw.headers })
  } catch {
    return null
  }
}

// ─── GET /user/reports ────────────────────────────────────────────────────────

userReports.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const offset = (page - 1) * limit

  const db = drizzle(c.env.DB)

  const [reports, countResult] = await Promise.all([
    db
      .select({
        id: savedReports.id,
        jobId: savedReports.jobId,
        propertyAddress: savedReports.propertyAddress,
        propertyCity: savedReports.propertyCity,
        propertyState: savedReports.propertyState,
        arv: savedReports.arv,
        maxAllowableOffer: savedReports.maxAllowableOffer,
        estimatedRepairs: savedReports.estimatedRepairs,
        createdAt: savedReports.createdAt,
      })
      .from(savedReports)
      .where(eq(savedReports.userId, session.user.id))
      .orderBy(desc(savedReports.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(savedReports)
      .where(eq(savedReports.userId, session.user.id))
      .then((r) => r[0]),
  ])

  const total = countResult?.count ?? 0
  const totalPages = Math.ceil(total / limit)

  return c.json({
    reports,
    pagination: { page, limit, total, totalPages },
  })
})

// ─── GET /user/reports/:jobId ─────────────────────────────────────────────────

userReports.get('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report) {
    return c.json({ error: 'Report not found' }, 404)
  }

  // Verify the report belongs to the authenticated user
  if (report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  let analysis = null
  if (report.fullResponseJson) {
    try {
      analysis = JSON.parse(report.fullResponseJson)
    } catch {
      return c.json({ error: 'Report data is corrupted' }, 500)
    }
  }

  return c.json({
    jobId: report.jobId,
    address: report.propertyAddress,
    createdAt: report.createdAt,
    analysis,
  })
})

export default userReports
