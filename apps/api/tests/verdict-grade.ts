/**
 * Golden-set verdict grader — docs/BANDING-VERIFICATION-SPEC.md §5.
 *
 * Replays a recorded harness evidence bundle through computeEvidenceBands
 * + gradeVerdict and prints the evidence bands, the grade, and the
 * machine-readable failures. Deterministic — no provider, no DO.
 *
 *   npx tsx tests/verdict-grade.ts <evidence.json> [selection.json]
 *
 * evidence.json = the GET /harness/evidence payload ({ evidence: {...} }
 * or the bare bundle). selection.json = the posted verdict body; when
 * absent, a fallback-style selection is synthesized from the bundle's
 * suggestedSelection + mid band so the deterministic path is exercised.
 */

import { readFileSync } from 'node:fs'
import { computeEvidenceBands } from '@flowstate-api/shared/appraisal'
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

const bands = computeEvidenceBands(evidence.comps, evidence.subject)
const fmt = (v: number | null) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`)
console.log(`\n=== evidence bands (${evidence.jobId ?? evidencePath.split('/').pop()}) ===`)
for (const bn of ['as_is', 'median', 'arv'] as const) {
  const b = bands[bn]
  console.log(
    `${bn.padEnd(7)} n=${String(b.n).padStart(2)} ${String(b.method).padEnd(18)}` +
      ` edges ${fmt(b.low)} – ${fmt(b.high)}  mid ${fmt(b.mid)}` +
      (b.trimmedIds.length ? `  trimmed:${b.trimmedIds.length}` : '') +
      (b.edgeExcludedIds.length ? `  edge-excluded:${b.edgeExcludedIds.length}` : ''),
  )
}

const selection: AgentSelection = selectionPath
  ? JSON.parse(readFileSync(selectionPath, 'utf8'))
  : {
      arv: bands.arv.mid ?? bands.median.mid ?? 0,
      conf: 'low',
      selectedCompIds: evidence.suggestedSelection,
      bandEdges: {
        ...(bands.as_is.method === 'ok'
          ? { as_is: { low: bands.as_is.low!, high: bands.as_is.high!, mid: bands.as_is.mid!, compIds: bands.as_is.memberIds } }
          : {}),
        ...(bands.median.method === 'ok'
          ? { median: { low: bands.median.low!, high: bands.median.high!, mid: bands.median.mid!, compIds: bands.median.memberIds } }
          : {}),
        ...(bands.arv.method === 'ok'
          ? { arv: { low: bands.arv.low!, high: bands.arv.high!, mid: bands.arv.mid!, compIds: bands.arv.memberIds } }
          : {}),
      },
    }

const grade = gradeVerdict(evidence, selection)
console.log('\n=== grade ===')
console.log(`score ${grade.score.toFixed(2)}  checks ${JSON.stringify(grade.checks)}`)
for (const bn of ['as_is', 'median', 'arv'] as const) {
  const g = grade.bandGrades[bn]
  console.log(
    `  ${bn.padEnd(7)} ${g.result.padEnd(8)} ${String(g.method).padEnd(18)}` +
      (g.epsLow != null ? ` ε_low=${g.epsLow.toFixed(3)} ε_high=${g.epsHigh!.toFixed(3)} IoU=${g.iou!.toFixed(3)}` : ''),
  )
}
if (grade.failures.length) console.log(`failures: ${grade.failures.join(', ')}`)
console.log(`gradedAt ${grade.gradedAt}`)
