// Comp-condition chain E2E: listing fetch (Zillow→Redfin→Realtor) → photo
// embed → Clef classification. Hits the dev-only routes on the local API —
// deterministic schema assertions, no agent steps.
import { test, expect } from 'e2e'
import { z } from 'zod'

const API_URL = process.env.FLOWSTATE_API_URL ?? 'http://localhost:8787'
const api = { platforms: ['api'] }

test('dev routes expose the Clef binding', api, async () => {
  const res = await fetch(`${API_URL}/dev/clef-status`)
  expect(res.status).toBe(200)
  expect(await res.json() as unknown).toMatchSchema(
    z.object({ clefAvailable: z.literal(true) }),
  )
})

test('comp listing evidence + Clef condition classification', { ...api, timeout: 120_000 }, async () => {
  const res = await fetch(`${API_URL}/dev/comp-condition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: '6137 Sparling Hills Cir',
      city: 'Orlando',
      state: 'FL',
      zipCode: '32819',
      salePrice: 264200,
      saleDate: '2026-01-13',
    }),
  })
  expect(res.status).toBe(200)
  const out = expect(await res.json() as unknown).toMatchSchema(
    z.object({
      success: z.literal(true),
      data: z.object({
        listing: z.object({
          source: z.string(),
          sourceUrl: z.string().optional(),
          description: z.string().optional(),
          photoCount: z.number(),
        }).nullable(),
        condition: z.object({
          renovated: z.boolean(),
          renovatedProbability: z.number().min(0).max(1),
          asIs: z.boolean(),
          asIsProbability: z.number().min(0).max(1),
          investorLanguageProbability: z.number().min(0).max(1),
          tier: z.enum(['investor', 'median', 'arv']),
          conditionScore: z.number().min(0).max(4),
          conditionLabel: z.string(),
          modelVersion: z.string(),
        }).nullable(),
        investorSignal: z.boolean(),
        skippedReason: z.string().optional(),
      }),
    }),
  )
  // The classification chain must actually deliver, not just shape up —
  // a regression here should surface as a failing test, not silent nulls.
  expect(out.data.listing?.source).toBe('zillow')
  expect(out.data.listing?.photoCount).toBeGreaterThan(0)
  expect(out.data.condition).not.toBeNull()
})
