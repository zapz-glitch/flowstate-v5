import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)

function loadHook(file, mocks) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => mocks[name] ?? require(name),
  })
  return module.exports
}

function reactHarness() {
  const stateWrites = []
  return {
    stateWrites,
    react: {
      useState: (initial) => [
        initial === true ? false : typeof initial === 'function' ? initial() : initial,
        (value) => stateWrites.push(value),
      ],
      useEffect: () => {},
      useMemo: (compute) => compute(),
      useCallback: (callback) => callback,
      useRef: (current) => ({ current }),
    },
  }
}

test('Python display preserves server values until the user picks a comp, then recalcs client-side', () => {
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
  const { useAnalysisEvaluation } = loadHook('./use-analysis-evaluation.ts', {
    react,
    sonner: { toast: { info: (message) => notices.push(message), error: (message) => notices.push(message) } },
    '@/lib/client-api': { recalculateReportComps: () => assert.fail('No server call — comp math is client-side now') },
    '@/components/analysis/format-helpers': { getCompKey: (comp) => comp.clip },
    '@/hooks/use-report-settings': {
      useReportSettings: () => ({
        settings: {},
        settingsChanged: true,
        recalcData: { valuation: { arv: 1 }, compEvaluations: [] },
      }),
    },
    '@/lib/recalc': { recalculateValuationFromComps: (...args) => { recalcs.push(args); return { arv: 999, marker: 'client' } } },
  })
  const data = {
    evaluationEngine: 'python-v4',
    subject: { clip: 'subject' },
    valuation: { arv: 612345.67, buyPrice: 401234.56 },
    comps: { items: [{ clip: 'one', isEnabled: true }, { clip: 'two', isEnabled: false }] },
  }
  const render = () => { stateIndex = 0; refIndex = 0; return useAnalysisEvaluation({ data }) }
  let result = render()
  assert.equal(result.displayValuation, data.valuation)
  assert.equal(result.displayComps, data.comps)
  assert.equal(result.effectiveComps, data.comps)
  assert.equal(result.isRecalculated, false)
  result.handleToggleComp('two')
  result = render()
  assert.equal(notices.length, 0)
  assert.equal(recalcs.length, 1)
  assert.equal(result.displayValuation.marker, 'client')
  assert.equal(result.isRecalculated, true)
})

for (const evaluationEngine of ['python-v4', undefined]) {
  test(`${evaluationEngine ?? 'legacy'} settings use the correct evaluation authority`, () => {
    const { react, stateWrites } = reactHarness()
    let recalculations = 0
    const notices = []
    const { useReportSettings } = loadHook('./use-report-settings.ts', {
      react,
      sonner: { toast: { info: (message) => notices.push(message) } },
      '@/lib/client-api': {},
      '@/lib/recalc': {
        DEFAULT_REHAB_TABLE: {},
        MAJOR_ITEMS_LIST: [],
        recalculateReport: () => { recalculations += 1; return { legacy: true } },
      },
    })
    const result = useReportSettings({ evaluationEngine, valuation: { arv: 612345.67 } })
    const python = evaluationEngine === 'python-v4'
    assert.equal(recalculations, python ? 0 : 1)
    if (python) assert.equal(result.recalcData, null)
    result.updateFilter('distance', { value: 1 })
    result.updateAdjustment('bedroom', { amount: 1000 })
    result.updateDealParams({ wholesaleFee: 2000 })
    result.selectRehabLevel(1)
    result.updateRehabTableEntry('low', 0, { perSqft: 30 })
    result.updateMajorItem('roof', { enabled: true })
    result.updateAsIsThreshold(65)
    result.updateProximityAdjustments({})
    assert.equal(stateWrites.length, python ? 0 : 8)
    assert.equal(notices.length, python ? 8 : 0)
  })
}
