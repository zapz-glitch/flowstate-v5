/**
 * Pipeline routes — the offer funnel.
 *
 * `pipelineIngress` is mounted at /pipeline on the app and guarded by
 * a dedicated shared secret (FS_EVENTS_KEY) — event emitters are the
 * Devin listener session + conversation-intelligence engine, not API
 * key holders.
 *
 * `pipelineReads` mounts under /v1 — dashboard-internal + API-key auth —
 * and serves the queue + funnel metrics.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/d1'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'
import { pipelineItems, pipelineEvents } from '../db/schema'
import { applyPipelineEvent } from '../services/pipeline'

// ─── Event ingress (agent/engine → flowstate) ────────────────────────────────

export const pipelineIngress = new Hono<{ Bindings: Env }>()

const eventSchema = z.object({
  /** funnel event type — e.g. reach_out, response, reactivated,
   *  sent_to_underwriting, underwriting_complete, offer_ready,
   *  offer_prepared, offer_sent, no_margin, declined, under_contract */
  type: z.string().min(1).max(64),
  itemId: z.string().max(200).optional(),
  leadId: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  opportunityId: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /** event timestamp (ISO); defaults to now */
  at: z.string().max(40).optional(),
})

pipelineIngress.post('/events', async (c) => {
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!c.env.FS_EVENTS_KEY || token !== c.env.FS_EVENTS_KEY) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  let body: z.infer<typeof eventSchema>
  try {
    body = eventSchema.parse(await c.req.json())
  } catch {
    return c.json({ ok: false, error: 'Invalid event body' }, 400)
  }

  const db = drizzle(c.env.DB)
  const { itemId, stage } = await applyPipelineEvent(db, body)
  return c.json({ ok: true, itemId, stage })
})

// ─── Reads (dashboard/API-key) ───────────────────────────────────────────────

export const pipelineReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

pipelineReads.get('/queue', async (c) => {
  const stage = c.req.query('stage') ?? 'give_offer'
  const db = drizzle(c.env.DB)
  const rows = await db
    .select()
    .from(pipelineItems)
    .where(eq(pipelineItems.stage, stage))
    .orderBy(pipelineItems.stageEnteredAt)
    .limit(200)
  return c.json({ ok: true, items: rows, count: rows.length })
})

pipelineReads.get('/metrics', async (c) => {
  const db = drizzle(c.env.DB)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const since = todayStart.toISOString()

  // Funnel events today
  const today = await db
    .select({ type: pipelineEvents.type, n: sql<number>`count(*)` })
    .from(pipelineEvents)
    .where(gte(pipelineEvents.at, since))
    .groupBy(pipelineEvents.type)
  const byType = Object.fromEntries(today.map((r) => [r.type, r.n]))

  // Queue depth + decisions + avg time-to-decision
  const [queueDepth] = await db
    .select({ n: sql<number>`count(*)` })
    .from(pipelineItems)
    .where(eq(pipelineItems.stage, 'give_offer'))

  const decided = await db
    .select({
      n: sql<number>`count(*)`,
      avgSeconds: sql<number>`avg(decision_seconds)`,
    })
    .from(pipelineItems)
    .where(and(eq(pipelineItems.decision, 'prep_offer'), gte(pipelineItems.decidedAt, since)))

  const reachOuts = byType['reach_out'] ?? 0
  const responses = byType['response'] ?? 0

  return c.json({
    ok: true,
    metrics: {
      date: since.slice(0, 10),
      reachOuts,
      responses,
      reachToResponseRate: reachOuts > 0 ? responses / reachOuts : null,
      reactivations: byType['reactivated'] ?? 0,
      sentToUnderwriting: byType['sent_to_underwriting'] ?? 0,
      underwritingComplete: byType['underwriting_complete'] ?? 0,
      offersPrepared: byType['offer_prepared'] ?? 0,
      offersSent: byType['offer_sent'] ?? 0,
      noMargin: byType['no_margin'] ?? 0,
      giveOfferQueueDepth: queueDepth?.n ?? 0,
      avgDecisionSeconds: decided[0]?.avgSeconds ?? null,
      decisionsToday: decided[0]?.n ?? 0,
    },
  })
})

export default pipelineReads
