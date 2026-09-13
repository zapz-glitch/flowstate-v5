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
