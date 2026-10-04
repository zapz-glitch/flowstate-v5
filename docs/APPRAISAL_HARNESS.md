# Appraisal Harness — Set-B evaluator + tricks of the trade

The authoritative description of how the evaluator values a property.
Companion to `docs/APPRAISER-RULESET.md` (the product-engineer-approved
rules) and `SWE2_FLOWSTATE_FINISHING_GUIDE.md` (the operating contract).

**Change control.** Every valuation-related patch must name the rule in
this file it implements or repairs, and must show the acceptance cases
(`scripts/golden/appraiser-cases.json`) still pass. Editing this document
or the harness it describes requires the product engineer's explicit
approval. Address runs are evaluations only — never edits.

**Architecture.** One evaluator: `evaluateB` in
`packages/shared/src/appraisal/set-b.ts`, run server-side inside the
pipeline (`apps/api/src/services/evaluation/index.ts`). The dashboard
displays the server's result and may re-combine values the server already
assigned; it never appraises.

---

## 1. Evidence inputs (what the harness reads)

| Input | Source | Role |
|---|---|---|
| Sale price + date | provider sales data | The liquidity anchor — final price evidence |
| Square feet (tax) | provider | Size basis for rate + marginal adjustment |
| Census tract / block group | Census geocoder + Geocodio | Geo-tier matching |
| Subdivision / neighborhood | county GIS + provider | Closest tier (with value agreement) |
| `evidenceVerification` | price cross-check vs own AVM + pocket $/sf | corroborated / divergent / stale / above_pocket |
| `curbAppeal` (Clef) | listing photos + description | Condition INDICATION only — never verification |
| `classification` | flip chain, distressed sale, listing evidence | arv / as_is / transitional |
| `sqftEvidence` | marketed-vs-tax divergence + permit search | exclusion when unpermitted |
| Land fields | landAssessedValue, improvementAssessedValue, lot sf/acres, zoning | land rate + extraction |
| `listingDetails` / `physicalCharacteristics` | Redfin/Zillow listing pages | display + future per-comp feature adjustments |
| `adjustedPrice` | appraisal grid (user's settings preset) | contribution base |
| Subject: sqft, year, lot, tract, subdivision, land/improvement assessed, AVM, rehab level | provider + settings | subject profile |

---

## 2. Fixed policy — cannot change during a repair

1. **Geography tiers:** tract first, block group second, neighborhood/
   subdivision third. Widen only when the closer tier has nothing
   trustworthy. (Every same-BG comp is same-tract, so inside the tract
   tier, BG matches rank first.)
2. **Pocket rate:** a verified renovated comp on the subject's block
   group is the going ARV rate for that pocket and carries the most
   weight.
3. **Verification:** stale or divergent sales never set value.
4. **Price is the liquidity anchor:** the sale price confirms the band;
   condition labels are indications (≈80/20 price/condition weight).
   Clef also labels condition for the dashboard.
5. **Minimum 3 sales, reconciled:** no single-comp anchoring — 3–6 sales,
   most weight to the best comp (closest tier, verified condition, least
   adjustment). Thin tiers widen the search, not the standard.
   *Status: approved, not yet implemented — code anchors 1 + bounds the
   rest today.*
6. **Market area, not names:** same market area requires value agreement
   (pocket $/sf within ~15%), matching housing stock, and no physical
   boundary (major road, rail, water). Near-match subdivision names count
   only when values agree; divergent values disqualify even same names.
7. **Size integrity:** marketed-vs-tax sqft divergence with no permit →
   comp excluded from ARV evidence entirely.
8. **Distressed/as-is sales never drive ARV** — floor evidence only.
9. **AVM is display/research only:** zero influence on ARV, offers,
   confidence, or comp ranking. It is the last-resort floor, never
   evidence.
10. **Fallback order:** ARV → median-tier value → AVM → report-only.
11. **No invented adjustments:** every dollar change to a comp's evidence
    traces to a listed adjustment or exception path. Land contribution to
    a SFR is distinct from vacant-lot valuation; excess acreage is not
    priced proportionally.

## 3. Configurable settings — defaults and meaning

### 3a. User evaluation settings (appraisal preset, runs before Set-B)

Filters (hard = disqualifies, soft = similarity data):

| Filter | Default | Meaning |
|---|---|---|
| sale_age | 180d (soft ladder 365/548) | Max comp age; stretches in widen rung |
| sqft_diff | ±250 sf | Size band for grid pass |
| lot_size_diff | ±2,500 sf (soft) | Similarity signal, not disqualifier |
| subdivision_match / neighborhood_match | hard | Name match; not_verified ≠ fail |
| building_style / foundation / stories_match | hard | Verified mismatches disqualify; unverifiable data → not_verified |
| geo_scope_match, year_built, era windows | per settings | Normalizes Saint/St etc.; ≤1945 subjects use era window |

Adjustments (per-comp dollars applied to `adjustedPrice`):

| Adjustment | Default |
|---|---|
| bedroom | $15,000/room |
| bathroom | $10,000/room |
| pool | $10,000 |
| garage | $10,000 |
| carport | $5,000 |
| basement_sqft | 50% of area rate |
| foundation | 10% |
| traffic (fronting/backing/siding) | $10–15k / 10–20% over $500k |
| old_comp_discount | 15% beyond 90d |

### 3b. Set-B constants (`set-b.ts`, calibrated — approval required to change)

| Constant | Value | Meaning |
|---|---|---|
| `B_ADJ_CAP_PCT` | 0.25 | Gross-adjustment guard — wariness threshold |
| `B_OUTLIER_SUPPORT` | 2 | Verified supporters needed to exceed top sale |
| `B_SIM_GATE` | 0.60 | Drivers must score ≥60% of anchor's similarity (dense pools; thin pools use ladder) |
| `B_MIN_SIM` | 3.0 | Minimum similarity floor |
| `B_COND_MIN_CONF` | 30 | Clef confidence floor before a verdict counts |
| `B_LAND_FACTOR` / `B_LAND_CAP_PCT` | 0.35 / 0.20 | Per-parcel land fallback factor; ±20% land-adj cap |
| `B_REHAB_FRACTION` | Gut .95 / Heavy .85 / FullCos .75 / Light .45 / Lipstick .30 | Subject's completed scope share of the tier spread |
| Size band (rescue) | 0.5–1.75× (devalue: 0.33–3×) | Adjustable-size envelope vs subject |
| Marginal sqft rate | OLS pool slope (T1 tract ≥5 → T2 pool ≥5 → tapered ppsf fallback) | Prices size deltas at the pocket's own $/sf gradient |
| Land rate ladder | T1 same-tract vacant-sales median (≥2) → T2 same-tract assessed-curve slope (≥5 parcels) → T3 per-parcel assessed × .35 | Prices lot deltas; landAdj capped ±20% of sale |
| Land extraction | implied land = sale − improvement basis; basis = county split × mktRatio, else RCN model sqft×$110×(1−2%/yr, cap 80%) | Per-comp implied $/lot-sf |
| `land_play` gates | county improvement share <25%, OR extracted land ≥1.5× improved ARV, OR teardown condition + land > ARV | Otherwise emits land context only |
| Price bands | verified-pool $/sf terciles | floor / median / upper when no verdict — *approved change: band on size-adjusted price, pending* |
| Condition uplift | tier spread × rehab fraction (T1, ≥2 premium + median comps) else 80% of rehab cost (T2), min $1,000 — *approved change: market-gap first, 70% cost fallback, pending* | Median-tier anchor → as-repaired value |
| Stale time-adjust | stale sale repriced by 1/pocketRatio, capped 2× | Attempt-5 rung only |

## 4. Permitted judgment — subject-specific interpretation

Where the harness interprets evidence per subject, and what supports it:

- **Band placement:** Clef verdict preferred; when Clef can't classify,
  price position stands in. A verdict vs price disagreement by a full
  band resolves to price (rule 4).
- **Soft-disable rescue:** grid-disabled comps may compete when every
  disable reason is soft (not nominal/type mismatch), size is inside the
  band, the sale is corroborated or plausible, and the comp is same-side
  of the road barrier.
- **Anchor eligibility:** a comp with verified-different block group or
  verified-different subdivision bounds but can't anchor; sqft-conflicted
  comps can't anchor. Unknown geo does not disqualify — missing evidence
  can't fail a gate.
- **Self-heal:** when the anchor is the evidence floor (<80% of driver
  median), re-anchor to the anchorable comp nearest the driver median,
  preferring same-BG renovated.
- **Outlier ceiling:** ARV above the pool's top verified contribution
  only with ≥2 supporters at ≥60% of the pool-best similarity.
- **Land mode:** `land_play` labels the deal as the dirt; `land context`
  keeps extraction visible without the verdict.

## 5. Insufficient evidence — when the harness withholds valuation

- **T5 report-only:** no comp evidence and no anchor — no ARV is
  fabricated.
- **Insufficient-comps report:** saved with `valuation: null` +
  `comps.insufficientComps` when the pool can't support a defensible
  read. A ladder rung that produces a VERIFIED answer applies, flagged.
- **Sqft-unverifiable comps are excluded**, not guessed at.
- **Stale/divergent-only pools** devalue to median tier or report
  insufficient — they never drive ARV.
- **Unverified uplift:** when the condition adjustment can't be measured,
  ARV stands at the median-tier anchor and the flag says so.

## 6. The attempt ladder (truth loop)

```
1  initial evaluation — verified evidence drives
2  widen — +1mi radius, +6mo sale window; new comps re-eval + re-verify
3  deepen — backfill missing evidence fields (≤8 comps)
4  devalue — median-tier comps answer at relaxed size band
5  devalue + stale — time-adjusted stale sales admitted (repriced by
   pocket ratio, capped 2×)
final — unverified → T2 pocket-implied / T3 AVM floor / T4 assessed /
        T5 report-only
```

A verified ladder answer applies even when the original pool was
insufficient — the flag trail records which rung produced it.

## 7. Reconciliation (how the ARV is produced today)

1. Pool: enabled comps + rescued soft-disabled, sale + size required.
2. Contributions: `adjustedPrice + (subjectSqft − compSqft) × marginalRate`
   + land adjustment (capped ±20% of sale).
3. Unfit removal: sqft-excluded + stale/divergent evidence can't drive.
4. Drivers: upper-band comps (ARV evidence only).
5. Anchor: same-BG renovated comp if anchorable, else most-similar
   anchorable driver; similarity gate trims the driver set.
6. Supporting range: remaining drivers bound, not blend.
7. Condition uplift on all-median driver sets; outlier ceiling;
   bracketing and confidence grading on the result.

## 8. Known deltas — approved rules not yet in code

| Approved rule | Code today | Status |
|---|---|---|
| Min-3 reconciliation (rule 5/2.5) | Single anchor + bound support | pending |
| Size-adjusted banding | Raw-$/sf terciles (demotes big homes — Branchwood defect) | pending |
| No bed/bath + size double-count (rule 13) | Grid and marginal rate can stack | pending |
| Market-area values check (rule 14) | Name-match + BG gates only | pending |
| 70% rehab / market-gap uplift (rule 11) | 80% of rehab cost, no gap check | pending |
| Fallback-to-ranked[0] when nothing anchorable | Bypasses geo anchor gate (Branchwood) | pending repair |
| Tract→BG→neighborhood driver weighting | Similarity score partially encodes | pending |

## 9. Acceptance cases

`scripts/golden/appraiser-cases.json` — expected anchor, reconciled
comps, exclusions, and ARV range per address, derived by applying this
document as a top appraiser would. Current cases: Branchwood
($285–300k, Arrowood anchor) and Baywood ($315–345k, Lois primary).
Every valuation patch runs all cases; any regression outside a case's
range blocks the patch.
