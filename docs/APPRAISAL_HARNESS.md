# Appraisal Harness — current Set-B evaluator

This document describes the implementation in this branch. The product rule
record is `docs/APPRAISER-RULESET.md`. The operating contract is
`SWE2_FLOWSTATE_FINISHING_GUIDE.md`.

`packages/shared/src/appraisal/set-b.ts` is the valuation engine. The API
pipeline builds the evidence, records every attempt, and saves the result.
The dashboard renders and edits evidence selection; it does not calculate a
second valuation.

## 1. Evidence inputs

| Input | Source | Role |
|---|---|---|
| Sale price/date | Provider sales data | Final transaction evidence |
| Square feet, year, lot, property type | Provider/listing evidence | Comparability and adjustments |
| Census tract / block group | Census geocoder + provider | Pocket membership |
| Subdivision / neighborhood | Provider/listing | Market-area evidence |
| `evidenceVerification.staleness` | Sale date vs preferred `sale_age` | `current` / `stale` / `unverified` |
| `evidenceVerification.marketFit` | Comp sale $/sf vs its pocket reference | `in_range` / `below_pocket` / `above_pocket` / `unverified` |
| `evidenceVerification.priceCheck` | Sale price vs the comp's own AVM | `corroborated` / `plausible` / `divergent` / `unverified` |
| `evidenceVerification.transactionCheck` | Nominal + same-day same-price package-deed screen | `clean` / `package_deed` / `nominal_sale` / `unverified` |
| Rural market reference | Subject AVM → same-scope comp AVMs → subject scope medians | Required before an adjacent pocket can pass |
| `curbAppeal` | Clef/Luna listing evidence | Structured condition signal, confidence-gated |
| `classification` | Flip/distress/transaction evidence | `arv` / `as_is` / `transitional` |
| `adjustedPrice` | User appraisal rules | Contribution base |
| Subject profile | Provider + applied settings | Sqft, year, lot, geography, condition scope, floor values |

## 2. Evidence screen

Before a comp may drive ARV, Set-B removes unfit evidence from the driver
pool:

- `staleness: stale` — sale date is outside the preferred sale-age window.
- `marketFit: below_pocket` — sale is too far below the comp's own pocket.
- `marketFit: above_pocket` — premium sale cannot drive unless renovated or
  premium condition/class evidence explains it.
- `priceCheck: divergent` — recorded sale conflicts with the comp's own AVM.
- `transactionCheck: package_deed` or `nominal_sale` — not independent
  market evidence.

The comp remains in the trace and report. It just cannot set value.

At wide geography tiers, a comp inside the subject's own scope stays eligible
under the normal rules. A comp in an adjacent scope must prove it belongs to
a similar market: the closest adjacent block-group/tract/neighborhood groups
are checked first, no more than five groups are searched, and the comp needs
a value reference within 15% of the subject pocket reference.

## 3. Pool and contributions

1. Enabled comps with sale price and size form the first pool.
2. The land rate is measured from the pool where possible: same-tract vacant
   sales, same-tract assessed curve, then capped per-parcel fallback.
3. The size rate is measured from fit same-tract comps, then fit pool comps.
   If no reliable slope exists, a tapered $/sf share handles the size gap.
4. Each comp contributes `adjustedPrice + size delta + land delta`.
5. A total adjustment above 25% is downweighted and flagged.
6. Stale, divergent, poor market-fit, package-deed, and nominal-sale
   evidence stays out of the verified driver pool.

## 4. Driver and anchor selection

1. ARV-tier comps with non-median/non-distressed condition and minimum
   similarity drive first.
2. If none qualify, confident median-condition comps drive.
3. If no median set exists, low-similarity ARV comps fall back.
4. If still none, unidentified/non-as-is comps inside the retail band may
   drive.
5. Only as-is/distressed evidence means ARV is withheld.

Inside the selected set:

- The most similar driver is the anchor.
- Other drivers bound the answer; they are not averaged into it.
- Drivers under 60% of the anchor's similarity score are dropped.
- If the anchor is the floor of its own driver set, self-heal re-anchors to
  the median driver.

## 5. Condition and ceiling

- A structured `distressed`/`needs_work` read is always distressed.
- A structured condition below `B_COND_MIN_CONF` stays `unknown`.
- Confident structured condition beats old `tier:*` text.
- Old `tier:*` text remains only as a fallback when no structured condition
  exists.
- If all drivers are median, the market premium-vs-median spread may adjust
  ARV. If that spread cannot be measured, the median anchor stands.
- An ARV above the top verified contribution needs enough supporting
  drivers; otherwise it is capped.
- All-smaller or all-bigger driver sets are flagged as unbracketed.

## 6. Retry ladder

The current pipeline records every attempt in the immutable run record:

1. `attempt 1` — evaluate the frozen comp set.
2. `attempt 2 widen` — fetch a larger radius/window, evaluate new comps
   through the same grid, restamp evidence, rerun Set-B.
3. `attempt 3 deepen` — backfill missing AVM/land fields, restamp evidence,
   rerun Set-B.
4. Final — if the best result still fails verification, the process is
   marked unverified and the labeled floor/result stands.

No devalue or stale-reprice rung exists in the current harness.

## 7. Result and process labels

Result grade:

- `verified` — at least three drivers with usable verification evidence and
  no rescue/weak source.
- `weak` — thin, rescued, low-confidence, or soft evidence.
- `floor` — non-comp floor sources such as pocket-implied, AVM, assessed, or
  nearest-comp fallback.
- `withheld` — no defensible ARV.

Process grade:

- `clean` — attempt 1 passed the current checks.
- `retried` — a later verified attempt produced the answer.
- `unverified` — the trail ended without verification.

Process grade does not claim record integrity. The run-record hash and
archive fields are checked separately.

## 8. Persistence and replay

- `run_records` is append-only. Every run/rerun stores request, rules,
  evidence, attempts, response, hashes, model/provider context, and archive
  status.
- `report_outcomes` stores actual later sale outcomes separately from the
  prediction.
- `scripts/replay.mts` reads run records first, verifies payload hash,
  replays the last saved Set-B attempt, and compares the full result.
- `npm run replay:snapshots` is the strict local gate over
  `fixtures/snapshots/*.json`.
- The candidate workflow runs the same strict snapshot replay.
- Evaluation-result cache keys include `HARNESS_VERSION`.

## 9. Known open work

- Broader bulk-sale detection beyond same-day same-price package deeds.
- More frozen fixtures for rural, withheld, distressed, and failure paths.
- Independent auditor exists for the record/evidence contract; deeper
  policy coverage remains open.
- Browser/server parity after Claude's UI work finishes.
