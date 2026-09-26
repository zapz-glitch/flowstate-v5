/**
 * Offers Routes (v1) — Bearer API-key or dashboard-internal auth
 *
 * Dispatches offer workflows to the persistent Devin listener session
 * and the conversation-intelligence engine. Prep is idempotent on
 * leadId — a second dispatch returns the existing record.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

const offers = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// Persistent Devin session that listens for offer-workflow messages.
const DEVIN_SESSION_ID = 'devin-fbfcfad371534372bff22b123657c41f'
const DEVIN_MESSAGE_URL = (orgId: string) =>
  `https://api.devin.ai/v3/organizations/${orgId}/sessions/${DEVIN_SESSION_ID}/messages`
const ENGINE_OFFER_DRAFT_URL =
  'https://conversation-intelligence.weareflowstate1.workers.dev/engine/offer-draft'

const DISPATCH_TTL = 30 * 24 * 60 * 60 // 30 days
const FOLLOW = 'follow offer-prep.md in zapz-glitch/conversation-intelligence'

const prepSchema = z.object({
  // Optional — the listener agent resolves the lead in Close by address
  // when no leadId was captured at analysis time (dashboard runs).
  leadId: z.string().max(200).optional(),
  propertyAddress: z.string().min(1).max(300),
  purchasePrice: z.number().positive(),
  opportunityId: z.string().max(200).optional(),
})

async function postDevinMessage(env: Env, message: string): Promise<boolean> {
  if (!env.DEVIN_API_KEY || !env.DEVIN_ORG_ID) return false
  const resp = await fetch(DEVIN_MESSAGE_URL(env.DEVIN_ORG_ID), {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEVIN_API_KEY}`,
    },
    body: JSON.stringify({ message }),
  })
  if (!resp.ok) {
    console.error('[Offers] Devin message failed:', resp.status, await resp.text().catch(() => ''))
    return false
  }
  return true
}

offers.post('/prep', async (c) => {
  let body: z.infer<typeof prepSchema>
  try {
    body = prepSchema.parse(await c.req.json())
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400)
  }

  // Idempotency key — leadId when present, normalized address otherwise.
  const dispatchId = body.leadId
    ?? `addr:${body.propertyAddress.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const dispatchKey = `offer-dispatch:${dispatchId}`
  const existing = await c.env.API_CACHE.get(dispatchKey, 'json')
  if (existing) {
    return c.json({ ok: true, dispatched: true, idempotent: true, dispatch: existing })
  }

  // (a) Message the persistent Devin session — the listener agent does
  // the Close lookup and preps the offer.
  const message =
    `PREP OFFER: leadId=${body.leadId ?? '(resolve by address)'} propertyAddress=${body.propertyAddress} ` +
    `purchasePrice=${body.purchasePrice} opportunityId=${body.opportunityId ?? ''} — ${FOLLOW}`
  const devinSent = await postDevinMessage(c.env, message)
  if (!devinSent) {
    return c.json({ ok: false, error: 'Failed to dispatch offer prep' }, 502)
  }

  // (b) Notify the conversation-intelligence engine — fire-and-forget via
  // waitUntil so its latency never gates the response.
  if (c.env.ENGINE_API_KEY) {
    c.executionCtx.waitUntil(
      fetch(ENGINE_OFFER_DRAFT_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.ENGINE_API_KEY}`,
        },
        body: JSON.stringify({
          leadId: body.leadId ?? null,
          sessionId: DEVIN_SESSION_ID,
          address: body.propertyAddress,
        }),
      }).then((r) => {
        if (!r.ok) console.error('[Offers] engine offer-draft failed:', r.status)
      }).catch((e) => console.error('[Offers] engine offer-draft failed:', e)),
    )
  }

  const dispatch = {
    leadId: body.leadId ?? null,
    propertyAddress: body.propertyAddress,
    purchasePrice: body.purchasePrice,
    opportunityId: body.opportunityId ?? null,
    dispatchedAt: new Date().toISOString(),
  }
  await c.env.API_CACHE.put(dispatchKey, JSON.stringify(dispatch), { expirationTtl: DISPATCH_TTL })

  return c.json({ ok: true, dispatched: true })
})

const declineSchema = z
  .object({
    leadId: z.string().max(200).optional(),
    propertyAddress: z.string().max(300).optional(),
  })
  .refine((b) => b.leadId || b.propertyAddress, { message: 'leadId or propertyAddress required' })

offers.post('/decline', async (c) => {
  let body: z.infer<typeof declineSchema>
  try {
    body = declineSchema.parse(await c.req.json())
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400)
  }

  const declineId = body.leadId
    ?? `addr:${(body.propertyAddress ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  await c.env.API_CACHE.put(
    `offer-decline:${declineId}`,
    JSON.stringify({ ...body, declinedAt: new Date().toISOString() }),
    { expirationTtl: DISPATCH_TTL },
  )

  // Same listener channel — the agent's no-margin workflow. The decline
  // is recorded already; the Devin message runs via waitUntil so its
  // latency doesn't gate the response.
  const idPart = body.leadId ? `leadId=${body.leadId}` : `propertyAddress=${body.propertyAddress}`
  c.executionCtx.waitUntil(postDevinMessage(c.env, `NO MARGIN: ${idPart} — ${FOLLOW}`))

  return c.json({ ok: true })
})

export default offers
