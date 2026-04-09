/**
 * Batch Analysis Route
 *
 * Session-authenticated endpoints for CSV mass address import.
 * Creates a BatchJobDO that processes addresses sequentially.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc } from 'drizzle-orm'
import { batchJobs } from '../db/schema'
import { generateSseToken } from '../utils/sse-token'

const batch = new Hono<{ Bindings: Env }>()

// ─── POST /batch/analyze — Start batch processing ──────────────────────────

batch.post('/analyze', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const body = await c.req.json<{
    addresses: string[]
    searchOptions?: { radiusMiles?: number; maxComps?: number; monthsBack?: number }
    skipCache?: boolean
  }>()

  if (!Array.isArray(body.addresses) || body.addresses.length === 0) {
    return c.json({ error: 'addresses array is required' }, 400)
  }

  // Clean and deduplicate
  const addresses = [...new Set(
    body.addresses
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
  )]

  if (addresses.length > 50) {
    return c.json({ error: 'Maximum 50 addresses per batch' }, 400)
  }

  const batchId = crypto.randomUUID()

  // Create DB record
  const db = drizzle(c.env.DB)
  await db.insert(batchJobs).values({
    id: batchId,
    userId: session.user.id,
    status: 'processing',
    totalAddresses: addresses.length,
    addressesJson: JSON.stringify(addresses),
    resultsJson: JSON.stringify([]),
  })

  // Spawn BatchJobDO
  const doId = c.env.BATCH_JOB.idFromName(batchId)
  const stub = c.env.BATCH_JOB.get(doId)
  const resp = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({
      batchId,
      userId: session.user.id,
      addresses,
      searchOptions: body.searchOptions,
      skipCache: body.skipCache,
    }),
  })
  await resp.text()

  // Generate SSE token
  const sseSecret = c.env.BETTER_AUTH_SECRET || ''
  const token = await generateSseToken(sseSecret, batchId, session.user.id)
  const apiBaseUrl = c.req.url.replace(/\/batch\/analyze.*/, '')
  const streamUrl = `${apiBaseUrl}/sse/batch/${batchId}`

  return c.json({
    success: true,
    batchId,
    totalAddresses: addresses.length,
    streamUrl,
    token,
  })
})

// ─── GET /batch — List user's batch jobs ─────────────────────────────────

batch.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  const jobs = await db.select({
    id: batchJobs.id,
    status: batchJobs.status,
    totalAddresses: batchJobs.totalAddresses,
    completedCount: batchJobs.completedCount,
    failedCount: batchJobs.failedCount,
    createdAt: batchJobs.createdAt,
  })
    .from(batchJobs)
    .where(eq(batchJobs.userId, session.user.id))
    .orderBy(desc(batchJobs.createdAt))
    .limit(20)

  return c.json({ jobs })
})

// ─── POST /batch/:id/stream-token — Get SSE token for reconnection ────────

batch.post('/:id/stream-token', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const batchId = c.req.param('id')
  const db = drizzle(c.env.DB)
  const [job] = await db.select()
    .from(batchJobs)
    .where(eq(batchJobs.id, batchId))
    .limit(1)

  if (!job || job.userId !== session.user.id) {
    return c.json({ error: 'Not found' }, 404)
  }

  const sseSecret = c.env.BETTER_AUTH_SECRET || ''
  const token = await generateSseToken(sseSecret, batchId, session.user.id)
  const apiBaseUrl = c.req.url.replace(/\/batch\/.*/, '')
  const streamUrl = `${apiBaseUrl}/sse/batch/${batchId}`

  return c.json({ streamUrl, token })
})

// ─── POST /batch/:id/retry-failed — Retry failed addresses ────────────────

batch.post('/:id/retry-failed', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const batchId = c.req.param('id')
  const db = drizzle(c.env.DB)
  const [job] = await db.select()
    .from(batchJobs)
    .where(eq(batchJobs.id, batchId))
    .limit(1)

  if (!job || job.userId !== session.user.id) {
    return c.json({ error: 'Not found' }, 404)
  }

  // Update DB status back to processing
  await db.update(batchJobs)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(batchJobs.id, batchId))

  const doId = c.env.BATCH_JOB.idFromName(batchId)
  const stub = c.env.BATCH_JOB.get(doId)
  const resp = await stub.fetch('http://internal/retry-failed', {
    method: 'POST',
    body: JSON.stringify({ userId: session.user.id }),
  })
  await resp.text()

  // Generate SSE token for streaming retry progress
  const sseSecret = c.env.BETTER_AUTH_SECRET || ''
  const token = await generateSseToken(sseSecret, batchId, session.user.id)
  const apiBaseUrl = c.req.url.replace(/\/batch\/.*/, '')
  const streamUrl = `${apiBaseUrl}/sse/batch/${batchId}`

  return c.json({ success: true, streamUrl, token })
})

// ─── GET /batch/:id — Get batch status + results ──────────────────────────

batch.get('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const batchId = c.req.param('id')
  const db = drizzle(c.env.DB)
  const [job] = await db.select()
    .from(batchJobs)
    .where(eq(batchJobs.id, batchId))
    .limit(1)

  if (!job || job.userId !== session.user.id) {
    return c.json({ error: 'Not found' }, 404)
  }

  return c.json({
    id: job.id,
    status: job.status,
    totalAddresses: job.totalAddresses,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
    results: job.resultsJson ? JSON.parse(job.resultsJson) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  })
})

export default batch
