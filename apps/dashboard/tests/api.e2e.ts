// API-level E2E: health, auth boundary, and the full analyze job lifecycle.
// No agent steps — deterministic fetch + zod schema checks only.
import { test, expect } from 'e2e'
import { z } from 'zod'

const API_URL = process.env.FLOWSTATE_API_URL ?? 'http://localhost:8787'
// Local-D1-only key (see .opencode/ENGINEERING_STATE.md) — carries no
// production weight. Override with FLOWSTATE_E2E_API_KEY.
const API_KEY =
  process.env.FLOWSTATE_E2E_API_KEY ??
  'fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d'
const AUTH = { Authorization: `Bearer ${API_KEY}` }

// API tests pin to the engine-free target — no browser context opens.
const api = { platforms: ['api'] }

test('health endpoints respond ok', api, async () => {
  const res = await fetch(`${API_URL}/health`)
  expect(res.status).toBe(200)
  expect(await res.json() as unknown).toMatchSchema(z.object({ status: z.literal('ok') }))
})

test('unauthenticated v1 calls are rejected', api, async () => {
  const res = await fetch(`${API_URL}/v1/analyze/jobs/job_nonexistent`)
  expect(res.status).toBe(401)
})

test('POST /v1/analyze runs a job to a completed report', { ...api, timeout: 420_000 }, async () => {
  const start = await fetch(`${API_URL}/v1/analyze`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '8952 Sterling Ln, Port Richey, FL 34668' }),
  })
  expect(start.status).toBe(200)
  const started = expect(await start.json() as unknown).toMatchSchema(
    z.object({ success: z.literal(true), data: z.object({ jobId: z.string() }) }),
  )

  await expect
    .poll(
      async () => {
        const res = await fetch(`${API_URL}/v1/analyze/jobs/${started.data.jobId}`, { headers: AUTH })
        const body = (await res.json()) as { data?: { status?: string } }
        return body?.data?.status
      },
      { interval: 5_000, timeout: 360_000 },
    )
    .toBe('complete')

  const done = await fetch(`${API_URL}/v1/analyze/jobs/${started.data.jobId}`, { headers: AUTH })
  const report = expect(await done.json() as unknown).toMatchSchema(
    z.object({
      success: z.literal(true),
      data: z.object({
        status: z.literal('complete'),
        result: z.object({
          subject: z.object({ address: z.string() }),
          // valuation is null on insufficient-comps runs — the report
          // contract is the subject + comp pool + step log, ARV optional.
          valuation: z.object({ arv: z.number().nullable() }).nullable(),
          comps: z.object({
            total: z.number(),
            insufficientComps: z.boolean(),
            items: z.array(z.object({ id: z.string(), isEnabled: z.boolean() })),
          }),
          report: z.object({ steps: z.array(z.object({ step: z.string(), status: z.string() })) }),
        }),
      }),
    }),
  )
  expect(report.data.result.subject.address.toUpperCase()).toContain('STERLING')
  expect(report.data.result.comps.total).toBeGreaterThan(0)
})
