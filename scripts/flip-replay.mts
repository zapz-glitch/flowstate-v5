/**
 * Flip replay — re-price saved flip-backtest runs through the current
 * Set-B with no provider or model calls. Reads the saved comp pools from a
 * local D1 file; scores ARV against each flip's known resale.
 *
 *   npx tsx scripts/flip-replay.mts <d1.sqlite> <backtest.json>
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { evaluateB, HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { savedToBComps, savedToBSubject } from '../apps/api/src/services/evaluation/saved-pool'

const [dbFile, runFile] = process.argv.slice(2)
const db = new DatabaseSync(dbFile, { readOnly: true })
const results = JSON.parse(readFileSync(runFile, 'utf8')).results as Array<Record<string, any>>
const rows: Array<Record<string, unknown>> = []
for (const x of results) {
  const rep = db.prepare('select full_response_json from saved_reports where job_id = ?').get(x.jobId) as { full_response_json?: string } | undefined
  if (!rep?.full_response_json) continue
  const saved = JSON.parse(rep.full_response_json)
  const r = evaluateB(savedToBSubject(saved), savedToBComps(saved.comps?.items ?? [], null))
  const arv = r.arv
  rows.push({
    address: x.address, sold: x.sell, before: x.arv, after: arv,
    beforeMiss: x.errPct, afterMiss: arv ? Math.round(((arv - x.sell) / x.sell) * 1000) / 10 : null,
    source: r.source, drivers: r.drivers.length,
    market: r.flags.find((f) => f.startsWith('market:')) ?? null,
  })
}
const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const scored = rows.filter((r) => r.afterMiss != null && !String(r.source).startsWith('T3'))
console.log(`harness ${HARNESS_VERSION}`)
console.table(rows.map((r) => ({ address: String(r.address).slice(0, 26), sold: r.sold, before: r.beforeMiss, after: r.afterMiss, source: String(r.source).slice(0, 18), drv: r.drivers })))
const abs = (k: string) => scored.map((r) => Math.abs(Number(r[k]))).filter((v) => Number.isFinite(v))
console.log({
  scored: scored.length,
  medianMissBefore: med(abs('beforeMiss')), medianMissAfter: med(abs('afterMiss')),
  within10Before: abs('beforeMiss').filter((v) => v <= 10).length, within10After: abs('afterMiss').filter((v) => v <= 10).length,
})
