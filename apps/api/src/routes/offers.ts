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
const ENGINE_BASE = 'https://conversation-intelligence.weareflowstate1.workers.dev'
const ENGINE_OFFER_DRAFT_URL = `${ENGINE_BASE}/engine/offer-draft`
const ENGINE_NO_OFFER_URL = `${ENGINE_BASE}/engine/no-offer`

/** Notify the engine that a flowstate analyze job hit a terminal state —
 * it pulls the result from /v1/analyze/jobs/{jobId} itself. Fire-and-forget. */
export async function notifyEvalComplete(env: Env, jobId: string): Promise<void> {
  if (!env.ENGINE_API_KEY) return
  const resp = await fetch(`${ENGINE_BASE}/engine/eval/complete`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ENGINE_API_KEY}`,
    },
    body: JSON.stringify({ jobId }),
  }).catch((e) => {
    console.error('[Offers] engine eval/complete failed:', e)
    return null
  })
  // 404 = job not engine-initiated — expected for dashboard-run analyses.
  if (resp && !resp.ok && resp.status !== 404) {
    console.error('[Offers] engine eval/complete failed:', resp.status)
  }
}

const DISPATCH_TTL = 30 * 24 * 60 * 60 // 30 days
const FOLLOW = 'follow offer-prep.md in zapz-glitch/conversation-intelligence'

const prepSchema = z.object({
  // Optional — the listener agent resolves the lead in Close by address
  // when no leadId was captured at analysis time (dashboard runs).
  leadId: z.string().max(200).optional(),
  propertyAddress: z.string().min(1).max(300),
  purchasePrice: z.number().positive(),
  opportunityId: z.string().max(200).optional(),
  jobId: z.string().max(200).optional(),
})

/** Upsert the disposition row — latest attempt wins. A re-dispatch
 *  overwrites workflow/date, so the dashboard always shows the current
 *  disposition and when it last happened. */
async function recordDisposition(
  env: Env,
  d: {
    key: string
    leadId: string | null
    address: string | null
    jobId?: string | null
    workflow: 'prep_offer' | 'no_margin' | 'no_offer'
    ok: boolean
    purchasePrice?: number | null
    opportunityId?: string | null
  },
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO offer_dispositions
       (disposition_key, lead_id, property_address, job_id, workflow, ok, purchase_price, opportunity_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(disposition_key) DO UPDATE SET
       lead_id = COALESCE(excluded.lead_id, offer_dispositions.lead_id),
       property_address = COALESCE(excluded.property_address, offer_dispositions.property_address),
       job_id = COALESCE(excluded.job_id, offer_dispositions.job_id),
       workflow = excluded.workflow,
       ok = excluded.ok,
       purchase_price = COALESCE(excluded.purchase_price, offer_dispositions.purchase_price),
       opportunity_id = COALESCE(excluded.opportunity_id, offer_dispositions.opportunity_id),
       updated_at = excluded.updated_at`,
  )
    .bind(
      d.key, d.leadId, d.address, d.jobId ?? null, d.workflow, d.ok ? 1 : 0,
      d.purchasePrice ?? null, d.opportunityId ?? null, now, now,
    )
    .run()
    .catch((e) => console.error('[Offers] disposition write failed:', e))
}

/** Resolve a Close lead id by address — the engine requires leadId. */
async function resolveLeadId(env: Env, address: string): Promise<string | null> {
  if (!env.CLOSE_API_KEY) return null
  const street = (address.split(',')[0] ?? address).trim()
  if (!street) return null
  try {
    const resp = await fetch(
      `https://api.close.com/api/v1/lead/?query=${encodeURIComponent(street)}`,
      {
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${btoa(`${env.CLOSE_API_KEY}:`)}` },
      },
    )
    if (!resp.ok) {
      console.error('[Offers] Close lead lookup failed:', resp.status)
      return null
    }
    const data = (await resp.json()) as {
      data?: Array<{
        id?: string
        display_name?: string
        addresses?: Array<{ address_1?: string }>
      }>
    }
    const leads = data?.data ?? []
    if (leads.length === 0) return null
    if (leads.length === 1 && leads[0].id) return leads[0].id
    // Multiple candidates — pick the one whose street line matches. The
    // query endpoint doesn't expand addresses, so display_name (the street
    // for list-uploaded leads) is the reliable discriminator.
    const num = street.split(/\s+/)[0]
    const match = leads.find((l) =>
      (l.display_name ?? '').includes(num) ||
      (l.addresses ?? []).some((a) => (a.address_1 ?? '').includes(num)),
    )
    return match?.id ?? null
  } catch (e) {
    console.error('[Offers] Close lead lookup failed:', e)
    return null
  }
}

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

  // Resolve the Close lead when the caller didn't pass one — the engine
  // requires leadId and the idempotency key is more stable on it.
  const leadId = body.leadId ?? (await resolveLeadId(c.env, body.propertyAddress))

  // Idempotency key — leadId when resolvable, normalized address otherwise.
  const dispatchId = leadId
    ?? `addr:${body.propertyAddress.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const dispatchKey = `offer-dispatch:${dispatchId}`
  const existing = await c.env.API_CACHE.get(dispatchKey, 'json')
  if (existing) {
    return c.json({ ok: true, dispatched: true, idempotent: true, dispatch: existing })
  }

  // (a) Message the persistent Devin session — the listener agent does
  // the Close lookup and preps the offer.
  const message =
    `PREP OFFER: leadId=${leadId ?? '(resolve by address)'} propertyAddress=${body.propertyAddress} ` +
    `purchasePrice=${body.purchasePrice} opportunityId=${body.opportunityId ?? ''} — ${FOLLOW}`
  const devinSent = await postDevinMessage(c.env, message)
  if (!devinSent) {
    c.executionCtx.waitUntil(
      recordDisposition(c.env, {
        key: dispatchId, leadId, address: body.propertyAddress, jobId: body.jobId,
        workflow: 'prep_offer', ok: false, purchasePrice: body.purchasePrice, opportunityId: body.opportunityId,
      }),
    )
    return c.json({ ok: false, error: 'Failed to dispatch offer prep' }, 502)
  }
  c.executionCtx.waitUntil(
    recordDisposition(c.env, {
      key: dispatchId, leadId, address: body.propertyAddress, jobId: body.jobId,
      workflow: 'prep_offer', ok: true, purchasePrice: body.purchasePrice, opportunityId: body.opportunityId,
    }),
  )

  // (b) Notify the conversation-intelligence engine — fire-and-forget via
  // waitUntil so its latency never gates the response. The engine requires
  // leadId; when none resolves the listener carries the flow alone.
  if (c.env.ENGINE_API_KEY && leadId) {
    c.executionCtx.waitUntil(
      fetch(ENGINE_OFFER_DRAFT_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.ENGINE_API_KEY}`,
        },
        body: JSON.stringify({
          leadId,
          sessionId: DEVIN_SESSION_ID,
          address: body.propertyAddress,
          wholesalePrice: body.purchasePrice,
          status: 'pending',
        }),
      }).then((r) => {
        if (!r.ok) console.error('[Offers] engine offer-draft failed:', r.status)
      }).catch((e) => console.error('[Offers] engine offer-draft failed:', e)),
    )
  }

  const dispatch = {
    leadId: leadId ?? null,
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
    jobId: z.string().max(200).optional(),
    workflow: z.enum(['no_margin', 'no_offer']).default('no_margin'),
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
    ?? (await resolveLeadId(c.env, body.propertyAddress ?? ''))
    ?? `addr:${(body.propertyAddress ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  await c.env.API_CACHE.put(
    `offer-decline:${declineId}`,
    JSON.stringify({ ...body, declinedAt: new Date().toISOString() }),
    { expirationTtl: DISPATCH_TTL },
  )
  const leadId = declineId.startsWith('lead_') ? declineId : null

  // no_offer goes straight to the engine — it owns the stage move. When no
  // leadId resolves or the engine call fails, the listener message remains
  // the fallback channel.
  let engineHandled = false
  if (body.workflow === 'no_offer' && leadId && c.env.ENGINE_API_KEY) {
    const resp = await fetch(ENGINE_NO_OFFER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.env.ENGINE_API_KEY}`,
      },
      body: JSON.stringify({ leadId, address: body.propertyAddress ?? null }),
    }).catch(() => null)
    engineHandled = !!resp?.ok
    if (!engineHandled) console.error('[Offers] engine no-offer failed:', resp?.status)
  }

  c.executionCtx.waitUntil(
    recordDisposition(c.env, {
      key: declineId, leadId, address: body.propertyAddress ?? null, jobId: body.jobId,
      workflow: body.workflow,
      ok: body.workflow !== 'no_offer' || engineHandled || !c.env.ENGINE_API_KEY,
    }),
  )

  // If a pending offer draft exists for the lead, resolve it as declined —
  // fire-and-forget; the engine no-ops when there's no draft.
  if (c.env.ENGINE_API_KEY && leadId) {
    c.executionCtx.waitUntil(
      fetch(ENGINE_OFFER_DRAFT_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.ENGINE_API_KEY}`,
        },
        body: JSON.stringify({ leadId, sessionId: DEVIN_SESSION_ID, status: 'declined' }),
      }).catch((e) => console.error('[Offers] engine decline-draft failed:', e)),
    )
  }

  // Stage move + cleanup go through the listener session — exact format
  // the engine has already processed live.
  // Listener message — the no_margin channel, and the no_offer fallback
  // when the engine endpoint couldn't take it (no leadId / call failed).
  if (body.workflow !== 'no_offer' || !engineHandled) {
    const idPart = leadId ? `leadId=${leadId}` : `leadId=`
    const stage = body.workflow === 'no_offer' ? 'No offer' : 'No margin'
    const verb = body.workflow === 'no_offer' ? 'NO OFFER' : 'NO MARGIN'
    c.executionCtx.waitUntil(
      postDevinMessage(c.env, `${verb}: ${idPart} address=${body.propertyAddress ?? ''} — move to ${stage}`),
    )
  }

  if (body.workflow === 'no_offer' && !engineHandled && leadId && c.env.ENGINE_API_KEY) {
    return c.json({ ok: false, error: 'Engine no-offer failed — listener fallback dispatched' }, 502)
  }
  return c.json({ ok: true })
})

/** Disposition history — the dispatch/decline markers written by /prep and
 *  /decline. Powers the Offers dashboard categories durably (survives
 *  sessions/devices), not just the browser's session log. */
offers.get('/history', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT lead_id, property_address, job_id, workflow, ok, updated_at
       FROM offer_dispositions ORDER BY updated_at DESC LIMIT 500`,
  ).all<{
    lead_id: string | null
    property_address: string | null
    job_id: string | null
    workflow: string
    ok: number
    updated_at: string
  }>()
  const dispositions = results.map((r) => ({
    leadId: r.lead_id,
    propertyAddress: r.property_address,
    jobId: r.job_id,
    workflow: r.workflow,
    ok: r.ok === 1,
    at: r.updated_at,
  }))
  return c.json({ ok: true, dispositions })
})

export default offers
