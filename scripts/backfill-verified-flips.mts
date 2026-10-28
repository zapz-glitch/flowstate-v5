/**
 * Backfill verified_flips from saved reports — every comp a past run
 * already paid for, run through the same verifyFlip() rule live runs use.
 * No provider calls.
 *
 *   npx tsx scripts/backfill-verified-flips.mts <local D1 .sqlite file>
 *
 * Local D1 only (the miniflare file under wrangler's --persist-to dir).
 * Apply migrations 0046–0047 first: wrangler d1 migrations apply DB --local.
 */
import { DatabaseSync } from 'node:sqlite'
import { recordVerifiedFlips, medianPpsfOf } from '../apps/api/src/services/verified-flips'

const file = process.argv[2]
if (!file) { console.error('usage: backfill-verified-flips.mts <d1 sqlite file>'); process.exit(1) }
const sqlite = new DatabaseSync(file)

// recordVerifiedFlips speaks D1 — prepare/bind/run/batch over node:sqlite.
const stmt = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  run: async () => { sqlite.prepare(sql).run(...(args as never[])); return { success: true } },
})
const d1 = {
  prepare: (sql: string) => stmt(sql),
  batch: async (s: { run: () => Promise<unknown> }[]) => { for (const x of s) await x.run() },
} as unknown as D1Database

const reports = sqlite.prepare(
  'select job_id, full_response_json from saved_reports where full_response_json is not null order by created_at',
).all() as { job_id: string; full_response_json: string }[]

let written = 0
for (const r of reports) {
  let response: Record<string, unknown> | null = null
  try { response = JSON.parse(r.full_response_json) } catch { continue }
  const items = (response?.comps as { items?: [] } | undefined)?.items
  written += await recordVerifiedFlips(d1, items, r.job_id, medianPpsfOf(response))
}
const tally = sqlite.prepare(
  'select state, confidence, flip_class, count(*) n from verified_flips group by state, confidence, flip_class order by state, confidence, flip_class',
).all()
console.log(`${reports.length} reports → ${written} flip sightings recorded`)
console.table(tally)
