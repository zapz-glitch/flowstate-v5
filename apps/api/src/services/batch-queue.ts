/**
 * Batch queue — FIFO across a user's batch lists.
 *
 * One list processes at a time. When a batch finishes (completed, failed,
 * or force-recovered) the oldest 'queued' batch is atomically claimed and
 * its BatchJobDO is started. The claim is guarded by `WHERE status =
 * 'queued'` so concurrent kickers can't double-start a batch.
 */

import type { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm'
import { batchJobs } from '../db/schema'

/** A 'processing' batch with no DB update this long is dead — DO crashed or was evicted. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000

async function startBatchDo(env: Env, batchId: string, userId: string, addressesJson: string): Promise<void> {
  const doId = env.BATCH_JOB.idFromName(batchId)
  const stub = env.BATCH_JOB.get(doId)
  const resp = await stub.fetch('http://internal/start', {
    method: 'POST',
    body: JSON.stringify({
      batchId,
      userId,
      addresses: JSON.parse(addressesJson) as string[],
    }),
  })
  await resp.text()
}

/** Start the oldest queued batch — no-op when the queue is empty or already claimed. */
export async function kickNextQueuedBatch(env: Env, userId: string): Promise<void> {
  try {
    const db = drizzle(env.DB)
    const [next] = await db
      .select({ id: batchJobs.id, userId: batchJobs.userId, addressesJson: batchJobs.addressesJson })
      .from(batchJobs)
      .where(and(eq(batchJobs.userId, userId), eq(batchJobs.status, 'queued')))
      .orderBy(asc(batchJobs.createdAt))
      .limit(1)
    if (!next) return

    // Atomic claim — only start the DO if this call flipped the row
    const claimed = await db
      .update(batchJobs)
      .set({ status: 'processing', updatedAt: new Date().toISOString() })
      .where(and(eq(batchJobs.id, next.id), eq(batchJobs.status, 'queued')))
      .returning({ id: batchJobs.id })
    if (claimed.length === 0) return

    await startBatchDo(env, next.id, next.userId, next.addressesJson)
  } catch (err) {
    console.warn('[batch-queue] kickNextQueuedBatch failed:', err)
  }
}

/**
 * Decide whether a new submission should queue behind existing work.
 * Fails stale 'processing' batches first; if queued batches exist but nothing
 * is actually running (a kick failed or a runner died), restarts the oldest
 * queued batch so the line keeps moving.
 * Returns true when the new batch must wait as 'queued'.
 */
export async function hasBlockingBatch(env: Env, userId: string): Promise<boolean> {
  const db = drizzle(env.DB)
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString()

  await db
    .update(batchJobs)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(batchJobs.userId, userId),
        eq(batchJobs.status, 'processing'),
        lt(batchJobs.updatedAt, staleBefore),
      ),
    )

  const active = await db
    .select({ id: batchJobs.id, status: batchJobs.status })
    .from(batchJobs)
    .where(
      and(
        eq(batchJobs.userId, userId),
        inArray(batchJobs.status, ['processing', 'queued']),
      ),
    )
    .orderBy(asc(batchJobs.createdAt))

  if (active.length === 0) return false
  if (active.some((b) => b.status === 'processing')) return true

  // All remaining rows are 'queued' with no live runner — restart the oldest
  await kickNextQueuedBatch(env, userId)
  return true
}

/**
 * Self-heal for a 'queued' batch being polled: if nothing is actually
 * running for this user, start this batch's queue. Callers should only
 * invoke this when the job they're looking at is status 'queued'.
 */
export async function repairQueueIfIdle(env: Env, userId: string): Promise<void> {
  const db = drizzle(env.DB)
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString()

  const [running] = await db
    .select({ id: batchJobs.id })
    .from(batchJobs)
    .where(
      and(
        eq(batchJobs.userId, userId),
        eq(batchJobs.status, 'processing'),
        gt(batchJobs.updatedAt, staleBefore),
      ),
    )
    .limit(1)

  if (!running) await kickNextQueuedBatch(env, userId)
}

// ─── Cron sweep — the unattended layer ───────────────────────────────────────
// Runs on a schedule (wrangler [triggers]). No human needs to have the page
// open: stale 'processing' batches get their DO nudged (which resumes the
// loop through the same path as the alarm watchdog), unrecoverable ones are
// failed so they release the FIFO queue, and stranded 'queued' batches start
// whenever their user has nothing running.

/** A 'processing' row with no DB update for this long gets its DO nudged. */
const NUDGE_STALE_MS = 4 * 60 * 1000
/** Still stale this long after nudges — DO is unrecoverable, release the queue. */
const DEAD_PROCESSING_MS = 15 * 60 * 1000

export async function sweepStaleBatches(env: Env): Promise<void> {
  const db = drizzle(env.DB)
  const rows = await db
    .select({
      id: batchJobs.id,
      userId: batchJobs.userId,
      status: batchJobs.status,
      updatedAt: batchJobs.updatedAt,
    })
    .from(batchJobs)
    .where(inArray(batchJobs.status, ['processing', 'queued']))

  const now = Date.now()
  const age = (r: { updatedAt: string }) => now - new Date(r.updatedAt).getTime()
  const nudgedUsers = new Set<string>()

  for (const row of rows) {
    if (row.status !== 'processing') continue
    if (age(row) > DEAD_PROCESSING_MS) {
      // Repeatedly nudged and never recovered — fail it so the queue moves on
      console.warn(`[batch-sweep] batch ${row.id} dead >15min — marking failed`)
      await db
        .update(batchJobs)
        .set({ status: 'failed', updatedAt: new Date(now).toISOString() })
        .where(and(eq(batchJobs.id, row.id), eq(batchJobs.status, 'processing')))
      await kickNextQueuedBatch(env, row.userId)
    } else if (age(row) > NUDGE_STALE_MS) {
      // Poke the DO — its alarm path resumes the list if the loop died
      try {
        const stub = env.BATCH_JOB.get(env.BATCH_JOB.idFromName(row.id))
        const resp = await stub.fetch('http://internal/nudge', { method: 'POST' })
        await resp.text()
        nudgedUsers.add(row.userId)
      } catch (err) {
        console.warn(`[batch-sweep] nudge failed for ${row.id}:`, err)
      }
    }
  }

  // Queued rows whose user has nothing running get the line moving again.
  // Skip users we just nudged — their runner may be resuming right now.
  const queuedUsers = new Set(rows.filter((r) => r.status === 'queued').map((r) => r.userId))
  const processingUsers = new Set(rows.filter((r) => r.status === 'processing').map((r) => r.userId))
  for (const userId of queuedUsers) {
    if (!processingUsers.has(userId) && !nudgedUsers.has(userId)) {
      await kickNextQueuedBatch(env, userId)
    }
  }
}
