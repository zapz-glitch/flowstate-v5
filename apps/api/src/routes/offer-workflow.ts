/**
 * Offer Workflow Route (Session Auth)
 *
 * Triggers Devin Cloud sessions for offer workflows — the agent looks up
 * the contact in Close and executes the requested workflow. Dashboard
 * session auth only; not exposed to API-key customers.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import { getSession } from '../lib/session'

const offerWorkflow = new Hono<{ Bindings: Env }>()

const WORKFLOWS = {
  prep_offer: 'prep offer',
  no_margin: 'no margin',
} as const

const bodySchema = z.object({
  jobId: z.string().min(1).max(120),
  workflow: z.enum(['prep_offer', 'no_margin']),
  address: z.object({
    street: z.string().min(1).max(200),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    zipCode: z.string().max(20).optional(),
  }),
  metrics: z
    .object({
      listPrice: z.number().nullish(),
      arv: z.number().nullish(),
      buyPrice: z.number().nullish(),
      wholesalePrice: z.number().nullish(),
      rehabCost: z.number().nullish(),
      projectedProfit: z.number().nullish(),
    })
    .optional(),
})

function buildPrompt(input: z.infer<typeof bodySchema>): string {
  const { address, metrics } = input
  const fullAddress = [address.street, address.city, address.state, address.zipCode]
    .filter(Boolean)
    .join(', ')
  const money = (n?: number | null) => (n != null ? `$${Math.round(n).toLocaleString()}` : 'n/a')

  const lines = [
    `Workflow: ${WORKFLOWS[input.workflow]} (parameter: "${input.workflow}")`,
    ``,
    `Subject property: ${fullAddress}`,
    `Analysis job: ${input.jobId}`,
    `Report: https://flowstate.homes/report/${input.jobId}`,
  ]
  if (metrics) {
    lines.push(
      ``,
      `Valuation metrics:`,
      `  list price: ${money(metrics.listPrice)}`,
      `  ARV: ${money(metrics.arv)}`,
      `  buy price: ${money(metrics.buyPrice)}`,
      `  wholesale price: ${money(metrics.wholesalePrice)}`,
      `  rehab cost: ${money(metrics.rehabCost)}`,
      `  projected profit: ${money(metrics.projectedProfit)}`,
    )
  }
  lines.push(
    ``,
    `Look up this address in the Close CRM (CLOSE_API_KEY session secret), find the`,
    `associated contact/lead, and execute the "${WORKFLOWS[input.workflow]}" workflow`,
    `for it.`,
  )
  return lines.join('\n')
}

offerWorkflow.post('/offer-workflow', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const origin = c.req.header('Origin')
  const expected = c.env.DASHBOARD_URL ? new URL(c.env.DASHBOARD_URL).origin : null
  if (origin != null && origin !== expected) {
    return c.json({ error: 'Untrusted origin' }, 403)
  }

  if (!c.env.DEVIN_API_KEY) {
    return c.json({ error: 'Offer workflows not configured' }, 503)
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await c.req.json())
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const sessionSecrets: Array<{ key: string; value: string; sensitive?: boolean }> = []
  if (c.env.CLOSE_API_KEY) {
    sessionSecrets.push({ key: 'CLOSE_API_KEY', value: c.env.CLOSE_API_KEY, sensitive: true })
  }

  const resp = await fetch('https://api.devin.ai/v1/sessions', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.env.DEVIN_API_KEY}`,
    },
    body: JSON.stringify({
      prompt: buildPrompt(body),
      idempotent: false,
      ...(sessionSecrets.length ? { session_secrets: sessionSecrets } : {}),
    }),
  })

  const data = (await resp.json().catch(() => null)) as
    | { session_id?: string; url?: string; detail?: string }
    | null

  if (!resp.ok || !data?.session_id) {
    console.error('[OfferWorkflow] Devin session create failed:', resp.status, data)
    return c.json(
      { error: `Failed to start Devin session (${resp.status})` },
      502,
    )
  }

  return c.json({
    success: true,
    sessionId: data.session_id,
    url: data.url ?? `https://app.devin.ai/sessions/${data.session_id}`,
  })
})

export default offerWorkflow
