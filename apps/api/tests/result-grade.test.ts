import assert from 'node:assert/strict'
import { gradeResult } from '../src/services/analysis/result-grade'

/**
 * Result grade — the run-level label, separate from comp classification.
 * verified = comp-anchored + clean process; weak = answered on soft
 * evidence (rescue rungs, median-only, thin drivers); floor = non-comp
 * evidence (pocket-implied / AVM / assessed / nearest); withheld =
 * harness refused.
 */

const verifiedDriver = {
  comp: {
    salePrice: 300000,
    squareFeet: 1200,
    evidenceVerification: { staleness: 'fresh', priceCheck: 'corroborated' },
  },
}
const clean = { source: 'T0 anchor', conf: 'medium' as const, drivers: [verifiedDriver, verifiedDriver, verifiedDriver], flags: [], arv: 300000 }

// verified — comp anchor, attempt 1 clean
{
  const g = gradeResult({ ...clean, conf: 'high' }, 'none', ['attempt 1 — verified'])
  assert.equal(g.resultGrade, 'verified')
  assert.equal(g.processGrade, 'clean')
}

// weak — comp anchor but needed rescue rungs
{
  const g = gradeResult({ ...clean }, 'geographic_expansion', ['attempt 1 — verified'])
  assert.equal(g.resultGrade, 'weak')
  assert.equal(g.processGrade, 'clean')
}

// weak — median-only evidence paths
{
  const g = gradeResult({ source: 'median+50% AVM uplift', conf: 'low', drivers: [{}, {}, {}], flags: [], arv: 300000 }, 'none', ['attempt 1 — verified'])
  assert.equal(g.resultGrade, 'weak')
}

// weak — single-comp driver
{
  const g = gradeResult({ source: 'T0 anchor', conf: 'low', drivers: [verifiedDriver], flags: [], arv: 300000 }, 'none', ['attempt 1 — verified'])
  assert.equal(g.resultGrade, 'weak')
}

// weak — drivers exist but their verification evidence is absent/stale
{
  const stale = {
    comp: {
      salePrice: 300000,
      squareFeet: 1200,
      evidenceVerification: { staleness: 'stale', priceCheck: 'corroborated' },
    },
  }
  const g = gradeResult({ source: 'T0 anchor', conf: 'medium', drivers: [stale, stale, stale], flags: [], arv: 300000 }, 'none', ['attempt 1 — verified'])
  assert.equal(g.resultGrade, 'weak')
}

// floor — pocket-implied / AVM / assessed / nearest-comps
{
  for (const source of ['T2 pocket-implied', 'T3 AVM floor', 'T4 assessed']) {
    const g = gradeResult({ source, conf: 'low', drivers: [], flags: [], arv: 300000 }, 'none', [])
    assert.equal(g.resultGrade, 'floor', source)
  }
  const assessed = gradeResult({ source: 'T4 assessed', conf: 'none', drivers: [], flags: [], arv: 300000 }, 'none', [])
  assert.equal(assessed.resultGrade, 'floor', 'assessed values stay floor, not withheld')
  const g = gradeResult({ ...clean }, 'nearest_comps', [])
  assert.equal(g.resultGrade, 'floor')
}

// withheld
{
  const g = gradeResult({ source: 'T0 anchor', conf: 'none', drivers: [], flags: [], arv: null }, 'insufficient', [])
  assert.equal(g.resultGrade, 'withheld')
}

// process grades
{
  const g = gradeResult(clean, 'none', ['attempt 2 widen: +3 comp(s) — verified'])
  assert.equal(g.processGrade, 'retried')
}
{
  const g = gradeResult(clean, 'none', ['final — unverified (thin pool)'])
  assert.equal(g.processGrade, 'unverified')
}

console.log('result-grade: verified/weak/floor/withheld + process grades passed')
