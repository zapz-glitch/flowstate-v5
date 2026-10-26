/**
 * Set-B trick 12 — site match. A comp's lot premium (water) or lot
 * penalty (busy road / commercial) the subject doesn't share explains
 * THAT comp's price, not the subject's. Code decides from yes/no site
 * reads; an unknown read never knocks a comp out.
 * Test record: docs/SITE-READS-CLEF-TEST.md
 */
import assert from 'node:assert/strict'
import { evaluateB, type BComp, type BSubject } from '@flowstate-api/shared/appraisal'

const subject = (over: Partial<BSubject> = {}): BSubject => ({
  squareFeet: 1500,
  yearBuilt: 1990,
  censusTract: 'T1',
  subdivision: 'PINES',
  ...over,
})

const comp = (over: Partial<BComp> = {}): BComp => ({
  isEnabled: true,
  salePrice: 300_000,
  squareFeet: 1500,
  censusTract: 'T1',
  subdivision: 'PINES',
  distanceMiles: 0.2,
  yearBuilt: 1990,
  classification: { type: 'after_renovation' },
  ...over,
})

// Waterfront comp can't drive an inland subject while an inland comp exists.
{
  const water = comp({ address: 'water', salePrice: 380_000, site: { waterfront: true } })
  const inland = comp({ address: 'inland', site: { waterfront: false } })
  const r = evaluateB(subject({ site: { waterfront: false } }), [water, inland])
  assert.deepEqual(r.drivers.map((x) => x.comp.address), ['inland'])
  assert.equal(r.arv, 300_000)
  assert.ok(r.decisions?.some((d) => d.compAddress === 'water' && d.rule === 'site-match' && d.verdict === 'dropped'))
}

// Unknown read on either side is not a mismatch — the comp keeps driving.
{
  const unread = comp({ address: 'unread', salePrice: 310_000 })
  const inland = comp({ address: 'inland', site: { waterfront: false } })
  const r = evaluateB(subject({ site: { waterfront: false } }), [unread, inland])
  assert.deepEqual(r.drivers.map((x) => x.comp.address).sort(), ['inland', 'unread'])
  const r2 = evaluateB(subject(), [comp({ address: 'water', site: { waterfront: true } }), inland])
  assert.equal(r2.drivers.length, 2, 'subject unread — nothing to match against')
}

// Water + pool subject (7462 Water Silk Dr): no waterfront comp in the
// pool — the drivers stand and the gap is flagged, never a null ARV.
{
  const s = subject({ site: { waterfront: true, pool: true } })
  const a = comp({ address: 'a', site: { waterfront: false, busyRoad: false } })
  const b = comp({ address: 'b', salePrice: 310_000, site: { waterfront: false } })
  const r = evaluateB(s, [a, b])
  assert.equal(r.drivers.length, 2)
  assert.ok(r.arv != null)
  assert.ok(r.flags.some((f) => f.startsWith('site: no driver matches')))
}

// Pool is a small premium — a mismatch only ranks the comp lower, so the
// pool-matched comp anchors and the other stays a supporting driver.
{
  const s = subject({ site: { pool: false } })
  const withPool = comp({ address: 'pool', salePrice: 290_000, site: { pool: true } })
  const noPool = comp({ address: 'nopool', site: { pool: false } })
  const r = evaluateB(s, [withPool, noPool])
  assert.equal(r.anchorAddress, 'nopool')
  assert.equal(r.drivers.length, 2)
}

console.log('set-b site match: passed')
