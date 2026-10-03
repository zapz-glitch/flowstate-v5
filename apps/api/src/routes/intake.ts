/**
 * POST /v1/intake — public-form lead intake.
 *
 * A site form (e.g. insights.flowstate.homes) posts the submitted property
 * here instead of calling /v1/analyze directly. We create the Close lead
 * + pipeline opportunity, then hand the lead to the conversation-intelligence
 * engine via /engine/eval/request — the engine dispatches the eval, and on
 * completion moves the opportunity to "Presenting Offer", which is what the
 * give-offer "waiting" list reads. No outreach is performed by this route.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

const CLOSE_BASE = 'https://api.close.com/api/v1'
const ENGINE_BASE = 'https://conversation-intelligence.weareflowstate1.workers.dev'

// On Market Listings/Referrals pipeline in Close — matches the
// conversation-intelligence engine's constants.
const PIPELINE_ID = 'pipe_5EDAjFNKpkPa80syNca20v'
const READY_TO_UNDERWRITE_STATUS = 'stat_c1EvgKxehXIwQGW9N30XRa3dqVkS97Q8SwkYcQB162D'

const intakeSchema = z.object({
  // Engine requires a full address incl. ZIP — validated there too.
  propertyAddress: z.string().min(10).max(300),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().max(200).optional(),
  source: z.string().max(100).optional(),
})

async function closeFetch(env: Env, path: string, init?: RequestInit): Promise<Response | null> {
  if (!env.CLOSE_API_KEY) return null
  return fetch(`${CLOSE_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(12000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${env.CLOSE_API_KEY}:`)}`,
      ...(init?.headers ?? {}),
    },
  }).catch((e) => {
    console.error('[Intake] Close request failed:', path, e)
    return null
  })
}

/** Close custom field ids are dynamic — resolve "Property Address" once per call. */
async function propertyAddressFieldId(env: Env): Promise<string | null> {
  const resp = await closeFetch(env, '/custom_field/lead/?query=Property%20Address&_limit=20')
  if (!resp?.ok) return null
  const data = (await resp.json()) as { data?: Array<{ id: string; name: string }> }
  return data.data?.find((f) => f.name === 'Property Address')?.id ?? null
}

/** Dedupe — an existing lead at this address gets reused, not duplicated. */
async function findLeadByAddress(env: Env, address: string): Promise<{ id: string } | null> {
  const street = (address.split(',')[0] ?? address).trim()
  if (!street) return null
  const resp = await closeFetch(env, `/lead/?query=${encodeURIComponent(street)}&_limit=10`)
  if (!resp?.ok) return null
  const data = (await resp.json()) as {
    data?: Array<{ id: string; display_name?: string; custom?: Record<string, unknown> }>
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const want = norm(street)
  return (
    data.data?.find((l) => norm(String(l.custom?.['Property Address'] ?? l.display_name ?? '')).includes(want))
    ?? null
  )
}

export interface IntakeResult {
  ok: boolean
  error?: string
  leadId?: string
  opportunityId?: string | null
  engineJobId?: string | null
  status?: string
}

/** Shared intake — used by POST /v1/intake and the Email Worker handler.
 *  Creates the Close lead + Ready-to-underwrite opportunity, then hands the
 *  lead to the engine's eval queue. No outreach is performed. */
export async function processIntake(
  env: Env,
  input: { propertyAddress: string; contactName?: string; phone?: string; email?: string; source?: string },
): Promise<IntakeResult> {
  if (!/\b\d{5}(-\d{4})?\b/.test(input.propertyAddress)) {
    return { ok: false, error: 'propertyAddress must include street, city, state, and ZIP' }
  }
  if (!env.CLOSE_API_KEY) return { ok: false, error: 'Close CRM is not configured on this environment' }
  if (!env.ENGINE_API_KEY) return { ok: false, error: 'Conversation-intelligence engine is not configured' }

  // 1. Close lead — dedupe by address first (repeat submissions reuse).
  let leadId = (await findLeadByAddress(env, input.propertyAddress))?.id ?? null
  if (!leadId) {
    const paField = await propertyAddressFieldId(env)
    const leadBody: Record<string, unknown> = {
      display_name: input.contactName || input.propertyAddress,
      contacts: input.contactName || input.phone || input.email
        ? [{
            name: input.contactName ?? '',
            phones: input.phone ? [{ phone: input.phone, type: 'mobile' }] : [],
            emails: input.email ? [{ email: input.email, type: 'office' }] : [],
          }]
        : [],
    }
    if (paField) leadBody[`custom.${paField}`] = input.propertyAddress
    const resp = await closeFetch(env, '/lead/', { method: 'POST', body: JSON.stringify(leadBody) })
    if (!resp?.ok) {
      const detail = resp ? await resp.text().catch(() => '') : ''
      console.error('[Intake] Close lead create failed:', resp?.status, detail)
      return { ok: false, error: 'Failed to create lead' }
    }
    leadId = ((await resp.json()) as { id: string }).id
  }

  // 2. Opportunity at "Ready to underwrite" — the engine advances it to
  //    "Presenting Offer" (the waiting list) when the eval lands.
  let opportunityId: string | null = null
  const oppResp = await closeFetch(env, '/opportunity/', {
    method: 'POST',
    body: JSON.stringify({
      lead_id: leadId,
      pipeline_id: PIPELINE_ID,
      status_id: READY_TO_UNDERWRITE_STATUS,
      note: `web intake${input.source ? ` — ${input.source}` : ''}`,
    }),
  })
  if (oppResp?.ok) {
    opportunityId = ((await oppResp.json()) as { id: string }).id
  } else {
    console.error('[Intake] Close opportunity create failed:', oppResp?.status)
    // Not fatal — the engine eval can still run; the opp can be created later.
  }

  // 3. Hand the lead to the engine — it queues + dispatches the eval.
  const engResp = await fetch(`${ENGINE_BASE}/engine/eval/request`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ENGINE_API_KEY}`,
    },
    body: JSON.stringify({
      leadId,
      propertyAddress: input.propertyAddress,
      ...(opportunityId ? { opportunityId } : {}),
    }),
  }).catch((e) => {
    console.error('[Intake] engine eval/request failed:', e)
    return null
  })
  if (!engResp?.ok) {
    const detail = engResp ? await engResp.text().catch(() => '') : ''
    console.error('[Intake] engine eval/request rejected:', engResp?.status, detail)
    return { ok: false, error: 'Lead created but engine dispatch failed', leadId, opportunityId }
  }
  const engineJob = (await engResp.json()) as { job?: { id?: string }; created?: boolean }

  return { ok: true, leadId, opportunityId, engineJobId: engineJob.job?.id ?? null, status: 'eval_queued' }
}

/** Parse a form-notification email into an intake input. Handles both
 *  plaintext bodies and labelled fields ("Address:", "Name:", ...). */
export function parseIntakeEmail(raw: string): { propertyAddress: string; contactName?: string; phone?: string; email?: string } | null {
  const text = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const pick = (label: string) =>
    new RegExp(`${label}[:\\s]+([^\\n\\r<]+)`, 'i').exec(text)?.[1]?.trim()
  const propertyAddress =
    pick('property address') ?? pick('address') ??
    text.match(/\d+\s+[A-Z][A-Za-z0-9.' ]+,\s*[A-Z][A-Za-z .]+,\s*[A-Z]{2}\s+\d{5}/)?.[0]?.trim()
  if (!propertyAddress || !/\b\d{5}\b/.test(propertyAddress)) return null
  return {
    propertyAddress: propertyAddress.slice(0, 300),
    contactName: pick('name') ?? pick('contact name'),
    phone: pick('phone') ?? text.match(/\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}/)?.[0],
    email: pick('email') ?? text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0],
  }
}

const intake = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

intake.post('/', async (c) => {
  let body: z.infer<typeof intakeSchema>
  try {
    body = intakeSchema.parse(await c.req.json())
  } catch {
    return c.json({ ok: false, error: 'Invalid request body' }, 400)
  }
  const result = await processIntake(c.env, body)
  if (!result.ok) {
    const status = result.error?.includes('not configured') ? 503
      : result.error?.includes('must include') ? 400 : 502
    return c.json(result, status)
  }
  return c.json(result)
})

export default intake
