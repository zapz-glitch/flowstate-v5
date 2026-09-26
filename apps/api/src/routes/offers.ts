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
  leadId: z.string().min(1).max(200),
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

  const dispatchKey = `offer-dispatch:${body.leadId}`
  const existing = await c.env.API_CACHE.get(dispatchKey, 'json')
  if (existing) {
    return c.json({ ok: true, dispatched: true, idempotent: true, dispatch: existing })
  }

  // (a) Message the persistent Devin session — the listener agent does
  // the Close lookup and preps the offer.
  const message =
    `PREP OFFER: leadId=${body.leadId} propertyAddress=${body.propertyAddress} ` +
    `purchasePrice=${body.purchasePrice} opportunityId=${body.opportunityId ?? ''} — ${FOLLOW}`
  const devinSent = await postDevinMessage(c.env, message)
  if (!devinSent) {
    return c.json({ ok: false, error: 'Failed to dispatch offer prep' }, 502)
  }

  // (b) Notify the conversation-intelligence engine. Non-fatal — the
  // Devin listener is the primary channel.
  let engineSent = false
  if (c.env.ENGINE_API_KEY) {
    const resp = await fetch(ENGINE_OFFER_DRAFT_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.env.ENGINE_API_KEY}`,
      },
      body: JSON.stringify({
        leadId: body.leadId,
        sessionId: DEVIN_SESSION_ID,
        address: body.propertyAddress,
      }),
    }).catch(() => null)
    engineSent = resp?.ok ?? false
    if (!engineSent) console.error('[Offers] engine offer-draft failed:', resp?.status)
  }

  const dispatch = {
    leadId: body.leadId,
    propertyAddress: body.propertyAddress,
    purchasePrice: body.purchasePrice,
    opportunityId: body.opportunityId ?? null,
    dispatchedAt: new Date().toISOString(),
  }
  await c.env.API_CACHE.put(dispatchKey, JSON.stringify(dispatch), { expirationTtl: DISPATCH_TTL })

  return c.json({ ok: true, dispatched: true, engine: engineSent })
})

const declineSchema = z.object({ leadId: z.string().min(1).max(200) })

offers.post('/decline', async (c) => {
  let body: z.infer<typeof declineSchema>
  try {
    body = declineSchema.parse(await c.req.json())
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400)
  }

  await c.env.API_CACHE.put(
    `offer-decline:${body.leadId}`,
    JSON.stringify({ leadId: body.leadId, declinedAt: new Date().toISOString() }),
    { expirationTtl: DISPATCH_TTL },
  )

  // Same listener channel — the agent's no-margin workflow.
  await postDevinMessage(c.env, `NO MARGIN: leadId=${body.leadId} — ${FOLLOW}`)

  return c.json({ ok: true })
})

export default offers
