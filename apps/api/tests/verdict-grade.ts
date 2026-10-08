/**
 * Golden-set verdict grader — replays a recorded harness evidence bundle
 * through gradeVerdict and prints the gate's checks, the grade, and the
 * machine-readable failures. Deterministic — no provider, no DO.
 *
 *   npx tsx tests/verdict-grade.ts <evidence.json> [selection.json]
 *
 * evidence.json = the GET /harness/evidence payload ({ evidence: {...} }
 * or the bare bundle). selection.json = the posted verdict body; when
 * absent, a fallback-style selection is synthesized from the bundle's
 * suggestedSelection + median pick price so the deterministic path is
 * exercised.
 */

import { readFileSync } from 'node:fs'
import { gradeVerdict } from '../src/services/evaluation/verdict-grade'
import type { AgentSelection, HarnessEvidence } from '../src/services/evaluation'

const [, , evidencePath, selectionPath] = process.argv
if (!evidencePath) {
  console.error('usage: npx tsx tests/verdict-grade.ts <evidence.json> [selection.json]')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(evidencePath, 'utf8'))
const evidence: HarnessEvidence = raw.evidence ?? raw
if (!Array.isArray(evidence.comps) || evidence.comps.length === 0) {
  console.error('no comps in evidence bundle')
  process.exit(2)
}

const fmt = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`)
console.log(`\n=== pool (${evidence.jobId ?? evidencePath.split('/').pop()}) ===`)
for (const c of evidence.comps) {
  console.log(
    `${String(c.id).padEnd(8)} ${(c.address ?? 'unknown').slice(0, 40).padEnd(42)}` +
      ` ${fmt(c.salePrice).padStart(9)}  ${String(c.conditionLabel ?? '—').padEnd(10)}` +
      ` tier:${String(c.compTier ?? '—').padEnd(8)}` +
      (c.rulesCheck && !c.rulesCheck.meets ? `  rules-missing:${c.rulesCheck.missing.join('|')}` : ''),
  )
}

const pickedPrices = evidence.suggestedSelection
  .map((id) => evidence.comps.find((c) => c.id === id)?.salePrice)
  .filter((p): p is number => p != null && p > 0)
const fallbackArv = pickedPrices.length ? Math.round(pickedPrices.reduce((a, b) => a + b, 0) / pickedPrices.length) : 0

const selection: AgentSelection = selectionPath
  ? JSON.parse(readFileSync(selectionPath, 'utf8'))
  : {
      arv: fallbackArv,
      conf: 'low',
      selectedCompIds: evidence.suggestedSelection,
    }

const grade = gradeVerdict(evidence, selection)
console.log('\n=== grade ===')
console.log(`score ${grade.score.toFixed(2)}  checks ${JSON.stringify(grade.checks)}`)
if (grade.failures.length) console.log(`failures: ${grade.failures.join(', ')}`)
if (grade.gateFeedback.length) console.log(`feedback: ${grade.gateFeedback.join(' | ')}`)
console.log(`gradedAt ${grade.gradedAt}`)
