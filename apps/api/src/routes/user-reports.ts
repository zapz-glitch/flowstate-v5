/**
 * User Reports Routes (Session Auth)
 *
 * Authenticated endpoints for listing and viewing saved analysis reports.
 * Uses session auth via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc, sql, like, or, and } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { savedReports, reportHistory } from '../db/schema'
import { hashSharePassword } from '../lib/share-token'
import { bodyLimit } from 'hono/body-limit'
import { recalculateReport } from '../services/evaluation/recalculate'
import { deleteReportAssets } from '../services/report-assets'

const userReports = new Hono<{ Bindings: Env }>()

userReports.post('/:jobId/comps', bodyLimit({ maxSize: 20000 }), async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const origin = c.req.header('Origin')
  if (!c.env.DASHBOARD_URL || origin !== new URL(c.env.DASHBOARD_URL).origin) return c.json({ error: 'Untrusted origin' }, 403)
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON request required' }, 415)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['selectedCompIds', 'expectedRevision'].includes(key)) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      !(body.selectedCompIds === null || (Array.isArray(body.selectedCompIds) && body.selectedCompIds.length > 0 && body.selectedCompIds.length <= 500 &&
        body.selectedCompIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 128) && new Set(body.selectedCompIds).size === body.selectedCompIds.length))) {
    return c.json({ error: 'Provide at least one unique comparable ID (or null to reset) and the current revision' }, 400)
  }
  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)
  const [report] = await db.select().from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id))).limit(1)
  if (!report) return c.json({ error: 'Report not found' }, 404)
  let saved
  try { saved = JSON.parse(report.fullResponseJson ?? '{}') } catch { return c.json({ error: 'Report data is corrupted' }, 409) }
  if ((saved.evaluationRevision ?? 0) !== body.expectedRevision) return c.json({ error: 'This report changed. Reload it before editing comparables.' }, 409)
  let analysis
  try {
    analysis = await recalculateReport(saved, jobId, body.selectedCompIds, c.env, session.user.id)
  } catch (error) {
    if ((error as { status?: number }).status === 409) return c.json({ error: (error as Error).message }, 409)
    if ((error as { status?: number }).status === 422) return c.json({ error: (error as Error).message }, 422)
    return c.json({ error: 'Could not recalculate this selection. The saved report was not changed.' }, 502)
  }
  const nextJson = JSON.stringify(analysis)
  const changes = JSON.stringify({ actor: session.user.id, before: saved, after: analysis })
  const description = body.selectedCompIds === null ? 'Restored automatic comparable selection' : `Recalculated ${body.selectedCompIds.length} operator-selected comparables`
  const results = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO report_history (id, report_id, user_id, action, description, changes_json, created_at) SELECT ?, id, user_id, ?, ?, ?, ? FROM saved_reports WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(crypto.randomUUID(), 'comp_selection', description, changes, new Date().toISOString(), report.id, session.user.id, report.fullResponseJson),
    c.env.DB.prepare('UPDATE saved_reports SET full_response_json = ?, valuation_data = ?, comparables_data = ?, arv = ?, as_is_value = ?, max_allowable_offer = ?, estimated_repairs = ? WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(nextJson, JSON.stringify(analysis.valuation), JSON.stringify(analysis.comps), analysis.valuation?.arv ?? null, analysis.valuation?.asIsValue ?? null, analysis.valuation?.buyPrice ?? null, analysis.valuation?.rehabCost ?? null, report.id, session.user.id, report.fullResponseJson),
  ])
  if (results[1].meta.changes !== 1) return c.json({ error: 'This report changed. Reload it before editing comparables.' }, 409)
  return c.json({ analysis })
})

// ─── GET /user/reports ────────────────────────────────────────────────────────

userReports.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const offset = (page - 1) * limit
  const search = c.req.query('search')?.trim() || ''

  const db = drizzle(c.env.DB)

  // Build where clause with optional search filter
  const baseCondition = eq(savedReports.userId, session.user.id)
  const whereCondition = search
    ? and(
        baseCondition,
        or(
          like(savedReports.propertyAddress, `%${search}%`),
          like(savedReports.propertyCity, `%${search}%`),
          like(savedReports.propertyState, `%${search}%`)
        )
      )
    : baseCondition

  // One report per property — collapse legacy duplicate rows to the newest.
  const latestPerProperty = sql`${savedReports.id} IN (
    SELECT id FROM (
      SELECT id, MAX(created_at) AS mx FROM saved_reports
      WHERE user_id = ${session.user.id}
      GROUP BY property_address
    ) latest WHERE saved_reports.id = latest.id
  )`
  const dedupedCondition = and(whereCondition, latestPerProperty)

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
        isShared: savedReports.isShared,
        createdAt: savedReports.createdAt,
      })
      .from(savedReports)
      .where(dedupedCondition)
      .orderBy(desc(savedReports.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(savedReports)
      .where(dedupedCondition)
      .then((r) => r[0]),
  ])

  const total = countResult?.count ?? 0
  const totalPages = Math.ceil(total / limit)

  return c.json({
    reports,
    pagination: { page, limit, total, totalPages },
  })
})

// ─── GET /user/reports/by-property ───────────────────────────────────────────

userReports.get('/by-property', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const clip = c.req.query('clip')?.trim()
  const address = c.req.query('address')?.trim()
  if (!clip && !address) return c.json({ error: 'clip or address query parameter required' }, 400)

  const db = drizzle(c.env.DB)

  // Prefer CLIP match (exact), fall back to address (fuzzy)
  const condition = clip
    ? and(eq(savedReports.userId, session.user.id), eq(savedReports.propertyClip, clip))
    : and(eq(savedReports.userId, session.user.id), like(savedReports.propertyAddress, `%${address!.toUpperCase()}%`))

  const reports = await db.select({
    id: savedReports.id,
    jobId: savedReports.jobId,
    propertyAddress: savedReports.propertyAddress,
    propertyClip: savedReports.propertyClip,
    arv: savedReports.arv,
    maxAllowableOffer: savedReports.maxAllowableOffer,
    estimatedRepairs: savedReports.estimatedRepairs,
    createdAt: savedReports.createdAt,
  })
    .from(savedReports)
    .where(condition)
    .orderBy(desc(savedReports.createdAt))
    .limit(10)

  return c.json({ reports })
})

// ─── GET /user/reports/:jobId/history ───────────────────────────────────────

userReports.get('/:jobId/history', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  // Find the report
  const [report] = await db.select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)


  const history = await db.select()
    .from(reportHistory)
    .where(eq(reportHistory.reportId, report.id))
    .orderBy(desc(reportHistory.createdAt))
    .limit(50)

  return c.json({
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      description: h.description,
      changes: h.changesJson ? JSON.parse(h.changesJson) : null,
      createdAt: h.createdAt,
    })),
  })
})

// ─── POST /user/reports/:jobId/history ──────────────────────────────────────

userReports.post('/:jobId/history', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json().catch(() => ({})) as {
    action?: string
    description?: string
    changes?: unknown
  }

  if (!body.action || !body.description) {
    return c.json({ error: 'action and description required' }, 400)
  }
  if (body.action.startsWith('python_')) return c.json({ error: 'Reserved server history action' }, 400)

  const db = drizzle(c.env.DB)

  const [report] = await db.select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)

  const [entry] = await db.insert(reportHistory).values({
    reportId: report.id,
    userId: session.user.id,
    action: body.action,
    description: body.description,
    changesJson: body.changes ? JSON.stringify(body.changes) : null,
  }).returning()

  return c.json({ entry })
})

// ─── PUT /user/reports/:jobId ────────────────────────────────────────────────

userReports.put('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json().catch(() => ({})) as {
    fullResponseJson?: string
    arv?: number
    maxAllowableOffer?: number
    estimatedRepairs?: number
    historyAction?: string
    historyDescription?: string
    historyChanges?: unknown
  }
  if (body.historyAction?.startsWith('python_')) return c.json({ error: 'Reserved server history action' }, 400)

  const db = drizzle(c.env.DB)

  const [report] = await db.select({ id: savedReports.id, fullResponseJson: savedReports.fullResponseJson })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)

  // Update report data
  const updates: Record<string, unknown> = {}
  if (body.fullResponseJson !== undefined) updates.fullResponseJson = body.fullResponseJson
  if (body.arv !== undefined) updates.arv = body.arv
  if (body.maxAllowableOffer !== undefined) updates.maxAllowableOffer = body.maxAllowableOffer
  if (body.estimatedRepairs !== undefined) updates.estimatedRepairs = body.estimatedRepairs

  if (Object.keys(updates).length > 0) {
    await db.update(savedReports).set(updates).where(eq(savedReports.id, report.id))
  }

  // Log history entry
  if (body.historyAction && body.historyDescription) {
    await db.insert(reportHistory).values({
      reportId: report.id,
      userId: session.user.id,
      action: body.historyAction,
      description: body.historyDescription,
      changesJson: body.historyChanges ? JSON.stringify(body.historyChanges) : null,
    })
  }

  return c.json({ success: true })
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

// ─── GET /user/reports/:jobId/share ────────────────────────────────────────────

userReports.get('/:jobId/share', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select({
      userId: savedReports.userId,
      isShared: savedReports.isShared,
      sharePasswordHash: savedReports.sharePasswordHash,
    })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  const url = new URL(c.req.url)
  const baseUrl = url.hostname.includes('localhost')
    ? 'http://localhost:3000'
    : (c.env.DASHBOARD_URL || 'https://flowstate.homes')

  return c.json({
    isShared: report.isShared,
    hasPassword: !!report.sharePasswordHash,
    shareUrl: `${baseUrl}/report/${jobId}`,
  })
})

// ─── PUT /user/reports/:jobId/share ───────────────────────────────────────────

userReports.put('/:jobId/share', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json<{ isShared: boolean; password?: string }>()

  const db = drizzle(c.env.DB)

  const report = await db
    .select({ id: savedReports.id, userId: savedReports.userId })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  if (body.isShared && !body.password) {
    return c.json({ error: 'Password is required when sharing' }, 400)
  }

  const updateData: { isShared: boolean; sharePasswordHash: string | null } = {
    isShared: body.isShared,
    sharePasswordHash: null,
  }

  if (body.isShared && body.password) {
    updateData.sharePasswordHash = await hashSharePassword(body.password)
  }

  await db
    .update(savedReports)
    .set(updateData)
    .where(eq(savedReports.id, report.id))

  const url = new URL(c.req.url)
  const baseUrl = url.hostname.includes('localhost')
    ? 'http://localhost:3000'
    : (c.env.DASHBOARD_URL || 'https://flowstate.homes')

  return c.json({
    isShared: body.isShared,
    hasPassword: !!updateData.sharePasswordHash,
    shareUrl: `${baseUrl}/report/${jobId}`,
  })
})

// ─── DELETE /user/reports/:jobId ─────────────────────────────────────────────

userReports.delete('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select({ id: savedReports.id, userId: savedReports.userId, fullResponseJson: savedReports.fullResponseJson })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  try {
    const saved = JSON.parse(report.fullResponseJson ?? '{}')
    await deleteReportAssets(c.env, jobId, Array.isArray(saved.reportAssets) && saved.reportAssets.length > 0)
  } catch {
    return c.json({ error: 'Report cleanup incomplete. The report was retained; retry deletion.', retriable: true }, 503)
  }
  await db.delete(savedReports).where(and(eq(savedReports.id, report.id), eq(savedReports.userId, session.user.id)))

  return c.json({ success: true })
})

export default userReports
