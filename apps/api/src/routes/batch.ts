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
import { eq, desc, inArray } from 'drizzle-orm'
import { batchJobs, savedReports } from '../db/schema'
import { generateSseToken } from '../utils/sse-token'
import { hasBlockingBatch, kickNextQueuedBatch, repairQueueIfIdle } from '../services/batch-queue'

const MAX_BATCH_ADDRESSES = 1000

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

  if (addresses.length > MAX_BATCH_ADDRESSES) {
    return c.json({ error: `Maximum ${MAX_BATCH_ADDRESSES} addresses per batch` }, 400)
  }

  const batchId = crypto.randomUUID()

  // FIFO queue — one list at a time per user. If another batch is active
  // (or ahead in the queue) this one waits as 'queued' and is kicked by
  // the batch that finishes before it.
  const db = drizzle(c.env.DB)
  const queued = await hasBlockingBatch(c.env, session.user.id)

  await db.insert(batchJobs).values({
    id: batchId,
    userId: session.user.id,
    status: queued ? 'queued' : 'processing',
    totalAddresses: addresses.length,
    addressesJson: JSON.stringify(addresses),
    resultsJson: JSON.stringify([]),
  })

  if (!queued) {
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
  }

  // Generate SSE token
  const sseSecret = c.env.BETTER_AUTH_SECRET || ''
  const token = await generateSseToken(sseSecret, batchId, session.user.id)
  const apiBaseUrl = c.req.url.replace(/\/batch\/analyze.*/, '')
  const streamUrl = `${apiBaseUrl}/sse/batch/${batchId}`

  return c.json({
    success: true,
    batchId,
    totalAddresses: addresses.length,
    queued,
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

// ─── POST /batch/:id/resume — Resume processing from a given row ──────────

batch.post('/:id/resume', async (c) => {
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

  const body = await c.req.json().catch(() => ({})) as { fromIndex?: number }
  const fromIndex = Math.max(0, Math.floor(body.fromIndex ?? 0))

  // Refuse while a run is live; stale 'processing' rows (no update for a while) are resumable
  const updatedAtMs = Date.parse(job.updatedAt ?? '') || 0
  const isStale = Date.now() - updatedAtMs > 3 * 60 * 1000
  if (job.status === 'processing' && !isStale) {
    return c.json({ error: 'Batch is already processing' }, 409)
  }
  if (job.status === 'queued') {
    return c.json({ error: 'Batch is queued — it starts automatically when the current list finishes' }, 409)
  }

  const addresses = job.addressesJson ? JSON.parse(job.addressesJson) as string[] : []
  const results = job.resultsJson ? JSON.parse(job.resultsJson) as Array<Record<string, unknown>> : []
  if (addresses.length === 0 || fromIndex >= addresses.length) {
    return c.json({ error: 'fromIndex out of range' }, 400)
  }

  await db.update(batchJobs)
    .set({ status: 'processing', updatedAt: new Date().toISOString() })
    .where(eq(batchJobs.id, batchId))

  const doId = c.env.BATCH_JOB.idFromName(batchId)
  const stub = c.env.BATCH_JOB.get(doId)
  const resp = await stub.fetch('http://internal/resume', {
    method: 'POST',
    body: JSON.stringify({
      userId: session.user.id,
      batchId,
      addresses,
      results,
      fromIndex,
    }),
  })
  await resp.text()

  if (!resp.ok) {
    await db.update(batchJobs)
      .set({ status: job.status, updatedAt: new Date().toISOString() })
      .where(eq(batchJobs.id, batchId))
    return c.json({ error: 'Failed to resume batch' }, 500)
  }

  const sseSecret = c.env.BETTER_AUTH_SECRET || ''
  const token = await generateSseToken(sseSecret, batchId, session.user.id)
  const apiBaseUrl = c.req.url.replace(/\/batch\/.*/, '')
  const streamUrl = `${apiBaseUrl}/sse/batch/${batchId}`

  return c.json({ success: true, streamUrl, token })
})

// ─── POST /batch/:id/stop — Pause processing, remaining rows stay pending ──

batch.post('/:id/stop', async (c) => {
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

  if (job.status === 'queued') {
    // Stopping a list that hasn't started = cancel it outright
    await db.update(batchJobs)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(eq(batchJobs.id, batchId))
    return c.json({ success: true })
  }
  if (job.status !== 'processing') {
    return c.json({ error: 'Batch is not processing' }, 409)
  }

  const doId = c.env.BATCH_JOB.idFromName(batchId)
  const stub = c.env.BATCH_JOB.get(doId)
  const resp = await stub.fetch('http://internal/stop', { method: 'POST' })
  await resp.text()

  if (!resp.ok) {
    // DO has no live run (evicted/crashed) — pause it directly
    await db.update(batchJobs)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(eq(batchJobs.id, batchId))
    await kickNextQueuedBatch(c.env, session.user.id)
  }

  return c.json({ success: true })
})

// ─── POST /batch/:id/cancel — Stop and mark remaining rows cancelled ───────

batch.post('/:id/cancel', async (c) => {
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

  const finalizeCancelled = async () => {
    const results = job.resultsJson
      ? (JSON.parse(job.resultsJson) as Array<{ status?: string }>)
      : []
    const next = results.map((r) =>
      r.status === 'completed' ? r : { ...r, status: 'failed', error: 'Cancelled — stopped by user' })
    await db.update(batchJobs)
      .set({
        status: 'completed',
        completedCount: next.filter((r) => r.status === 'completed').length,
        failedCount: next.filter((r) => r.status === 'failed').length,
        resultsJson: JSON.stringify(next),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(batchJobs.id, batchId))
  }

  if (job.status === 'processing') {
    const doId = c.env.BATCH_JOB.idFromName(batchId)
    const stub = c.env.BATCH_JOB.get(doId)
    const resp = await stub.fetch('http://internal/cancel', { method: 'POST' })
    await resp.text()

    if (!resp.ok) {
      // DO dead — finalize directly
      await finalizeCancelled()
      await kickNextQueuedBatch(c.env, session.user.id)
    }
    return c.json({ success: true })
  }

  // queued / paused / finished — just mark remaining rows cancelled
  await finalizeCancelled()
  return c.json({ success: true })
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

  // Detect stuck batch: processing but no updates for 3+ minutes
  const STUCK_THRESHOLD_MS = 3 * 60 * 1000
  const updatedAtMs = new Date(job.updatedAt).getTime()
  const isStuck = job.status === 'processing' && (Date.now() - updatedAtMs) > STUCK_THRESHOLD_MS

  // Self-heal a stranded queue while the user is polling a queued batch
  if (job.status === 'queued') {
    await repairQueueIfIdle(c.env, session.user.id)
  }

  const results = job.resultsJson ? JSON.parse(job.resultsJson) as Array<{ jobId?: string; feedbackStatus?: string | null }> : []

  // Join review stamps from saved_reports so the batch list shows which
  // reports have been validated / flagged already
  const jobIds = results.map((r) => r.jobId).filter((id): id is string => !!id)
  if (jobIds.length > 0) {
    const stamped = await db
      .select({ jobId: savedReports.jobId, feedbackStatus: savedReports.feedbackStatus })
      .from(savedReports)
      .where(inArray(savedReports.jobId, jobIds))
    const stampByJobId = new Map(stamped.map((s) => [s.jobId, s.feedbackStatus]))
    for (const r of results) {
      if (r.jobId) r.feedbackStatus = stampByJobId.get(r.jobId) ?? null
    }
  }

  return c.json({
    id: job.id,
    status: job.status,
    totalAddresses: job.totalAddresses,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
    results,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    isStuck,
  })
})

export default batch
