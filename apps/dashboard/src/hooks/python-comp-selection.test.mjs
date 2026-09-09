import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
function harness() {
  const states = [], refs = [], notices = [], requests = []
  let stateIndex = 0, refIndex = 0
  const react = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial } },
    useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
  }
  const mocks = {
    react,
    sonner: { toast: { error: text => notices.push(text), info: text => notices.push(text) } },
    '@/components/analysis/format-helpers': { getCompKey: comp => comp.address },
    '@/hooks/use-report-settings': { useReportSettings: () => ({ settings: {}, settingsChanged: false, recalcData: null }) },
    '@/lib/recalc': { recalculateValuationFromComps: () => assert.fail('Legacy math must not run') },
    '@/lib/client-api': { recalculateReportComps: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) },
  }
  const module = { exports: {} }
  const source = readFileSync(new URL('./use-analysis-evaluation.ts', import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  vm.runInNewContext(code, { module, exports: module.exports, Error, require: name => mocks[name] ?? require(name) })
  return {
    notices, requests,
    render(data, aiAnalyzing = false) { stateIndex = 0; refIndex = 0; return module.exports.useAnalysisEvaluation({ data, aiAnalyzing }) },
  }
}
const analysis = (revision = 0, selected = ['a'], arv = 600000) => ({
  evaluationEngine: 'python-v4', evaluationRevision: revision, meta: { analysisId: 'job-test' },
  valuation: { arv, buyPrice: arv / 2 },
  comps: { items: ['a', 'b'].map(id => ({ id, address: id, isEnabled: selected.includes(id) })) },
})
const settle = () => new Promise(resolve => setImmediate(resolve))

test('Python comp changes are atomic, revisioned, locked during requests and reset through the server', async () => {
  const h = harness(), original = analysis()
  let view = h.render(original)
  view.handleToggleComp('b')
  view.handleToggleComp('b')
  assert.equal(h.requests.length, 1)
  assert.equal(JSON.stringify(h.requests[0].args), JSON.stringify(['job-test', ['a', 'b'], 0]))
  view = h.render(original)
  assert.equal(view.displayValuation, original.valuation)
  assert.ok(view.displayComps.items.every(comp => comp.selectionPending))
  assert.equal(view.compOverride.selectedCompKeys.size, 1)
  const added = analysis(1, ['a', 'b'], 650000)
  h.requests[0].resolve(added)
  await settle()
  view = h.render(original)
  assert.equal(view.displayValuation, added.valuation)
  assert.equal(view.displayComps, added.comps)
  assert.equal(view.compOverride.selectedCompKeys.size, 2)
  assert.equal(view.compOverride.isManual, true)
  assert.equal(view.authoritativeData, added)
  assert.match(h.notices.at(-1), /Operator-selected comparables.*preliminary/)
  view.handleToggleComp('a')
  assert.equal(JSON.stringify(h.requests[1].args), JSON.stringify(['job-test', ['b'], 1]))
  h.requests[1].resolve(analysis(2, ['b'], 700000))
  await settle()
  view = h.render(original)
  view.handleToggleComp('b')
  assert.equal(h.requests.length, 2)
  assert.match(h.notices.at(-1), /at least one/)
  view.handleResetComps()
  assert.equal(JSON.stringify(h.requests[2].args), JSON.stringify(['job-test', null, 2]))
  h.requests[2].resolve(analysis(3))
  await settle()
  view = h.render(original)
  assert.equal(view.compOverride.isManual, false)
  assert.equal(view.displayValuation.arv, 600000)
})

test('failed recalc keeps prior report and response for a different report is discarded', async () => {
  const h = harness(), original = analysis()
  h.render(original).handleToggleComp('b')
  h.requests[0].reject(new Error('Report revision changed; reload'))
  await settle()
  let view = h.render(original)
  assert.equal(view.displayValuation, original.valuation)
  assert.equal(view.displayComps, original.comps)
  assert.match(h.notices[0], /revision changed/)
  view.handleToggleComp('b')
  const differentReport = { ...analysis(), meta: { analysisId: 'other-report' } }
  h.render(differentReport)
  h.requests[1].resolve(analysis(1, ['a', 'b'], 900000))
  await settle()
  view = h.render(differentReport)
  assert.equal(view.displayValuation, differentReport.valuation)
  assert.equal(view.displayComps, differentReport.comps)
})

test('reloaded manual reports retain reset visibility', () => {
  const h = harness()
  const view = h.render({ ...analysis(4, ['b']), manualCompSelection: ['b'] })
  assert.equal(view.compOverride.isManual, true)
  assert.equal(view.compOverride.selectedCompKeys.has('b'), true)
})

test('manual valuation resets atomically to insufficient comps, reloads, and uses the saved revision on next edit', async () => {
  const h = harness(), original = { ...analysis(1, ['a'], 618551.75), manualCompSelection: ['a'] }
  h.render(original, true).handleResetComps()
  assert.equal(JSON.stringify(h.requests[0].args), JSON.stringify(['job-test', null, 1]))
  const reset = { ...analysis(2, []), valuation: null, manualCompSelection: null, pythonEvaluation: { status: 'INSUFFICIENT_COMPS' } }
  h.requests[0].resolve(reset)
  await settle()
  let view = h.render(original, true)
  assert.equal(view.displayValuation, undefined, 'AI freeze must not retain the old dollar amount')
  assert.equal(view.authoritativeData, reset)
  assert.equal(view.compOverride.selectedCompKeys.size, 0)
  assert.equal(view.compOverride.isManual, false)
  view.handleToggleComp('b')
  assert.equal(JSON.stringify(h.requests[1].args), JSON.stringify(['job-test', ['b'], 2]))
  h.requests[1].resolve({ ...analysis(3, ['b'], 500000), manualCompSelection: ['b'] })
  await settle()
  view = h.render(original)
  assert.equal(view.displayValuation.arv, 500000)
  const reloaded = harness()
  view = reloaded.render(structuredClone(reset))
  assert.equal(view.displayValuation, undefined)
  assert.equal(view.compOverride.isManual, false)
  view.handleToggleComp('a')
  assert.equal(JSON.stringify(reloaded.requests[0].args), JSON.stringify(['job-test', ['a'], 2]))
})

for (const [name, response] of Object.entries({
  nullResponse: null,
  missingValuation: { ...analysis(1), valuation: undefined },
  unmarkedNull: { ...analysis(1), valuation: null },
  insufficientWithValuation: { ...analysis(1), pythonEvaluation: { status: 'INSUFFICIENT_COMPS' } },
  insufficientWithEnabledComp: { ...analysis(1), valuation: null, pythonEvaluation: { status: 'INSUFFICIENT_COMPS' } },
  malformedComps: { ...analysis(1), comps: { items: [null] } },
  missingItems: { ...analysis(1), comps: {} },
  staleRevision: analysis(0),
  missingRevision: { ...analysis(1), evaluationRevision: undefined },
  nonfiniteValuation: analysis(1, ['a'], Infinity),
  wrongReport: { ...analysis(1), meta: { analysisId: 'wrong' } },
})) {
  test(`malformed server selection ${name} does not replace valuation or revision`, async () => {
    const h = harness(), original = analysis()
    h.render(original).handleResetComps()
    h.requests[0].resolve(response)
    await settle()
    const view = h.render(original)
    assert.equal(view.authoritativeData, original)
    assert.equal(view.displayValuation, original.valuation)
    assert.match(h.notices.at(-1), /incomplete evaluation/)
    view.handleToggleComp('b')
    assert.equal(h.requests[1].args[2], 0)
  })
}
