/**
 * Offer pipeline — funnel events + live queue state.
 *
 * - pipeline_items: one row per deal, keyed by leadId or normalized
 *   address; holds the current stage + entry timestamp.
 * - pipeline_events: append-only funnel telemetry emitted by the
 *   conversation engine / Devin listener / our own API actions.
 */

import { eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import { pipelineItems, pipelineEvents } from '../db/schema'

type Db = ReturnType<typeof drizzle>

export function normalizeAddressKey(address: string): string {
  return `addr:${address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

/** Item key — leadId wins when present (stable across address variants). */
export function pipelineItemId(leadId: string | null | undefined, address: string): string {
  return leadId?.trim() || normalizeAddressKey(address)
}

export interface PipelineEventInput {
  type: string
  itemId?: string | null
  leadId?: string | null
  address?: string | null
  payload?: Record<string, unknown> | null
  at?: string | null
}

/** Stage the event implies, or null for telemetry-only events. */
const EVENT_STAGE: Record<string, string> = {
  sent_to_underwriting: 'underwriting',
  underwriting_complete: 'give_offer',
  offer_ready: 'give_offer',
  offer_prepared: 'offer_prepared',
  offer_sent: 'offer_sent',
  no_margin: 'no_margin',
  declined: 'declined',
  under_contract: 'under_contract',
}

export async function recordPipelineEvent(db: Db, input: PipelineEventInput): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(pipelineEvents).values({
    id,
    itemId: input.itemId ?? null,
    leadId: input.leadId ?? null,
    type: input.type,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    at: input.at ?? new Date().toISOString(),
  })
  return id
}

/** Upsert the item row; optionally move it to a new stage (resets entry clock). */
export async function upsertPipelineItem(
  db: Db,
  item: {
    id: string
    address: string
    stage: string
    leadId?: string | null
    opportunityId?: string | null
    jobId?: string | null
    wholesalePrice?: number | null
  },
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await db
    .select({ stage: pipelineItems.stage, stageEnteredAt: pipelineItems.stageEnteredAt })
    .from(pipelineItems)
    .where(eq(pipelineItems.id, item.id))
    .limit(1)

  if (existing.length === 0) {
    await db.insert(pipelineItems).values({
      id: item.id,
      address: item.address,
      stage: item.stage,
      stageEnteredAt: now,
      leadId: item.leadId ?? null,
      opportunityId: item.opportunityId ?? null,
      jobId: item.jobId ?? null,
      wholesalePrice: item.wholesalePrice ?? null,
      createdAt: now,
      updatedAt: now,
    })
    return
  }

  const stageChanged = existing[0].stage !== item.stage
  await db
    .update(pipelineItems)
    .set({
      stage: item.stage,
      // only reset the clock on an actual transition
      ...(stageChanged ? { stageEnteredAt: now } : {}),
      address: item.address,
      leadId: item.leadId ?? undefined,
      opportunityId: item.opportunityId ?? undefined,
      jobId: item.jobId ?? undefined,
      wholesalePrice: item.wholesalePrice ?? undefined,
      updatedAt: now,
    })
    .where(eq(pipelineItems.id, item.id))
}

/** Apply an inbound funnel event: append the event + move the item's stage. */
export async function applyPipelineEvent(
  db: Db,
  input: PipelineEventInput & { leadId?: string | null; address?: string | null },
): Promise<{ itemId: string | null; stage: string | null }> {
  const itemId = input.itemId
    ?? (input.address ? pipelineItemId(input.leadId, input.address) : input.leadId ?? null)
  await recordPipelineEvent(db, { ...input, itemId })

  const stage = EVENT_STAGE[input.type] ?? null
  if (itemId && stage) {
    await upsertPipelineItem(db, {
      id: itemId,
      address: input.address ?? '(unknown)',
      stage,
      leadId: input.leadId,
    })
  }
  return { itemId, stage }
}

/**
 * Underwriting complete → auto-queue into give_offer.
 * Called from the DO after the report persists — best-effort, never throws.
 */
export async function enqueueGiveOffer(
  db: Db,
  item: {
    address: string
    leadId?: string | null
    opportunityId?: string | null
    jobId?: string | null
    wholesalePrice?: number | null
  },
): Promise<void> {
  const id = pipelineItemId(item.leadId, item.address)
  await upsertPipelineItem(db, { id, stage: 'give_offer', ...item })
  await recordPipelineEvent(db, {
    type: 'underwriting_complete',
    itemId: id,
    leadId: item.leadId,
    payload: { jobId: item.jobId, wholesalePrice: item.wholesalePrice },
  })
}

/** Record the user's Give Offer decision + move the item on. */
export async function recordPipelineDecision(
  db: Db,
  itemId: string,
  decision: 'prep_offer' | 'no_margin',
  address: string,
): Promise<void> {
  const now = new Date().toISOString()
  const nextStage = decision === 'prep_offer' ? 'offer_prepared' : 'no_margin'
  const existing = await db
    .select({ stageEnteredAt: pipelineItems.stageEnteredAt })
    .from(pipelineItems)
    .where(eq(pipelineItems.id, itemId))
    .limit(1)

  let decisionSeconds: number | null = null
  if (existing[0]?.stageEnteredAt) {
    decisionSeconds = Math.max(
      0,
      Math.round((Date.parse(now) - Date.parse(existing[0].stageEnteredAt)) / 1000),
    )
  }

  await upsertPipelineItem(db, { id: itemId, address, stage: nextStage })
  await db
    .update(pipelineItems)
    .set({ decidedAt: now, decision, decisionSeconds, updatedAt: now })
    .where(eq(pipelineItems.id, itemId))
  await recordPipelineEvent(db, {
    type: nextStage,
    itemId,
    payload: { decisionSeconds },
  })
}
