import assert from 'node:assert/strict'
import { AnalysisJobDO } from '../src/durable-objects/analysis-job'
import { ChunkedJobState } from '../src/durable-objects/chunked-job-state'
import { performAnalysisPhase1, type AgentSelection } from '../src/services/evaluation'
import type { NormalizedComparable, NormalizedProperty, PropertyBundle } from '../src/services/property-api/types'
import type { Env } from '../src/types'

// Seam E2E in-process: the real AnalysisJobDO, real phase-1 freeze, real
// harness endpoints, real phase-2 resume — only the provider network is
// absent. Success = a job parks at awaiting_agent, hands the agent its
// evidence bundle, validates a posted verdict, and renders the finished
// report stamped with the agent's picks.

class MockStorage {
  values = new Map<string, unknown>()
  alarmAt: number | null = null
  async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
    const next = new Map(this.values)
    const result = await callback({
      get: async (key: string) => next.get(key),
      put: async (key: string, value: unknown) => { next.set(key, value) },
      delete: async (key: string) => { next.delete(key) },
    })
    this.values = next
    return result
  }
  async get(key: string) { return this.values.get(key) }
  async put(key: string, value: unknown) { this.values.set(key, value) }
  async delete(key: string) { this.values.delete(key) }
  async setAlarm(at: number) { this.alarmAt = at }
  async deleteAlarm() { this.alarmAt = null }
}
class MockState {
  storage = new MockStorage()
  waited: Promise<unknown>[] = []
  blockConcurrencyWhile(callback: () => Promise<void>) { void callback() }
  waitUntil(promise: Promise<unknown>) { this.waited.push(promise) }
}

// drizzle(env.DB) only ever needs prepare() -> bind/run/first/all.
const statement = {
  bind: () => statement,
  run: async () => ({ meta: { changes: 1 }, success: true }),
  all: async () => ({ results: [{ id: 'row-1' }] }),
  first: async () => null,
  raw: async () => [['row-1']],
}
const env = {
  DB: { prepare: () => statement },
} as unknown as Env

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)

const subject: NormalizedProperty = {
  id: 'subj', provider: 'corelogic', address: '1 Subject St', city: 'Tampa',
  state: 'FL', zipCode: '33607', latitude: 27.95, longitude: -82.45,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeAcres: null,
  lotSizeSquareFeet: 8000, yearBuilt: 1990, propertyType: 'Single Family Residence',
  stories: 1, subdivision: 'Oak Park', lastSalePrice: null, lastSaleDate: null,
  assessedValue: null, marketValue: null, taxAmount: null,
}

const mkComp = (id: string, over: Partial<NormalizedComparable>): NormalizedComparable => ({
  id, provider: 'corelogic', address: `${id} Rd`, city: 'Tampa', state: 'FL',
  zipCode: '33607', latitude: 27.95, longitude: -82.45, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeAcres: null,
  lotSizeSquareFeet: 8000, yearBuilt: 1990, propertyType: 'Single Family Residence',
  salePrice: 300000, saleDate: daysAgo(60), pricePerSqft: 200,
  subdivision: 'Oak Park', ...over,
})

const bundle: PropertyBundle = {
  property: subject,
  comparables: [
    mkComp('c-1', { salePrice: 400000, saleDate: daysAgo(30), pricePerSqft: 400000 / 1500 }),
    mkComp('c-2', { salePrice: 390000, saleDate: daysAgo(45), pricePerSqft: 390000 / 1500 }),
    mkComp('c-3', { salePrice: 380000, saleDate: daysAgo(60), pricePerSqft: 380000 / 1500 }),
    mkComp('c-4', { salePrice: 200000, saleDate: daysAgo(70), pricePerSqft: 200000 / 1500 }),
  ],
  enrichment: { permits: null, floodZone: null, weatherRisk: null, neighbourhood: null },
  metadata: {
    fetchedAt: new Date().toISOString(),
    provider: 'corelogic',
    searchParams: { address: '1 Subject St' },
    comparablesParams: {},
    enrichmentOptions: {},
  },
} as unknown as PropertyBundle

// ── Phase 1 freezes a real evidence context (deterministic, no providers) ────
const ctx = await performAnalysisPhase1(
  { jobId: 'job_harness', bundle, userId: 'u1', prefetchedPhotoBundle: null },
  env,
)
assert.ok(ctx.appraisalResult.comparables.length > 0, 'phase 1 must produce appraised comps')

// Mirror the DO's own drain+stamp on the parked context (analysis-job.ts
// harness branch) — the promise must be awaited before JSON.stringify, or it
// serializes to a truthy {} that phase 2 would read as a photo bundle.
if (ctx.photoBundlePromise) ctx.photoBundle = await ctx.photoBundlePromise
delete ctx.photoBundlePromise
ctx.steps.push({ step: 'agent_selection', label: 'agent_selection', status: 'skipped', detail: 'Awaiting Evaluation Agent verdict', durationMs: 0 })

const config = {
  jobId: 'job_harness',
  userId: 'u1',
  search: { address: '1 Subject St' },
  searchOptions: {},
  evalParams: {},
  llmEnabled: false,
  harness: 'agent' as const,
}
const parked = {
  jobId: 'job_harness', userId: 'u1', status: 'awaiting_agent' as const,
  pending: [], events: [], createdAt: Date.now() - 5000,
  harnessContext: JSON.stringify(ctx),
  harnessConfig: JSON.stringify(config),
  resumeSeed: JSON.stringify({ isAttomMcp: false, ladderStep: 0, ladderScope: null }),
  harnessRounds: 0,
  harnessDeadline: Date.now() + 30 * 60_000,
}

const state = new MockState()
const persistence = new ChunkedJobState<typeof parked>(state.storage as never)
await persistence.write(parked)
const job = new AnalysisJobDO(state as never, env)

// ── GET /harness/evidence → frozen bundle for the agent ──────────────────────
const evRes = await job.fetch(new Request('http://internal/harness/evidence'))
assert.equal(evRes.status, 200, 'evidence endpoint must serve the parked job')
const ev = (await evRes.json()) as {
  jobId: string
  rounds: number
  deadlineMs: number
  evidence: {
    subject: { address?: string }
    comps: Array<{ id: string; salePrice?: number | null }>
    suggestedSelection: string[]
    insufficient: boolean
    steps: Array<{ step: string }>
  }
}
assert.equal(ev.jobId, 'job_harness')
assert.equal(ev.rounds, 0)
assert.ok(ev.deadlineMs > 0)
assert.equal(ev.evidence.subject.address, '1 Subject St')
assert.equal(ev.evidence.comps.length, 4)
assert.ok(ev.evidence.insufficient === false || ev.evidence.insufficient === true)
assert.ok(ev.evidence.steps.some((s) => s.step === 'agent_selection'), 'freeze stamps the awaiting step')

// ── Repeat /start-streaming while parked → 409, context survives ─────────────
const dup = await job.fetch(new Request('http://internal/start-streaming', {
  method: 'POST',
  body: JSON.stringify({ jobId: 'job_harness', userId: 'u1', search: {}, searchOptions: {}, evalParams: {}, llmEnabled: false }),
}))
assert.equal(dup.status, 409, 'repeat start on an awaiting_agent job must not discard the verdict context')
await dup.text()
assert.ok((await persistence.read())?.harnessContext, 'frozen context still parked')

// ── Invalid verdict → 422 (arv below envelope, pick outside pool) ─────────────
const bad = await job.fetch(new Request('http://internal/harness/selection', {
  method: 'POST',
  body: JSON.stringify({
    selection: { arv: 1, conf: 'high', selectedCompIds: ['c-1'], drivers: ['c-1'] },
  } satisfies { selection: AgentSelection }),
}))
assert.equal(bad.status, 422, 'out-of-envelope ARV must be rejected')
const badBody = (await bad.json()) as { fails: string[] }
assert.ok(badBody.fails.length > 0)

const alien = await job.fetch(new Request('http://internal/harness/selection', {
  method: 'POST',
  body: JSON.stringify({
    selection: { arv: 390000, conf: 'high', selectedCompIds: ['not-in-pool'], drivers: ['not-in-pool'] },
  } satisfies { selection: AgentSelection }),
}))
assert.equal(alien.status, 422, 'picks outside the enabled pool must be rejected')
await alien.text()

// ── Valid verdict → resume → complete report stamped with agent data ─────────
const picks = ['c-1', 'c-2', 'c-3']
const arv = Math.round((400000 + 390000 + 380000) / 3)
const sel: AgentSelection = {
  arv,
  conf: 'high',
  selectedCompIds: picks,
  drivers: picks,
  pocketScore: 7,
  dealEconomics: 'test verdict',
  notes: 'e2e seam proof',
}
const selRes = await job.fetch(new Request('http://internal/harness/selection', {
  method: 'POST',
  body: JSON.stringify({ selection: sel }),
}))
assert.equal(selRes.status, 200, 'valid selection resumes the job')
const selBody = (await selRes.json()) as { status: string }
assert.equal(selBody.status, 'resumed')
assert.equal(state.waited.length, 1, 'resume registers a waitUntil')
await state.waited[0]

const js = await persistence.read()
assert.equal(js?.status, 'complete', 'job completes after the agent verdict')
assert.equal(js?.harnessContext, undefined, 'frozen context is consumed on resume')

const events = (js?.events ?? []) as Array<{ event: string; data?: Record<string, unknown> }>
const complete = events.find((e) => e.event === 'evaluation_complete')
assert.ok(complete, 'evaluation_complete event emitted')
const response = (complete?.data?.updatedResult ?? complete?.data?.result ?? complete?.data) as {
  harness?: { source?: string; pocketScore?: number | null; dealEconomics?: string | null; notes?: string }
  appraisal?: { arv?: number | null }
  valuation?: { arv?: number | null }
  comps?: { items?: Array<{ id?: string; compGroup?: string | null; bRole?: string | null }> }
}
assert.equal(response.harness?.source, 'agent', 'report marks the agent as the verdict source')
assert.equal(response.harness?.pocketScore, 7, 'pocket score carried into the rendered report')
assert.equal(response.harness?.dealEconomics, 'test verdict')
// The client mirrors server-side selection through compGroup === 'arv' —
// exactly the agent's picks, nothing else.
const arvItems = new Set(
  (response.comps?.items ?? []).filter((c) => c.compGroup === 'arv').map((c) => c.id),
)
assert.deepEqual(arvItems, new Set(picks), 'only agent-selected comps render as selected client-side')
const anchorItem = (response.comps?.items ?? []).find((c) => c.bRole === 'anchor')
assert.ok(anchorItem, 'an anchor comp is rendered from the agent verdict')
assert.ok(picks.includes(anchorItem?.id ?? ''), 'the anchor is one of the agent picks')
assert.equal(response.valuation?.arv ?? response.appraisal?.arv, arv, 'server renders valuation on the agent anchor')

console.log('harness-seam E2E: park → evidence → 409/422 guards → selection resume → agent-stamped report passed')
