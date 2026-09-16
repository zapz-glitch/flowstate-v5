/**
 * ml-export route regression: /v1/ml/ideal-reports
 *
 * Exercises cursor pagination, validated-only filtering, and response shape
 * against a minimal in-memory D1 shim that mirrors the route's SQL semantics.
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import mlExportRoute from '../src/routes/ml-export'

type Row = {
  id: string
  user_id: string
  job_id: string | null
  property_address: string
  property_city: string
  property_state: string
  property_zip: string | null
  feedback_status: string | null
  feedback_at: string | null
  feedback_notes: string | null
  created_at: string
  full_response_json: string | null
}

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    user_id: 'u1',
    job_id: `job_${id}`,
    property_address: '100 Main St',
    property_city: 'Austin',
    property_state: 'TX',
    property_zip: '78704',
    feedback_status: 'validated',
    feedback_at: '2026-09-10T00:00:00.000Z',
    feedback_notes: null,
    created_at: `2026-09-${id.slice(1).padStart(2, '0')}T00:00:00.000Z`,
    full_response_json: JSON.stringify({ subject: { id: `subj-${id}` }, comps: { items: [] } }),
    ...overrides,
  }
}

/** In-memory D1: mirrors the route's WHERE/ORDER/LIMIT semantics. */
function fakeDb(rows: Row[]) {
  return {
    prepare(sql: string) {
      const hasCursor = sql.includes('created_at > ?')
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              const userId = binds[0] as string
              const limit = binds[binds.length - 1] as number
              let out = rows.filter(
                (r) => r.user_id === userId && r.feedback_status === 'validated' && r.full_response_json != null,
              )
              if (hasCursor) {
                const [cAt, , cId] = binds.slice(1) as string[]
                out = out.filter((r) => r.created_at > cAt || (r.created_at === cAt && r.id > cId))
              }
              out.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
              return { results: out.slice(0, limit) }
            },
          }
        },
      }
    },
  }
}

function makeApp(rows: Row[]) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    ;(c as any).env = { DB: fakeDb(rows) }
    c.set('auth', { userId: 'u1' } as any)
    await next()
  })
  app.route('/v1/ml', mlExportRoute)
  return app
}

const rows: Row[] = [
  makeRow('r1'),
  makeRow('r2'),
  makeRow('r3'),
  makeRow('r4', { feedback_status: 'improve' }),       // excluded
  makeRow('r5', { full_response_json: null }),          // excluded
  makeRow('r6', { user_id: 'u2' }),                     // other user's — excluded
]

const app = makeApp(rows)

// ─── First page ──────────────────────────────────────────────────────────────
{
  const res = await app.request('http://x/v1/ml/ideal-reports?limit=2')
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.equal(body.success, true)
  assert.equal(body.reports.length, 2)
  assert.equal(body.reports[0].reportId, 'r1')
  assert.equal(body.reports[0].address, '100 Main St, Austin, TX')
  assert.equal(body.reports[0].report.subject.id, 'subj-r1')
  assert.ok(body.nextCursor, 'expected a next cursor')
}

// ─── Second page via cursor, then exhaustion ─────────────────────────────────
{
  const res1 = await app.request('http://x/v1/ml/ideal-reports?limit=2')
  const body1 = await res1.json() as any
  const res2 = await app.request(`http://x/v1/ml/ideal-reports?limit=2&cursor=${body1.nextCursor}`)
  const body2 = await res2.json() as any
  assert.equal(body2.reports[0].reportId, 'r3')
  assert.equal(body2.nextCursor, null)
}

// ─── Bad cursor → 400; non-validated rows never leak ─────────────────────────
{
  const res = await app.request('http://x/v1/ml/ideal-reports?cursor=garbage')
  assert.equal(res.status, 400)

  const all = await (await app.request('http://x/v1/ml/ideal-reports?limit=50')).json() as any
  const ids = all.reports.map((r: any) => r.reportId)
  assert.deepEqual(ids, ['r1', 'r2', 'r3'])
}

// ─── Malformed stored JSON is passed through as null, not a 500 ──────────────
{
  const badRows = [makeRow('r9', { full_response_json: '{corrupt' })]
  const res = await makeApp(badRows).request('http://x/v1/ml/ideal-reports')
  const body = await res.json() as any
  assert.equal(res.status, 200)
  assert.equal(body.reports[0].report, null)
}

console.log('ml-export.test.ts: all assertions passed')
