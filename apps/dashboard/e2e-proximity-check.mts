/**
 * E2E artifact: run the real recalc pipeline (recalculateReport) against the
 * saved Wenham report with proximity toggles off vs on — proves the dialog
 * switch now reaches ARV (task 4).
 */
import { readFileSync } from 'node:fs'
import { recalculateReport, DEFAULT_REHAB_TABLE, MAJOR_ITEMS_LIST } from './src/lib/recalc'
import { PROXIMITY_DEFAULTS } from './src/lib/client-api'
import type { EvaluationSettings } from './src/lib/recalc/types'

const data = JSON.parse(readFileSync('/tmp/wenham-report.json', 'utf8'))
const applied = data.appliedSettings ?? {}

const settings: EvaluationSettings = {
  filters: applied.filters?.map((f: any) => ({ type: f.type, enabled: f.enabled, value: f.value, priority: f.priority })) ?? [],
  adjustments: applied.adjustments?.map((a: any) => ({ type: a.type, enabled: a.enabled, amount: a.amount, percent: a.percent, thresholdDays: a.thresholdDays })) ?? [],
  dealParams: { ...(applied.dealParams ?? { closingCostsPercent: 8, carryingCostsPercent: 2, wholesaleFee: 10000 }), arvThresholdPercent: applied.arvThresholdPercent ?? 15 },
  rehabTable: applied.rehabTable ?? DEFAULT_REHAB_TABLE,
  tierRanges: applied.tierRanges,
  rehabLevelIndex: applied.rehabLevelIndex ?? 2,
  majorItems: applied.majorItems ?? MAJOR_ITEMS_LIST.map(m => ({ id: m.id, name: m.name, enabled: false, cost: m.defaultCost })),
  additionPlay: applied.additionPlay ?? 0,
  proximityConfig: PROXIMITY_DEFAULTS,
  asIsThresholdPercent: applied.asIsThresholdPercent ?? 70,
}

const off = recalculateReport(data, settings)
const on = recalculateReport(data, { ...settings, proximityAdjustments: { siding: false, backing: true, fronting: false } })

const arv0 = off.valuation.arv
const arv1 = on.valuation.arv
const cfg = PROXIMITY_DEFAULTS
const expected = arv0 >= cfg.arvThreshold ? Math.round(arv0 * cfg.backing.percent / 100) : cfg.backing.flat

console.log('original ARV (report):', data.valuation.arv)
console.log('recalc ARV toggles OFF:', arv0, '| deduction:', off.valuation.proximityDeduction)
console.log('recalc ARV backing ON:', arv1, '| deduction:', on.valuation.proximityDeduction)
console.log('expected deduction:', expected)
console.log('delta:', arv0 - arv1)

const pass = arv0 - arv1 === expected && on.valuation.proximityDeduction === expected
console.log(pass ? 'PASS: proximity toggle flows through recalc → ARV drops by deduction' : 'FAIL')
process.exitCode = pass ? 0 : 1
