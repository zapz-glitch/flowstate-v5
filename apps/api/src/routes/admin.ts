/**
 * Admin Routes
 *
 * Endpoints for managing users, plans, quotas, and viewing platform-wide usage.
 * All routes require session authentication + admin role.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc, and, gte, sql, like, or } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { users, apiKeys, apiUsageLogs, subscriptions, savedReports, analysisRuns, PLAN_LIMITS } from '../db'
import type { Plan } from '../db/schema'

const admin = new Hono<{ Bindings: Env }>()

// Helper to get session and verify admin role
async function getAdminSession(c: any) {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)

  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session?.user) return null

    // Check admin role
    const db = drizzle(c.env.DB)
    const [userData] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1)
    if (!userData || userData.role !== 'admin') return null

    return { session, user: userData }
  } catch {
    return null
  }
}

// ─── Dashboard Overview ──────────────────────────────────────────────────────

// GET /admin/stats - Platform overview stats
admin.get('/stats', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  // 3 parallel queries (plan breakdown gives us total users too — no need for a separate count)
  const [
    planBreakdownResult,
    monthlyRequestsResult,
    totalReportsResult,
  ] = await Promise.all([
    db.select({
      plan: users.plan,
      count: sql<number>`count(*)`,
    }).from(users).groupBy(users.plan),
    db.select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(gte(apiUsageLogs.createdAt, startOfMonth.toISOString())),
    db.select({ count: sql<number>`count(*)` }).from(savedReports),
  ])

  const planBreakdown: Record<string, number> = {}
  let totalUsers = 0
  for (const row of planBreakdownResult) {
    planBreakdown[row.plan] = row.count
    totalUsers += row.count
  }

  return c.json({
    totalUsers,
    planBreakdown,
    monthlyRequests: monthlyRequestsResult[0]?.count || 0,
    totalReports: totalReportsResult[0]?.count || 0,
  })
})

// ─── User Management ─────────────────────────────────────────────────────────

// GET /admin/users - List all users with pagination and search
admin.get('/users', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = (page - 1) * limit
  const search = c.req.query('search')
  const planFilter = c.req.query('plan')

  // Build where conditions
  const conditions = []
  if (search) {
    conditions.push(
      or(
        like(users.name, `%${search}%`),
        like(users.email, `%${search}%`)
      )
    )
  }
  if (planFilter) {
    conditions.push(eq(users.plan, planFilter))
  }

  const whereClause = conditions.length > 0
    ? conditions.length === 1 ? conditions[0] : and(...conditions)
    : undefined

  const [userList, countResult] = await Promise.all([
    db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      plan: users.plan,
      role: users.role,
      createdAt: users.createdAt,
    })
      .from(users)
      .where(whereClause)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` })
      .from(users)
      .where(whereClause),
  ])

  return c.json({
    users: userList,
    pagination: {
      page,
      limit,
      total: countResult[0]?.count || 0,
      totalPages: Math.ceil((countResult[0]?.count || 0) / limit),
    },
  })
})

// GET /admin/users/:id - Get user detail with keys, usage, subscription
admin.get('/users/:id', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [userData] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!userData) return c.json({ error: 'User not found' }, 404)

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [keys, monthlyUsage, sub, reportsCount] = await Promise.all([
    db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      currentUsage: apiKeys.currentUsage,
      monthlyQuota: apiKeys.monthlyQuota,
      quotaResetAt: apiKeys.quotaResetAt,
      isActive: apiKeys.isActive,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt)),

    db.select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(and(
        eq(apiUsageLogs.userId, userId),
        gte(apiUsageLogs.createdAt, startOfMonth.toISOString())
      )),

    db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),

    db.select({ count: sql<number>`count(*)` })
      .from(savedReports)
      .where(eq(savedReports.userId, userId)),
  ])

  const plan = (userData.plan || 'free') as Plan
  const limits = PLAN_LIMITS[plan]

  return c.json({
    user: {
      id: userData.id,
      name: userData.name,
      email: userData.email,
      emailVerified: userData.emailVerified,
      plan: userData.plan,
      role: userData.role,
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
    },
    apiKeys: keys,
    usage: {
      monthlyRequests: monthlyUsage[0]?.count || 0,
      monthlyLimit: limits.monthlyRequests,
      remaining: limits.monthlyRequests === -1
        ? -1
        : Math.max(0, limits.monthlyRequests - (monthlyUsage[0]?.count || 0)),
    },
    subscription: sub[0] || null,
    totalReports: reportsCount[0]?.count || 0,
  })
})

// PATCH /admin/users/:id - Update user plan, role, or other fields
admin.patch('/users/:id', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const db = drizzle(c.env.DB)

  const [userData] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!userData) return c.json({ error: 'User not found' }, 404)

  const updates: Record<string, any> = {}

  // Update plan
  if (body.plan && ['free', 'pro', 'enterprise'].includes(body.plan)) {
    updates.plan = body.plan
  }

  // Update role
  if (body.role && ['user', 'admin'].includes(body.role)) {
    // Prevent removing own admin role
    if (userId === adminSession.user.id && body.role !== 'admin') {
      return c.json({ error: 'Cannot remove your own admin role' }, 400)
    }
    updates.role = body.role
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  updates.updatedAt = new Date().toISOString()

  await db.update(users).set(updates).where(eq(users.id, userId))

  // If plan changed, update quota on all active API keys
  if (updates.plan) {
    const newPlan = updates.plan as Plan
    const newLimits = PLAN_LIMITS[newPlan]
    const newQuota = newLimits.monthlyRequests === -1 ? null : newLimits.monthlyRequests

    await db.update(apiKeys)
      .set({ monthlyQuota: newQuota })
      .where(eq(apiKeys.userId, userId))
  }

  return c.json({ success: true })
})

// ─── User Usage ──────────────────────────────────────────────────────────────

// GET /admin/users/:id/usage - Get user's API usage logs
admin.get('/users/:id/usage', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('id')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = (page - 1) * limit

  const db = drizzle(c.env.DB)

  const [logs, countResult] = await Promise.all([
    db.select({
      id: apiUsageLogs.id,
      apiKeyId: apiUsageLogs.apiKeyId,
      endpoint: apiUsageLogs.endpoint,
      method: apiUsageLogs.method,
      statusCode: apiUsageLogs.statusCode,
      responseTimeMs: apiUsageLogs.responseTimeMs,
      propertyAddress: apiUsageLogs.propertyAddress,
      propertyCity: apiUsageLogs.propertyCity,
      propertyState: apiUsageLogs.propertyState,
      createdAt: apiUsageLogs.createdAt,
    })
      .from(apiUsageLogs)
      .where(eq(apiUsageLogs.userId, userId))
      .orderBy(desc(apiUsageLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(eq(apiUsageLogs.userId, userId)),
  ])

  return c.json({
    logs,
    pagination: {
      page,
      limit,
      total: countResult[0]?.count || 0,
      totalPages: Math.ceil((countResult[0]?.count || 0) / limit),
    },
  })
})

// ─── API Key Management ──────────────────────────────────────────────────────

// PATCH /admin/users/:id/api-keys/:keyId - Update a user's API key quota
admin.patch('/users/:id/api-keys/:keyId', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('id')
  const keyId = c.req.param('keyId')
  const body = await c.req.json().catch(() => ({}))
  const db = drizzle(c.env.DB)

  const [key] = await db.select().from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .limit(1)

  if (!key) return c.json({ error: 'API key not found' }, 404)

  const updates: Record<string, any> = {}

  if (typeof body.monthlyQuota === 'number') {
    updates.monthlyQuota = body.monthlyQuota
  }
  if (typeof body.isActive === 'boolean') {
    updates.isActive = body.isActive
  }
  if (typeof body.currentUsage === 'number') {
    updates.currentUsage = body.currentUsage
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400)
  }

  await db.update(apiKeys).set(updates).where(eq(apiKeys.id, keyId))

  return c.json({ success: true })
})

// ─── Platform Usage ──────────────────────────────────────────────────────────

// GET /admin/usage/daily - Get daily usage stats for the last 30 days
admin.get('/usage/daily', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const daily = await db.select({
    date: sql<string>`date(${apiUsageLogs.createdAt})`.as('date'),
    count: sql<number>`count(*)`.as('count'),
    uniqueUsers: sql<number>`count(distinct ${apiUsageLogs.userId})`.as('unique_users'),
  })
    .from(apiUsageLogs)
    .where(gte(apiUsageLogs.createdAt, thirtyDaysAgo.toISOString()))
    .groupBy(sql`date(${apiUsageLogs.createdAt})`)
    .orderBy(sql`date(${apiUsageLogs.createdAt})`)

  return c.json({ daily })
})

// ─── Impersonation ──────────────────────────────────────────────────────────

// POST /admin/impersonate/:id - Start impersonating a user (returns user info for client storage)
admin.post('/impersonate/:id', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const targetUserId = c.req.param('id')
  const db = drizzle(c.env.DB)

  // Cannot impersonate yourself
  if (targetUserId === adminSession.user.id) {
    return c.json({ error: 'Cannot impersonate yourself' }, 400)
  }

  const [targetUser] = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    plan: users.plan,
    role: users.role,
  }).from(users).where(eq(users.id, targetUserId)).limit(1)

  if (!targetUser) return c.json({ error: 'User not found' }, 404)

  console.log(`Admin ${adminSession.user.email} started impersonating ${targetUser.email}`)

  return c.json({
    success: true,
    impersonating: targetUser,
    admin: {
      id: adminSession.user.id,
      name: adminSession.user.name,
      email: adminSession.user.email,
    },
  })
})

export default admin

// ─── Observability ──────────────────────────────────────────────────────────

interface RunEvalShape { grade: 'pass' | 'warn' | 'fail'; passed: number; warned: number; failed: number; checks: unknown[] }

const parseEval = (json: string | null): RunEvalShape | null => {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

// GET /admin/observability/summary - aggregate system evidence
admin.get('/observability/summary', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)
  const runs = await db.select({
    status: analysisRuns.status,
    errorCode: analysisRuns.errorCode,
    durationMs: analysisRuns.durationMs,
    renovationLevelSource: analysisRuns.renovationLevelSource,
    visionStatus: analysisRuns.visionStatus,
    photoProvider: analysisRuns.photoProvider,
    photoCount: analysisRuns.photoCount,
    evalJson: analysisRuns.evalJson,
    fallbacksJson: analysisRuns.fallbacksJson,
  }).from(analysisRuns).orderBy(desc(analysisRuns.createdAt)).limit(500)

  const total = runs.length
  const completed = runs.filter((r) => r.status === 'completed')
  const grades = { pass: 0, warn: 0, fail: 0 }
  const fallbackCounts: Record<string, number> = {}
  const providerCounts: Record<string, number> = {}
  const errorCounts: Record<string, number> = {}
  let visionVerified = 0, visionNA = 0, durationSum = 0, durationN = 0

  for (const r of runs) {
    const ev = parseEval(r.evalJson)
    if (ev) grades[ev.grade]++
    for (const f of (r.fallbacksJson ? JSON.parse(r.fallbacksJson) : []) as string[]) {
      fallbackCounts[f] = (fallbackCounts[f] ?? 0) + 1
    }
    if (r.photoProvider) providerCounts[r.photoProvider] = (providerCounts[r.photoProvider] ?? 0) + 1
    if (r.errorCode) errorCounts[r.errorCode] = (errorCounts[r.errorCode] ?? 0) + 1
    if (r.renovationLevelSource === 'vision') visionVerified++
    else if (r.visionStatus && r.visionStatus !== 'ok') visionNA++
    if (r.durationMs) { durationSum += r.durationMs; durationN++ }
  }

  const topFallbacks = Object.entries(fallbackCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([code, count]) => ({ code, count }))
  const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([code, count]) => ({ code, count }))

  return c.json({
    total,
    completed: completed.length,
    failed: total - completed.length,
    successRate: total ? Math.round((completed.length / total) * 100) : 0,
    benchmark: grades,
    benchmarkRate: total ? Math.round((grades.pass / total) * 100) : 0,
    avgDurationMs: durationN ? Math.round(durationSum / durationN) : null,
    visionVerifiedRate: total ? Math.round((visionVerified / total) * 100) : 0,
    visionNaRate: total ? Math.round((visionNA / total) * 100) : 0,
    topFallbacks,
    topErrors,
    providers: providerCounts,
  })
})

// GET /admin/observability/runs - recent runs with eval grades
admin.get('/observability/runs', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)

  const runs = await db.select().from(analysisRuns)
    .orderBy(desc(analysisRuns.createdAt)).limit(limit)

  return c.json({
    runs: runs.map((r) => ({
      jobId: r.jobId,
      address: [r.propertyAddress, r.propertyCity, r.propertyState].filter(Boolean).join(', '),
      status: r.status,
      grade: parseEval(r.evalJson)?.grade ?? null,
      arv: r.arv,
      recommendation: r.recommendation,
      compCount: r.compCount,
      enabledCompCount: r.enabledCompCount,
      errorCode: r.errorCode,
      durationMs: r.durationMs,
      renovationLevelSource: r.renovationLevelSource,
      visionStatus: r.visionStatus,
      photoProvider: r.photoProvider,
      createdAt: r.createdAt,
    })),
  })
})

// GET /admin/observability/runs/:jobId - full trace + eval checks for one run
admin.get('/observability/runs/:jobId', async (c) => {
  const adminSession = await getAdminSession(c)
  if (!adminSession) return c.json({ error: 'Unauthorized' }, 403)

  const db = drizzle(c.env.DB)
  const jobId = c.req.param('jobId')

  const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.jobId, jobId)).limit(1)
  if (!run) return c.json({ error: 'Run not found' }, 404)

  // Join the saved report for the full step trace + response evidence
  const [report] = await db.select({
    id: savedReports.id,
    fullResponseJson: savedReports.fullResponseJson,
  }).from(savedReports).where(eq(savedReports.jobId, jobId)).limit(1)

  let reportSteps: unknown[] = []
  let responseSummary: Record<string, unknown> | null = null
  if (report?.fullResponseJson) {
    try {
      const resp = JSON.parse(report.fullResponseJson)
      reportSteps = resp?.report?.steps ?? []
      const comps = resp?.comps?.items ?? []
      responseSummary = {
        valuation: resp?.valuation ?? null,
        visionAssessment: resp?.visionAssessment ?? null,
        photoProvider: resp?.photoProvider ?? null,
        renovationLevelSource: resp?.renovationLevelSource ?? null,
        subject: resp?.subject ? {
          address: resp.subject.address,
          foundationType: resp.subject.foundationType,
          condition: resp.subject.condition,
          curbAppeal: resp.subject.curbAppeal,
          listingUrl: resp.subject.listingUrl,
          permits: resp.subject.permits,
          photoCount: resp.subject.photos?.length ?? 0,
        } : null,
        comps: comps.map((cmp: Record<string, unknown>) => ({
          id: cmp.id,
          address: cmp.address,
          salePrice: cmp.salePrice,
          compGroup: cmp.compGroup,
          isEnabled: cmp.isEnabled,
          curbAppeal: cmp.curbAppeal,
          foundationType: cmp.foundationType,
          passedFilters: (cmp.appraisalRules as { passedFilters?: boolean })?.passedFilters ?? null,
        })),
        fallbacksUsed: resp?.report?.fallbacksUsed ?? [],
        apiCallStats: resp?.apiCallStats ?? null,
      }
    } catch { /* fall through with steps only */ }
  }

  return c.json({
    run: {
      ...run,
      eval: parseEval(run.evalJson),
      steps: run.stepsJson ? JSON.parse(run.stepsJson) : reportSteps,
      fallbacks: run.fallbacksJson ? JSON.parse(run.fallbacksJson) : [],
    },
    reportId: report?.id ?? null,
    responseSummary,
  })
})
