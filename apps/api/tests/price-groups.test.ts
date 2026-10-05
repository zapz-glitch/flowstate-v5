/**
 * Price group proofs (docs/FILTER-LADDER.md).
 *
 * 1. A pocket's sales fall into groups at the natural breaks in $/sf.
 * 2. Three or four sales are enough to see groups.
 * 3. Evenly spread sales show no pattern — one group, nobody is "top".
 * 4. A lone sale far above the pocket is an outlier, not the top group.
 * 5. A lone top sale stands when it is vouched for (flip / renovated read).
 * 6. No percentage of any AVM or median is involved — only the sales.
 */
import assert from 'node:assert/strict'
import { groupPocketSales } from '../src/services/evaluation/price-groups'

const sales = (...ppsf: number[]) => ppsf.map((p, i) => ({ id: `c${i}`, ppsf: p }))
const of = (r: ReturnType<typeof groupPocketSales>, ...ids: string[]) => ids.map((id) => r.groups.get(id))

// 1 — three clear clusters: investor, dated, renovated
{
  const r = groupPocketSales(sales(90, 95, 100, 150, 155, 160, 230, 240, 245))
  assert.equal(r.groupCount, 3)
  assert.deepEqual(of(r, 'c0', 'c1', 'c2'), ['bottom', 'bottom', 'bottom'])
  assert.deepEqual(of(r, 'c3', 'c4', 'c5'), ['middle', 'middle', 'middle'])
  assert.deepEqual(of(r, 'c6', 'c7', 'c8'), ['top', 'top', 'top'])
  assert.deepEqual(r.topRange, { lo: 230, hi: 245 })
}

// 2 — four sales, two clusters: the top pair is the renovated group
{
  const r = groupPocketSales(sales(140, 150, 250, 262))
  assert.equal(r.groupCount, 2)
  assert.deepEqual(of(r, 'c0', 'c1', 'c2', 'c3'), ['middle', 'middle', 'top', 'top'])
}
// three sales still show a group
{
  const r = groupPocketSales(sales(140, 245, 250))
  assert.deepEqual(of(r, 'c0', 'c1', 'c2'), ['middle', 'top', 'top'])
}

// 3 — evenly spread: no pattern, nobody is top just for being highest
{
  const r = groupPocketSales(sales(100, 110, 120, 130, 140, 150))
  assert.equal(r.groupCount, 1)
  assert.ok([...r.groups.values()].every((g) => g === 'middle'), 'being the highest sale is not a class')
  assert.equal(r.topRange, null)
}

// 4 — a lone sale far above the pocket is an outlier; the pattern is re-read without it
{
  const r = groupPocketSales(sales(140, 150, 250, 262, 1019))
  assert.ok(r.outliers.has('c4'), '$1019/sf standing alone is noise')
  assert.equal(r.groups.get('c4'), undefined)
  assert.deepEqual(of(r, 'c2', 'c3'), ['top', 'top'], 'the real renovated pair is still the top group')
}

// 5 — a lone top sale that is vouched for (a flip, a renovated read) stands
{
  const r = groupPocketSales(sales(140, 145, 150, 250), new Set(['c3']))
  assert.equal(r.outliers.size, 0)
  assert.equal(r.groups.get('c3'), 'top')
}
// …and without the voucher the same sale is set aside
{
  const r = groupPocketSales(sales(140, 145, 150, 250))
  assert.ok(r.outliers.has('c3'))
}

// edges — missing or bad prices are never grouped; tiny pockets do not crash
assert.equal(groupPocketSales([]).groupCount, 0)
assert.equal(groupPocketSales(sales(200)).groups.get('c0'), 'middle')
{
  const r = groupPocketSales([{ id: 'a', ppsf: null }, { id: 'b', ppsf: 0 }, { id: 'c', ppsf: 150 }, { id: 'd', ppsf: 250 }, { id: 'e', ppsf: 255 }])
  assert.equal(r.groups.has('a'), false)
  assert.equal(r.groups.has('b'), false)
  assert.equal(r.groups.get('e'), 'top')
}
// deterministic regardless of input order
{
  const a = groupPocketSales(sales(90, 95, 150, 155, 240, 245))
  const b = groupPocketSales(sales(90, 95, 150, 155, 240, 245).reverse())
  assert.deepEqual([...a.groups].sort(), [...b.groups].sort())
}

console.log('price-groups: all proofs passed')
