/**
 * Verified flips, pieces together — saved-report comps → flip rule → the
 * real migration SQL on SQLite. A repeat sighting bumps the row; a buy-leg
 * comp never lands.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { recordVerifiedFlips } from '../src/services/verified-flips'

// Minimal D1 over node:sqlite — prepare/bind/run/all/batch is all the
// recorder uses.
const sqlite = new DatabaseSync(':memory:')
sqlite.exec(readFileSync(new URL('../migrations/0046_verified_flips.sql', import.meta.url), 'utf8'))
const stmt = (sql: string, args: unknown[] = []) => ({
  bind: (...a: unknown[]) => stmt(sql, a),
  run: async () => { sqlite.prepare(sql).run(...(args as never[])); return { success: true } },
  all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
})
const d1 = { prepare: (sql: string) => stmt(sql), batch: async (s: { run: () => Promise<unknown> }[]) => { for (const x of s) await x.run() } } as unknown as D1Database

const items = [
  { id: '8717942', address: '4615 Webster St, Tampa, FL', salePrice: 299_000, saleDate: '2026-07-17', squareFeet: 910, yearBuilt: 1952,
    latitude: 27.99, longitude: -82.51, flip: { priorSalePrice: 150_000, priorSaleDate: '2025-11-20' } },
  { id: '143997388', address: '2927 Banza St, Tampa, FL', salePrice: 25_100, saleDate: '2025-12-29',
    flip: { priorSalePrice: 25_100, priorSaleDate: '2025-12-29' } },
  { id: '1', address: '7254 Landmark Dr, SPRING HILL, FL 34606', salePrice: 307_150, saleDate: '2026-03-19',
    flip: { priorSalePrice: 56_500, priorSaleDate: '2025-08-04' } },
  { id: '2', address: '100 No Flip Rd, Atlanta, GA', salePrice: 300_000, saleDate: '2026-05-01', flip: null },
]

assert.equal(await recordVerifiedFlips(d1, items, 'job_a'), 2)
const rows = sqlite.prepare('select * from verified_flips order by sell_price desc').all() as Record<string, unknown>[]
assert.deepEqual(rows.map((r) => [r.address, r.state, r.confidence, r.buy_price, r.sell_price, r.days_held]), [
  ['7254 Landmark Dr, SPRING HILL, FL 34606', 'FL', 'medium', 56_500, 307_150, 227],
  ['4615 Webster St, Tampa, FL', 'FL', 'high', 150_000, 299_000, 239],
])
assert.equal(rows[1].provider_id, '8717942')
assert.equal(rows[1].square_feet, 910)

// Same sale seen by a later run — one row, counted twice, last job updated.
assert.equal(await recordVerifiedFlips(d1, [items[0]], 'job_b'), 1)
const web = sqlite.prepare("select * from verified_flips where address like '4615 Webster%'").all() as Record<string, unknown>[]
assert.equal(web.length, 1)
assert.deepEqual([web[0].seen_count, web[0].first_job_id, web[0].last_job_id], [2, 'job_a', 'job_b'])

// Nothing verifiable → no write, no throw.
assert.equal(await recordVerifiedFlips(d1, [items[1], items[3], {}], 'job_c'), 0)
assert.equal(await recordVerifiedFlips(d1, null, 'job_d'), 0)

console.log('verified flips integration: passed')
