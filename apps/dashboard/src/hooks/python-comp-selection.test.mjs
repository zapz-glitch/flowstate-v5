import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
function harness(recalcResult = { arv: 700000, marker: 'client' }, settingsChanged = false) {
  const states = [], refs = [], notices = [], recalcs = []
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
    '@/hooks/use-report-settings': { useReportSettings: () => ({ settings: {}, settingsChanged, recalcData: null }) },
    '@/lib/recalc': { recalculateValuationFromComps: (...args) => { recalcs.push(args); return recalcResult } },
    '@/lib/client-api': { recalculateReportComps: () => assert.fail('No server call — comp math is client-side now') },
  }
  const module = { exports: {} }
  const source = readFileSync(new URL('./use-analysis-evaluation.ts', import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  vm.runInNewContext(code, { module, exports: module.exports, Error, require: name => mocks[name] ?? require(name) })
  return {
    notices, recalcs,
    render(data, aiAnalyzing = false) { stateIndex = 0; refIndex = 0; return module.exports.useAnalysisEvaluation({ data, aiAnalyzing }) },
  }
}
const analysis = (selected = ['a', 'b'], roles = {}) => ({
  evaluationEngine: 'python-v4', evaluationRevision: 0, meta: { analysisId: 'job-test' },
  valuation: { arv: 600000, buyPrice: 300000 },
  subject: { address: 'subject', squareFeet: 1200 },
  comps: { items: ['a', 'b'].map(id => ({ id, address: id, isEnabled: selected.includes(id), bRole: roles[id] ?? null })) },
})

test('Python comp toggles recalc client-side in the same render — no server call', () => {
  const h = harness()
  const original = analysis(['a', 'b'], { a: 'anchor' })
  let view = h.render(original)
  // Untouched — checked boxes come from the saved report (anchor only)
  assert.equal(view.compOverride.isManual, false)
  assert.equal(view.compOverride.selectedCompKeys.has('a'), true)
  assert.equal(view.compOverride.selectedCompKeys.has('b'), false)
  assert.equal(view.displayValuation, original.valuation)
  assert.equal(view.displayComps, original.comps)
  assert.equal(h.recalcs.length, 0)

  view.handleToggleComp('b')
  view = h.render(original)
  // The box flipped and the deal recalculated client-side — same render
  assert.equal(view.compOverride.isManual, true)
  assert.equal(view.compOverride.selectedCompKeys.size, 2)
  assert.equal(h.recalcs.length, 1)
  assert.equal(view.displayValuation.marker, 'client')
  // Picks restamp the comp list: 'b' joins the ARV group
  assert.equal(view.displayComps.items[1].compGroup, 'arv')
  assert.equal(view.isRecalculated, true)
})

test('unchecking the last selected comp is refused with a toast', () => {
  const h = harness()
  const original = analysis(['a'], { a: 'anchor' })
  let view = h.render(original)
  view.handleToggleComp('a')
  assert.match(h.notices.at(-1), /at least one/)
  view = h.render(original)
  assert.equal(view.compOverride.selectedCompKeys.has('a'), true)
  assert.equal(h.recalcs.length, 0)
})

test('reset returns to the report\'s automatic selection client-side', () => {
  const h = harness()
  const original = analysis(['a', 'b'], { a: 'anchor', b: 'driver' })
  let view = h.render(original)
  view.handleToggleComp('b')
  view = h.render(original)
  assert.equal(view.compOverride.isManual, true)

  view.handleResetComps()
  view = h.render(original)
  assert.equal(view.compOverride.isManual, false)
  // Auto rule = anchor + driver — both boxes rechecked, no server call
  assert.equal(view.compOverride.selectedCompKeys.size, 2)
  assert.equal(view.displayComps, original.comps)
  assert.equal(view.displayValuation, original.valuation)
  assert.equal(view.isRecalculated, false)
})

test('a reloaded manual report keeps its saved selection checked', () => {
  const h = harness()
  const view = h.render({ ...analysis(['b']), manualCompSelection: ['b'] })
  assert.equal(view.compOverride.isManual, true)
  assert.equal(view.compOverride.selectedCompKeys.has('b'), true)
  assert.equal(view.compOverride.selectedCompKeys.has('a'), false)
})

test('changed settings (rehab tier pick) recalc client-side on a server-seated report — no manual pick needed', () => {
  const h = harness({ arv: 700000, marker: 'client' }, true)
  const original = analysis(['a', 'b'], { a: 'anchor' })
  const view = h.render(original)
  // No manual override — the auto anchor selection feeds the recalc
  assert.equal(view.compOverride.isManual, false)
  assert.equal(h.recalcs.length, 1)
  const selectedKeys = h.recalcs[0][2]
  assert.equal(selectedKeys.has('a'), true)
  assert.equal(selectedKeys.has('b'), false)
  assert.equal(view.displayValuation.marker, 'client')
})
