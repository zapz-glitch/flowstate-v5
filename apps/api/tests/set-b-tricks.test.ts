/**
 * Set-B tricks of the trade — executable proofs of the ship-time harness.
 *
 * Each block encodes one rule the way the A/B run earned it
 * (27 live addresses, B=26 / A=2, decision 2026-10-03 — port `5953349`,
 * retry loop `c0f7bcc`). The case in each comment is the address that
 * proved the rule on the scoreboard
 * (.data/ab-calibration/scoreboard.md). Full writeup:
 * docs/B-HARNESS-PLUS-TRICKS-OF-THE-TRADE.md
 *
 * These tests pin the harness that won. If a future change moves one of
 * these proofs, the change should be deliberate — read the cited case
 * before accepting the diff.
 */
import assert from 'node:assert/strict'
import {
  evaluateB,
  bCondTier,
  bTierOf,
  B_ADJ_CAP_PCT,
  B_OUTLIER_SUPPORT,
  B_LAND_FACTOR,
  B_LAND_CAP_PCT,
  B_RETAIL_BAND,
  B_SIM_GATE,
  B_MIN_SIM,
  B_COND_MIN_CONF,
  B_REHAB_FRACTION,
  type BComp,
  type BSubject,
} from '@flowstate-api/shared/appraisal'

const subject = (over: Partial<BSubject> = {}): BSubject => ({
  squareFeet: 1500,
  yearBuilt: 1990,
  censusTract: 'T1',
  subdivision: 'PINES',
  ...over,
})

// Default comp = a clean, same-pocket renovated sale: same tract, same
// subdivision, same size — a preferred ARV driver at similarity ~9.
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

// ── The calibrated constants are the contract ─────────────────────────────
assert.equal(B_ADJ_CAP_PCT, 0.25, 'trick 3 — >25% net adj halves the weight')
assert.equal(B_OUTLIER_SUPPORT, 2, 'trick 10 — one comp cannot stretch the answer')
assert.equal(B_LAND_FACTOR, 0.35)
assert.equal(B_LAND_CAP_PCT, 0.20)
assert.equal(B_RETAIL_BAND, 0.70)
assert.equal(B_SIM_GATE, 0.60, 'trick 7 — 60% of the anchor similarity')
assert.equal(B_MIN_SIM, 3.0)
assert.equal(B_COND_MIN_CONF, 30)
assert.deepEqual(B_REHAB_FRACTION, {
  'Full Gut': 0.95, 'Heavy Rehab': 0.85, 'Full Cosmetic': 0.75,
  'Light Cosmetic': 0.45, Lipstick: 0.30,
})

// ── Conclusion cascade — the harness never refuses outright ───────────────
// T5 report-only: nothing usable anywhere → null ARV, labeled
{
  const r = evaluateB(subject(), [])
  assert.equal(r.arv, null)
  assert.equal(r.source, 'T5 report-only')
}
// T4 assessed: no pool, no AVM → county estimate
{
  const r = evaluateB(subject({ assessedValue: 181_000 }), [])
  assert.equal(r.arv, 181_000)
  assert.equal(r.source, 'T4 assessed')
}
// T3 AVM floor: no pool → as-is AVM, explicitly "not ARV-tier"
{
  const r = evaluateB(subject({ avmValue: 250_000 }), [])
  assert.equal(r.arv, 250_000)
  assert.equal(r.source, 'T3 AVM floor')
  assert.equal(r.conf, 'low')
}
// T2 pocket tiers: ≥3 same-tract sales but none rule-enabled → the
// pocket's own sales classify into bands; thin pocket → cleaned median.
{
  const dead = (ppsf: number) => comp({
    isEnabled: false, disableReasons: ['property type mismatch'],
    salePrice: ppsf * 1500, squareFeet: 1500,
  })
  const r = evaluateB(subject(), [dead(180), dead(200), dead(220)])
  assert.equal(r.arv, 300_000) // 200/sf × 1500
  assert.ok(r.source.startsWith('T2 pocket-tiers'))
}
// Evidence-banded pocket: the renovated band carries the answer when it
// exists — curb read is the condition vote, not blind price thirds.
{
  const dead = (ppsf: number, opts: { cond?: string; cls?: string } = {}) => comp({
    isEnabled: false, disableReasons: ['property type mismatch'],
    salePrice: ppsf * 1500, squareFeet: 1500,
    curbAppeal: opts.cond ? { condition: opts.cond, confidence: 60 } : null,
    classification: opts.cls !== undefined ? { type: opts.cls } : null,
  })
  const r = evaluateB(subject(), [
    dead(140, { cls: 'transitional' }), dead(150, { cls: 'transitional' }), dead(160, { cls: 'transitional' }),
    dead(200, { cond: 'renovated' }), dead(210, { cond: 'renovated' }), dead(220, { cond: 'renovated' }),
  ])
  assert.equal(r.arv, 315_000) // renovated band median = 210/sf × 1500
  assert.equal(r.drivers.length, 3)
  assert.ok(r.flags.some((f) => f.includes('renovated')))
}
// Maintained band carries when nothing renovated exists — a real answer,
// not a floor.
{
  const dead = (ppsf: number) => comp({
    isEnabled: false, disableReasons: ['property type mismatch'],
    salePrice: ppsf * 1500, squareFeet: 1500,
    curbAppeal: { condition: 'maintained', confidence: 60 },
  })
  const r = evaluateB(subject(), [dead(140), dead(150), dead(160), dead(200), dead(210), dead(220)])
  assert.equal(r.arv, 315_000) // tight band evicts the <10%-off cheap end → carriers [200,210,220] → median 210/sf
}
// Cleaning: as-is-labeled and IQR outlier sales don't pollute the pocket.
{
  const dead = (ppsf: number, type?: string) => comp({
    isEnabled: false, disableReasons: ['property type mismatch'],
    salePrice: ppsf * 1500, squareFeet: 1500,
    classification: type ? { type } : null,
  })
  const r = evaluateB(subject(), [
    dead(170), dead(180), dead(185), dead(190), dead(200), dead(210), dead(220),
    dead(40, 'as_is'),   // bounded-low — excluded before the fence
    dead(900),           // IQR outlier — excluded by the fence
  ])
  assert.equal(r.arv, 285_000) // maintained band median = 190/sf; the 40 and 900 sales never touched it
  assert.ok(r.flags.some((f) => f.includes('dropped')))
}
// Dated/distressed pocket — no renovated or maintained inventory: the
// best curb-rated dated sales carry the reference.
{
  const dead = (ppsf: number, score: string) => comp({
    isEnabled: false, disableReasons: ['property type mismatch'],
    salePrice: ppsf * 1500, squareFeet: 1500,
    classification: { type: 'as_is' },
    curbAppeal: { condition: 'dated', confidence: 60, summary: `Dated (${score}/4)` },
  })
  const r = evaluateB(subject(), [
    dead(100, '1.5'), dead(110, '1.8'), dead(120, '2.9'),
    dead(130, '1.2'), dead(140, '2.0'), dead(150, '1.0'),
  ])
  assert.equal(r.arv, 210_000) // top two curb reads (2.9 → 120/sf, 2.0 → 140/sf); median 140 → $210k
}
// Maintained-band floor — an anchor below the band's median gets
// floored: a renovated product can't sell for less than maintained homes.
{
  const maintained = comp({ address: 'maint', salePrice: 300_000, distanceMiles: 0.4,
    classification: { type: 'transitional' },
    curbAppeal: { condition: 'maintained', confidence: 60 } })
  const maintained2 = comp({ address: 'maint2', salePrice: 295_000, distanceMiles: 0.4,
    classification: { type: 'transitional' },
    curbAppeal: { condition: 'maintained', confidence: 60 } })
  const weakArv = comp({ address: 'weak-arv', salePrice: 200_000, distanceMiles: 0.5,
    classification: { type: 'after_renovation' } })
  const r = evaluateB(subject(), [maintained, maintained2, weakArv])
  assert.equal(r.arv, 300_000) // anchor was ~200k — floored at the maintained band
  assert.ok(r.flags.some((f) => f.includes('below maintained band')))
}
// T1 lot-delta rescue (Ruskin — the cascade debut): killed ONLY on lot
// size, close, same pocket → rescued, flagged not modeled
{
  const rescued = comp({
    isEnabled: false, disableReasons: ['Lot size mismatch'],
    salePrice: 287_000, distanceMiles: 0.3,
  })
  const r = evaluateB(subject(), [rescued])
  assert.equal(r.arv, 287_000)
  assert.match(r.source, /^T1/)
  assert.ok(r.flags.some((f) => f.includes('rescued')))
}

// ── Trick 1: marginal sqft rate — 18810 Geraci Rd ─────────────────────────
// Flat proportional pricing invented $104k there. The marginal foot
// prices below the average and tapers as the gap grows.
{
  const r = evaluateB(subject({ squareFeet: 1900 }), [
    comp({ salePrice: 300_000, squareFeet: 1500 }), // $200/sf, 26.7% gap → taper 0.30
  ])
  // 300k + 400sf × $200 × 0.30 = 324k. Full-proportional: $380k.
  assert.equal(r.arv, 324_000)
}

// ── Trick 4: stale/divergent sales never drive — 7230 Toledo Rd ───────────
// A blended a $115k non-arm's-length "sale"; B excludes it from drivers.
{
  const junk = comp({
    address: '1 Junk Ln', salePrice: 115_000,
    evidenceVerification: { priceCheck: 'divergent', flags: ['sale price uncorroborated'] },
  })
  const good = comp({ address: '2 Good St', salePrice: 255_000, distanceMiles: 0.1 })
  const r = evaluateB(subject(), [junk, good])
  assert.equal(r.arv, 255_000, 'divergent sale must not drag or blend the answer')
  assert.equal(r.drivers.length, 1)
  assert.equal(r.drivers[0].comp.address, '2 Good St')
  assert.ok(r.flags.some((f) => f.includes('verification')))
}

// ── Trick 5: tier discipline — 4507 E 24th Ave, Tampa ─────────────────────
// An as-is-weighted pool yields an as-is value, not an ARV. Zero ARV-tier
// evidence → withhold, never average the floor.
{
  const a1 = comp({ salePrice: 120_000, classification: { type: 'as_is' } })
  const a2 = comp({ address: 'x', salePrice: 140_000, classification: { type: 'distressed' } })
  const r = evaluateB(subject(), [a1, a2])
  assert.equal(r.arv, null)
  assert.equal(r.conf, 'none')
  assert.ok(r.flags.some((f) => f.includes('no retail-priced evidence')))
}
// Unlabeled pool → the retail band: only sales ≥70% of the pool's top
// $/sf may drive; cheaper sales are excluded from ARV.
{
  const top = comp({ salePrice: 320_000, squareFeet: 1600, classification: null, distanceMiles: 0.1 })
  const mid = comp({ address: 'mid', salePrice: 255_000, squareFeet: 1700, classification: null })
  const low = comp({ address: 'low', salePrice: 180_000, squareFeet: 1500, classification: null })
  const r = evaluateB(subject(), [top, mid, low])
  assert.equal(r.arv, 310_000) // top comp, repriced to subject: 320k − 100sf × $200 × 0.5
  assert.equal(r.drivers.length, 2)
  assert.ok(!r.drivers.some((x) => x.comp.address === 'low'))
  assert.ok(r.flags.some((f) => f.includes('as-is-priced sale(s) excluded')))
}

// ── Trick 6: anchor, don't blend — 3814 E Cayuga St ───────────────────────
// A blended +31% above its own evidence. The most-similar verified comp
// sets ARV; the rest bound the range.
{
  const anchor = comp({ address: 'anchor', salePrice: 310_000, distanceMiles: 0.05 })
  const bound = comp({ address: 'bound', salePrice: 280_000, distanceMiles: 0.8 })
  const r = evaluateB(subject(), [anchor, bound])
  assert.equal(r.arv, 310_000, 'ARV is the anchor contribution, not an average')
  assert.equal(r.anchorAddress, 'anchor')
  assert.ok(r.flags.some((f) => f.includes('bound, not blended')))
}

// ── Trick 7: similarity gate — 331 Marie St ───────────────────────────────
// A far, cross-pocket comp with clean adjustments is still weak evidence:
// below 60% of the anchor's similarity it drops out entirely.
{
  const near = comp({ salePrice: 300_000 })
  // Sim ~3.8 — inside the driver floor (3.0) but under 60% of the
  // anchor's ~9.4, so the gate drops it.
  const far = comp({
    address: 'far', salePrice: 400_000, distanceMiles: 0.9,
    subdivision: 'ELSEWHERE', yearBuilt: 1975, squareFeet: 1750,
  })
  const r = evaluateB(subject(), [near, far])
  assert.equal(r.drivers.length, 1)
  assert.equal(r.drivers[0].comp.address, near.address)
  assert.equal(r.arv, 300_000)
  assert.ok(r.flags.some((f) => f.includes('dropped from drivers')))
}

// ── Trick 8: self-heal — 4000 Indianapolis St NE ──────────────────────────
// An anchor that is the floor of its own driver set was the cheapest
// product, not the best comp — re-anchor to the median contribution.
{
  const cheap = comp({ address: 'cheap', salePrice: 200_000 })
  const m2 = comp({ address: 'm2', salePrice: 320_000, distanceMiles: 0.5 })
  const m3 = comp({ address: 'm3', salePrice: 330_000, distanceMiles: 0.6 })
  const r = evaluateB(subject(), [cheap, m2, m3])
  assert.equal(r.healed, true)
  assert.equal(r.arv, 320_000) // median-contribution driver, not the 200k floor
  assert.equal(r.anchorAddress, 'm2')
  assert.ok(r.flags.some((f) => f.includes('self-heal')))
}

// ── Investor rule — no modeled condition uplift ───────────────────────────
// A median-tier anchor serves at face value. The old contributory path
// (rehab × 80%) priced a premium the pocket never proved — you can't exit
// on modeled value. If a renovated band exists it carries instead.
{
  const m1 = comp({
    address: 'm1', salePrice: 250_000, classification: null,
    curbAppeal: { condition: 'dated', confidence: 55 },
  })
  const m2 = comp({
    address: 'm2', salePrice: 240_000, classification: null, distanceMiles: 0.4,
    curbAppeal: { condition: 'dated', confidence: 55 },
  })
  const r = evaluateB(subject(), [m1, m2], { rehabCost: 50_000 })
  assert.equal(r.conditionAdj, null)
  assert.equal(r.arv, 250_000)                      // face value — no +$40k invented
  assert.ok(r.flags.some((f) => f.includes('no modeled uplift')))
}

// ── Band microscope — a driver >30% above the pocket's band is a
// suspected outlier: set aside, next-strongest evidence drives.
{
  const outlier = comp({ address: 'outlier', salePrice: 400_000 })
  const b1 = comp({ address: 'b1', salePrice: 250_000, distanceMiles: 0.3,
    curbAppeal: { condition: 'renovated', confidence: 60 } })
  const b2 = comp({ address: 'b2', salePrice: 255_000, distanceMiles: 0.35,
    curbAppeal: { condition: 'renovated', confidence: 60 } })
  const r = evaluateB(subject(), [outlier, b1, b2])
  assert.equal(r.arv, 255_000) // outlier set aside; self-heal picks the median-closest driver
  assert.ok(!r.drivers.some((x) => x.comp.address === 'outlier'))
  assert.ok(r.flags.some((f) => f.includes('suspected outlier')))
}

// ── Trick 2: marginal land ladder — per-parcel fallback ───────────────────
// No vacant sales, no ≥5-parcel curve → assessed delta × market ratio ×
// 0.35, capped at ±20% of the sale.
{
  const s = subject({ avmValue: 280_000, taxAssessment: 200_000, landAssessedValue: 60_000,
    lotSizeSquareFeet: 6_000 })
  const c = comp({ landAssessedValue: 40_000, lotSizeSquareFeet: 5_000 })
  const r = evaluateB(s, [c])
  // (60k − 40k) × 1.4 × 0.35 = $9,800 priced into the contribution —
  // and the outlier ceiling still holds a lone comp at its raw sale
  // (Woodcrest: uplift computed, capped without supporters).
  assert.equal(r.contribs[0].contrib, 309_800)
  assert.equal(r.arv, 300_000)
  assert.ok(r.flags.some((f) => f.includes('land adj')))
}

// ── Pool-derived slope (appraiser ladder) — 1311 21st Ave N ───────────────
// ≥5 verified same-tract comps → the fitted price~size slope prices the
// gap instead of the taper.
{
  const fit = [1400, 1500, 1600, 1700, 1800, 1900].map((sf, i) => comp({
    address: `fit${i}`, salePrice: 260_000 + i * 15_000, squareFeet: sf, distanceMiles: 0.2 + i * 0.05,
  }))
  const r = evaluateB(subject({ squareFeet: 2000 }), fit)
  assert.ok(r.sqftRateSource?.includes('pool slope'), `slope source: ${r.sqftRateSource}`)
  // slope $150/sf; anchor = 1900sf comp: 335k + 100 × 150 = 350k
  assert.equal(r.arv, 350_000)
}

// ── Bracket + confidence ──────────────────────────────────────────────────
// All-smaller driver set → no size bracket → flagged, confidence low.
{
  const r = evaluateB(subject({ squareFeet: 2000 }), [
    comp({ squareFeet: 1400, salePrice: 280_000 }),
    comp({ address: 'b', squareFeet: 1500, salePrice: 300_000, distanceMiles: 0.3 }),
  ])
  assert.equal(r.bracket, 'all-smaller')
  assert.equal(r.conf, 'low')
}

// ── URAR ceiling — >25% total adjustment means bound, not driver ─────────
// The comp can still sit in the evidence pool (and the ceiling), but it
// can never anchor or support — even when it would have been preferred.
{
  const over = comp({ address: 'over', salePrice: 300_000,
    appraisalRules: { totalAdjustment: 90_000 } }) // 30% of sale > 25% cap
  const clean = comp({ address: 'clean', salePrice: 280_000, distanceMiles: 0.3 })
  const r = evaluateB(subject(), [over, clean])
  assert.ok(!r.drivers.some((x) => x.comp.address === 'over'))
  assert.ok(r.contribs.some((x) => x.comp.address === 'over' && x.boundOnly))
  assert.ok(r.flags.some((f) => f.includes('bound, not a driver')))
  assert.equal(r.arv, 280_000) // the clean comp drives alone
}

// ── Geo hierarchy — tract first, block group second, neighborhood third ───
// Owner decision (findings log, 2026-10-04): the class pick looks for
// tract matches first, in every phase. A closer sale across the tract
// line cannot out-drive a same-tract sale.
{
  // inTract is LESS similar (farther, different subdivision) but in-pocket;
  // cross is nearer and pricier but outside every tier.
  const inTract = comp({
    address: 'tract', salePrice: 300_000, distanceMiles: 0.9,
    subdivision: 'OTHER SUB',
  })
  const cross = comp({
    address: 'cross', salePrice: 340_000, distanceMiles: 0.02,
    censusTract: 'T9', subdivision: 'ELSEWHERE',
  })
  const r = evaluateB(subject(), [inTract, cross])
  assert.equal(r.drivers.length, 1)
  assert.equal(r.drivers[0].comp.address, 'tract')
  assert.equal(r.arv, 300_000)
  assert.ok(r.flags.some((f) => f.includes('outside the tract scope')))
}
// block group wins when no tract driver exists; neighborhood name third.
{
  const bg = comp({ address: 'bg', salePrice: 310_000, censusTract: 'T9',
    sameBlockGroup: true, subdivision: 'ELSEWHERE' })
  const hood = comp({ address: 'hood', salePrice: 330_000, censusTract: 'T8',
    sameBlockGroup: false })
  const out = comp({ address: 'out', salePrice: 350_000, censusTract: 'T7',
    sameBlockGroup: false, subdivision: 'NOWHERE' })
  const r = evaluateB(subject(), [bg, hood, out])
  assert.equal(r.drivers.length, 1)
  assert.equal(r.drivers[0].comp.address, 'bg')
  assert.equal(r.arv, 310_000)
}

// ── Condition tier read — the confidence floor ────────────────────────────
assert.equal(bCondTier(comp({ curbAppeal: { summary: 'tier:median' } })), 'median',
  'tier token beats the condition field')
assert.equal(bCondTier(comp({ curbAppeal: { condition: 'renovated', confidence: 20 } })), 'unknown',
  'below the confidence floor a stamp neither upgrades nor downgrades')
assert.equal(bCondTier(comp({ curbAppeal: { condition: 'updated', confidence: 80 } })), 'renovated')
assert.equal(bCondTier(comp({ curbAppeal: { summary: 'tier:luxury' } })), 'premium')
assert.equal(bTierOf(comp({ classification: { type: 'after_renovation' } })), 'arv')
assert.equal(bTierOf(comp({ classification: { type: 'distressed' } })), 'as_is')
assert.equal(bTierOf(comp({ classification: null })), 'unidentified')

console.log('set-b tricks: ship-time harness proofs passed — constants, cascade, marginal rates, verification, tier discipline, anchoring, gate, heal, uplift, ceiling, bracket')
