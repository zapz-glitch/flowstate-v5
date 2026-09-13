/**
 * User Management Routes
 *
 * Endpoints for managing user profile, API keys, and usage.
 * All routes require session authentication via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc, and, gte, sql } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { users, apiKeys, apiUsageLogs, PLAN_LIMITS } from '../db'

const user = new Hono<{ Bindings: Env }>()

// Generate secure random API key
function generateApiKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (
    'fs_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

// Hash API key for storage
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── User Profile ────────────────────────────────────────────────────────────

// GET /user - Get current user profile
user.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  const [userData] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1)

  if (!userData) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json({
    id: userData.id,
    name: userData.name,
    email: userData.email,
    emailVerified: userData.emailVerified,
    plan: userData.plan,
    role: userData.role,
    createdAt: userData.createdAt,
  })
})

// ─── API Keys ────────────────────────────────────────────────────────────────

// GET /user/api-keys - List user's API keys
user.get('/api-keys', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      currentUsage: apiKeys.currentUsage,
      monthlyQuota: apiKeys.monthlyQuota,
      quotaResetAt: apiKeys.quotaResetAt,
      isActive: apiKeys.isActive,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, session.user.id))
    .orderBy(desc(apiKeys.createdAt))

  return c.json({ keys })
})

// POST /user/api-keys - Create a new API key
user.post('/api-keys', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const name = body.name || 'API Key'

  const db = drizzle(c.env.DB)

  // Get user and check limits
  const [userData] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1)

  if (!userData) {
    return c.json({ error: 'User not found' }, 404)
  }

  const plan = (userData.plan || 'free') as keyof typeof PLAN_LIMITS
  const limits = PLAN_LIMITS[plan]

  // Check API key limit
  const existingKeys = await db.select().from(apiKeys).where(eq(apiKeys.userId, session.user.id))

  if (limits.maxApiKeys !== -1 && existingKeys.length >= limits.maxApiKeys) {
    return c.json(
      {
        error: `Maximum ${limits.maxApiKeys} API key(s) allowed on ${plan} plan`,
      },
      403
    )
  }

  // Generate and hash API key
  const rawKey = generateApiKey()
  const keyHash = await hashApiKey(rawKey)
  const keyPrefix = rawKey.slice(0, 12)

  // Calculate quota reset date (first of next month)
  const now = new Date()
  const quotaResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  // Create API key
  const [newKey] = await db
    .insert(apiKeys)
    .values({
      userId: session.user.id,
      name,
      keyHash,
      keyPrefix,
      monthlyQuota: limits.monthlyRequests === -1 ? null : limits.monthlyRequests,
      quotaResetAt: quotaResetAt.toISOString(),
    })
    .returning()

  return c.json({
    id: newKey.id,
    key: rawKey, // Only time the full key is returned
    name: newKey.name,
    keyPrefix: newKey.keyPrefix,
  })
})

// DELETE /user/api-keys/:id - Delete an API key
user.delete('/api-keys/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const keyId = c.req.param('id')
  const db = drizzle(c.env.DB)

  // Verify ownership
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1)

  if (!key || key.userId !== session.user.id) {
    return c.json({ error: 'API key not found' }, 404)
  }

  // Delete the key
  await db.delete(apiKeys).where(eq(apiKeys.id, keyId))

  return c.json({ success: true })
})

// PATCH /user/api-keys/:id - Update an API key (toggle active)
user.patch('/api-keys/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const keyId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const db = drizzle(c.env.DB)

  // Verify ownership
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1)

  if (!key || key.userId !== session.user.id) {
    return c.json({ error: 'API key not found' }, 404)
  }

  // Update the key
  const updates: Record<string, any> = {}
  if (typeof body.isActive === 'boolean') {
    updates.isActive = body.isActive
  }
  if (typeof body.name === 'string') {
    updates.name = body.name
  }

  if (Object.keys(updates).length > 0) {
    await db.update(apiKeys).set(updates).where(eq(apiKeys.id, keyId))
  }

  return c.json({ success: true })
})

// ─── Usage ───────────────────────────────────────────────────────────────────

// GET /user/usage - Get usage summary
user.get('/usage', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)

  // Get user's plan
  const [userData] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1)

  const plan = (userData?.plan || 'free') as keyof typeof PLAN_LIMITS
  const limits = PLAN_LIMITS[plan]

  // Get total usage across all keys this month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const monthlyUsage = await db
    .select({
      totalRequests: sql<number>`count(*)`,
    })
    .from(apiUsageLogs)
    .where(
      and(eq(apiUsageLogs.userId, session.user.id), gte(apiUsageLogs.createdAt, startOfMonth.toISOString()))
    )

  const totalRequests = monthlyUsage[0]?.totalRequests || 0

  // Rate-limit + error tracking for the overview dashboard
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [rl24h, rl7d, err24h, recentRateLimits] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(and(eq(apiUsageLogs.userId, session.user.id), eq(apiUsageLogs.statusCode, 429), gte(apiUsageLogs.createdAt, dayAgo))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(and(eq(apiUsageLogs.userId, session.user.id), eq(apiUsageLogs.statusCode, 429), gte(apiUsageLogs.createdAt, weekAgo))),
    db
      .select({ count: sql<number>`count(*)` })
      .from(apiUsageLogs)
      .where(and(eq(apiUsageLogs.userId, session.user.id), gte(apiUsageLogs.statusCode, 500), gte(apiUsageLogs.createdAt, dayAgo))),
    db
      .select({
        endpoint: apiUsageLogs.endpoint,
        propertyAddress: apiUsageLogs.propertyAddress,
        errorMessage: apiUsageLogs.errorMessage,
        createdAt: apiUsageLogs.createdAt,
      })
      .from(apiUsageLogs)
      .where(and(eq(apiUsageLogs.userId, session.user.id), eq(apiUsageLogs.statusCode, 429)))
      .orderBy(desc(apiUsageLogs.createdAt))
      .limit(10),
  ])

  return c.json({
    plan,
    monthlyLimit: limits.monthlyRequests,
    currentUsage: totalRequests,
    remaining: limits.monthlyRequests === -1 ? -1 : Math.max(0, limits.monthlyRequests - totalRequests),
    resetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
    rateLimit: {
      hits24h: rl24h[0]?.count ?? 0,
      hits7d: rl7d[0]?.count ?? 0,
      serverErrors24h: err24h[0]?.count ?? 0,
      recent: recentRateLimits,
    },
  })
})

// GET /user/usage/logs - Get usage logs with pagination and optional API key filter
user.get('/usage/logs', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = (page - 1) * limit
  const apiKeyId = c.req.query('apiKeyId') // Optional filter by API key

  const db = drizzle(c.env.DB)

  // Build where conditions
  const whereConditions = apiKeyId
    ? and(eq(apiUsageLogs.userId, session.user.id), eq(apiUsageLogs.apiKeyId, apiKeyId))
    : eq(apiUsageLogs.userId, session.user.id)

  // Get logs with API key info
  const logs = await db
    .select({
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
    .where(whereConditions)
    .orderBy(desc(apiUsageLogs.createdAt))
    .limit(limit)
    .offset(offset)

  // Get total count with same filter
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(apiUsageLogs)
    .where(whereConditions)

  const total = countResult[0]?.count || 0

  return c.json({
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

// GET /user/usage/logs/:id - Get single log details
user.get('/usage/logs/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const logId = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [log] = await db
    .select()
    .from(apiUsageLogs)
    .where(and(eq(apiUsageLogs.id, logId), eq(apiUsageLogs.userId, session.user.id)))
    .limit(1)

  if (!log) {
    return c.json({ error: 'Log not found' }, 404)
  }

  return c.json({ log })
})

export default user
