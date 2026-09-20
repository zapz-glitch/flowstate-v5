# Jev Comp Price Classification — Baseline A vs Candidate B

Status: Candidate B implemented behind flags, **shadow mode default-on, NOT promoted**.
Production routing is unchanged: Baseline A remains authoritative.

Flags (env):

| Flag | Default | Effect |
|---|---|---|
| `JEV_COMP_CLASSIFIER_V2_ENABLED` | unset → false | `'true'` → Candidate B controls comp routing |
| `JEV_COMP_CLASSIFIER_V2_SHADOW` | unset → true | `'false'` → B does not run at all |

`compClassifierMode(env)` → `'enabled' | 'shadow' | 'off'` (`apps/api/src/services/jev/index.ts`).

---

## 1. Current architecture (Baseline A), as found

**Comp candidate generation.** `routes/analyze.ts` prefetches a `PropertyBundle` via the
property provider (CoreLogic primary, ATTOM fallback): subject + raw sold candidates
(radius/recency pulled from retrieval policy, up to ~100 candidates, expansion refetch
when the pool is thin). Comps are normalized to `NormalizedComparable` and enriched
per-comp (building detail, transaction facts, Zillow reconciliation → `saleReconciled`,
`flip`, `transaction.*`).

**Deterministic appraisal gate.** `AppraisalService` (`services/appraisal/index.ts`)
evaluates every candidate with `evaluateComparable` — the configured filter rows
(property type, sqft/year/beds/baths tolerance, sale age tiers, subdivision/neighborhood,
distance, construction material, major roads, …) at each row's priority (hard/soft),
plus adjustments producing `adjustedSalePrice`. Result per comp:
`evaluation.shouldDisable` (hard-priority failure), `filterResults`, `disableReasons`,
`isEnabled`, `arvStatus`.

**`scoreCompTruthWithJev`** (`services/jev/index.ts`). Every candidate gets TWO noul
questions — `comp_N_arv_truth` ("reliable evidence of the subject's after-renovation
retail value") and `comp_N_investment_truth` ("as-is investor value"). State: subject
facts + `compTruthEvidence` per comp + appraisal rules + evaluation date. Batching:
`truthBatches` packs comps until the serialized body exceeds the byte budget
(`TRUTH_STATE_AND_QUESTION_BYTES` inside a global `REQUEST_BYTES`); batches run
sequentially; model must match across batches; input tokens summed. Response envelope
is strictly validated; any malformed answer fails the whole batch (throws → caller
falls back to rules selection).

**Argmax routing** (`services/evaluation/index.ts`). Per comp, **strict `>` both
ways** — an exact tie enters NEITHER pool:

```
arvTruth > investmentTruth  → ARV bucket candidate
investmentTruth > arvTruth  → AS-IS bucket candidate
equal                       → NEITHER (isEnabled stays false)
```

Both filtered by the comp-classification eligibility gate — now the shared predicate
`compClassifierEligible(comp)`: `distanceMiles ≤ 0.5` AND `!evaluation.shouldDisable`.
(Soft failures and `not_verified` never disqualify; verified mismatches do.)

**Downstream deterministic stages after Jev routing** (unchanged for B): the
`arv_condition_gate` prunes ARV-pool comps verified below ARV spec (negative
assessor condition or vision-verified negative curb appeal) and recomputes ARV
when ≥3 remain; Group B then sqft-scales the as-is pool and folds in verified
flip priorSales from the whole evaluated pool.

- `jevArvIds` non-empty → `isEnabled = in either bucket`, `arvStatus` updated,
  `selectedCompIds = arvIds`, `arv = calculateARV(arv pool)` (mean of
  `adjustedSalePrice ?? salePrice`).
- `jevArvIds` empty → **rules selection stands** (empty bucket ≠ insufficient).
- Jev throws → rules selection stands (`jev_selection:unavailable` fallback).
- `jevInvestmentCompIds` feeds Group B (`summarizeGroupB`: sqft-scaled mean sale
  price + verified flip priorSales) → `valuation.asIsMarketIntel` (display intel).

**Storage/display.** Per-comp `jevArvTruth`/`jevInvestmentTruth` project onto response
items; comp cards render `A·0.44`/`I·0.28` chips + ARV/AS-IS bucket chips. Read-only
`jevOutcome` (5 choice dimensions + noul drivers) attaches post-response.

## 2. Candidate B data flow

```
RAW CANDIDATES → appraisal gate (unchanged) → compClassifierEligible (shared
predicate: ≤0.5mi, not shouldDisable) → classifyCompPriceWithJev → per comp ONE
Choice question comp_N_price_classification {ARV, AS_IS, UNIDENTIFIED} →
routeCompPriceClasses → {arvIds, asIsIds} disjoint sets → existing valuation math
```

- **Shadow (default):** runs after Baseline A; attaches `jevPriceClassification`
  per comp + `jevCompClassification` run metadata on the response. Never touches
  `isEnabled`, `arvStatus`, `selectedCompIds`, ARV, Group B, offers, or
  recommendation.
- **Enabled:** Baseline A is not run; B's sets drive the same downstream code path
  (`calculateARV`, `summarizeGroupB`) with identical empty-ARV-pool fallback to the
  rules selection. Under v2 the `jevArvTruth`/`jevInvestmentTruth` card chips carry
  `P(ARV)`/`P(AS_IS)` so the existing UI contract is preserved.

## 3. Exact code changes

| File | Change |
|---|---|
| `apps/api/src/services/jev/index.ts` | `COMP_PRICE_CLASSES`, `COMP_PRICE_QUESTION_VERSION`, `JevCompPriceClass`, `JevCompPriceResult`, `JevCompClassificationRun`, `compClassifierEligible` (shared gate), `compClassifierMode` (flags), `routeCompPriceClass(es)` (routing), `compPriceEvidence`/`priceClassQuestion`/`priceClassBatches`/`parsePriceClassResponse`/`classifyCompPriceWithJev`, `truthFits` widened to `Question` union |
| `apps/api/src/services/appraisal/types.ts` | `AppraisedComparable.jevPriceClassification` |
| `apps/api/src/services/evaluation/index.ts` | Restructured Jev block: `enabled` → B production; else Baseline A (unchanged logic, shared gate predicate) + optional `shadow` B run; `compTruthRun`/`compClassificationRun` metadata |
| `apps/api/src/services/analysis/index.ts` | `jevCompTruth`, `jevCompClassification` on `AnalysisResponse`; `jevPriceClassification` on comp items |
| `apps/api/src/types.ts` | `JEV_COMP_CLASSIFIER_V2_ENABLED`, `JEV_COMP_CLASSIFIER_V2_SHADOW` on `Env` |
| `apps/dashboard/.../actions.ts` | mirrored types only — no UI change |
| `apps/api/tests/jev-comp-classifier.test.ts` | new invariant suite |
| `scripts/ab-comp-classifier.mjs` | new A/B measurement harness |

## 4. Structured Choice schema

One question per eligible comp, `comp_{i}_price_classification`:

```ts
{ type: 'choice',
  instructions: '…already passed Flowstate's deterministic appraisal rules…
    classify by sale-price position within qualified local comparable evidence…
    photographs unavailable — do not infer renovation quality… do not re-evaluate
    appraisal rules… do not force ARV or AS_IS… mutually exclusive, pick one',
  criteria: { ARV: '…renovated/retail-ready price regime…',
              AS_IS: '…dated/distressed/investor/as-is pricing…',
              UNIDENTIFIED: '…cannot reliably distinguish… use when sparse/
                ambiguous/conflicting; not for weak guesses' } }
```

## 5. Structured state passed to JEV (per batch)

```
state.subject          — subject facts (address, beds/baths, sqft, yearBuilt, type…)
state.eligibleMarket   — {eligibleCount, salePrice/pricePerSqft/adjustedSalePrice
                          quartiles over the eligible pool}
state.appraisalRules   — the configured ruleset (context, not verdict)
state.evaluationDate
state.comparables[]    — per eligible comp:
    comp facts (price, date, $/sqft, beds/baths, sqft, yearBuilt, type, distance,
              subdivision, geo, condition/grade, construction, features, enriched)
    transaction      — cash/foreclosure/short-sale/interfamily/investor/corporate flags
    flip             — verified prior-sale record
    saleReconciled   — price/date corrected to newer Zillow sale
    adjustedSalePrice
    pricePercentileAmongEligible, pricePerSqftPercentileAmongEligible (self-excluded)
    ruleEvidence     — failed/passed filter types, totals, original/adjusted price
questions.comp_N_price_classification ×1 per comp
```

## 6. Why each input is non-circular

Every field is a provider/assessor/transaction-record fact or deterministic rule
output — none derives from any classification or valuation result:

- raw sale price / $/sqft / date — recorded sale facts
- `adjustedSalePrice`, `ruleEvidence` — deterministic appraisal math on inputs
  (computed before any Jev call)
- eligible-pool percentiles — raw sale prices of gate-passed candidates only
- transaction flags, flip, saleReconciled — recorded transaction facts
- buildingCondition/Grade — assessor records (the only condition evidence;
  photos are unavailable by design)

**Deliberately excluded:** `jevArvTruth`/`jevInvestmentTruth` (Baseline A's own
outputs would leak its answer), final ARV, AS-IS estimate, offers, and anything
computed from the classification — feeding those back would be circular. A test
asserts their absence from `state.comparables`.

## 7. Tests added

`apps/api/tests/jev-comp-classifier.test.ts` — all spec §11 invariants:

- flag matrix (default shadow, `SHADOW=false`→off, `ENABLED=true`→enabled)
- gate predicate semantics (hard fail / >0.5mi excluded; soft fail eligible)
- gate-before-JEV: only eligible ids appear in `state.comparables`
- one `choice` question per comp, exactly the 3 criteria, never score/noul
- no circular fields in comp evidence
- ARV↛AS-IS, AS_IS↛ARV, UNIDENTIFIED→neither, no comp in both pools
- missing/malformed/unknown-choice answers → UNIDENTIFIED (fail closed)
- envelope/model/HTTP/timeout/no-key errors → throw (caller falls back)
- retried/duplicate responses can't duplicate comps (id-keyed map + Sets)
- probabilities/confidence recorded but never used in routing

## 8. A/B harness

`scripts/ab-comp-classifier.mjs --reports <dir> [--labels labels.json] [--json out]`

Replays saved shadow-mode reports: reconstructs A's pools from the stored truth
fields (strict argmax, same gate), B's pools from `jevPriceClassification`, and
recomputes ARV/as-is with the production formulas. Without `--labels` it reports
coverage/forcing, agreement, downstream deltas, and ops cost — **accuracy,
contamination, and calibration require human labels and are never fabricated**.

## 9. Live shadow runs (2 Sarasota reports, 18 eligible comps)

| Metric | Baseline A | Candidate B |
|---|---|---|
| ARV pool | 15 | 11 |
| AS_IS pool | 2 | 5 |
| Unrouted (A tie / B UNIDENTIFIED) | 1 | 2 |
| Forced-classification rate | 94.4% | 88.9% coverage |
| A↔B routing agreement | — | 66.7% |
| Recomputed ARV (gate-mirrored) | $430,942 / $456,397 | $437,638 / $485,353 |
| Recomputed as-is intel | $314,612 / $250,503 | $324,985 / $335,292 |
| Questions/comp | 2 nouls | 1 choice |
| Latency p50 | 576 ms | 269 ms |
| Input tokens/run | 13,695 | 13,647 |

Both A-side recomputations reproduce production exactly (Breakwater ARV
$430,942, as-is $314,612) — proof shadow mode did not touch routing.

Notable: every B-ARV pick across both reports carries a positive vision curb-
appeal note — B's ARV picks align with the deterministic condition gate's
independent verdicts.

Note: token cost did **not** halve — B's state carries richer evidence. The
savings is in question count, not bytes. Latency was ~2× faster.

## 9b. Abstention analysis (shadow-only; no threshold selected)

Per-comp persisted for every Choice: `class`, `probabilities` (all 3 options),
`confidence`, `top1`, `top2`, `margin` (top1−top2). Verified live.

Across 18 eligible comps:

- **Low-confidence forced rate** (ARV/AS_IS picks below t): conf<0.2 → 18.8%;
  conf<0.4 → 43.8%; conf<0.6 → 68.8%. Jev's `confidence` runs low in this
  market — any conf-based rule must be chosen from labeled data, not assumed.
- **Top-two margin distribution**: 0–0.05: 3; 0.05–0.1: 3; 0.1–0.2: 2;
  0.2–0.3: 1; 0.3–0.5: 5; ≥0.5: 4. Both B mislabels-of-interest live in the
  0–0.1 band.
- **Coverage/contamination sweeps** (confidence and margin thresholds) are
  printed by the harness; contamination cells populate once labels exist.

## 9c. Regression case: 2501 CASS ST (verified flip, $279k→$395k)

B selected **AS_IS** at P={AS_IS 0.45, ARV 0.38, UNIDENTIFIED 0.17}, conf **0.17**,
top1 0.45, top2 0.38, **margin 0.07**.

**Evidence Jev saw:** salePrice $395k = 0.2 percentile among eligible
($350k–$511k, median $424.9k); $/sqft $242 = 0.2 percentile; flip prior
$279k→$395k (+41.6%, 125 days — a retail-exit signature per the question
instructions); adjustedPrice unchanged; no transaction flags; no assessor
condition/grade; not saleReconciled. (Vision "dated" existed downstream but is
deliberately NOT a B input.)

**Why AS_IS:** the primary-task signal — price position — said bottom-quintile
discounted; the flip record said renovated exit. Directly conflicting evidence
→ near-tie (0.45 vs 0.38). The model DID register the conflict (margin 0.07,
conf 0.17); deterministic argmax forced a class anyway. The defensible answer
was UNIDENTIFIED.

**Counterfactual:** every candidate abstention threshold removes it from the
AS-IS pool — conf ≥0.2 (its 0.17 fails all) and margin ≥0.1 (its 0.07 fails
all but 0.05). An abstention rule would have prevented the AS-IS pool entry.

**Nuance:** production's own condition gate independently pruned CASS ST from
the ARV pool (vision-verified "dated") — B's lean agreed directionally with
the pipeline's deterministic verdict; the mislabel is "forced class instead of
abstain," which is exactly what the calibrated rule is for.

## 9d. Stage-1 deployment checklist — verified

| Check | How verified |
|---|---|
| `V2_ENABLED=false` | Not set in `.dev.vars`/`wrangler.toml` → `compClassifierMode` never returns `'enabled'`; flag test asserts default |
| `V2_SHADOW=true` | Unset → default shadow; run metadata shows `"mode": "shadow"` on both live runs |
| A controls production | `enabled` branch is the only B-routing path; shadow runs inside the `else` after A; compGroup tags on both stored reports match A's argmax exactly (CHASE `arv` though B said UNIDENTIFIED; CASS ST `arv`-routed though B said AS_IS; MARKRIDGE `enabled=false` on A's tie) |
| B cannot write ARV pool | Shadow writes only `jevPriceClassification`; `routeCompPriceClasses` is called only in the `enabled` branch (grep-verified) |
| B cannot write AS-IS pool | `jevInvestmentCompIds` assigned only from A's truth filter or enabled-branch B sets; shadow never touches it |
| B cannot change ARV | A-recomputed ARV over A's pool (condition-gate-mirrored) = production $430,942 exactly |
| B cannot change offer | Offer math reads `finalArv` + `selectedCompIds` — neither is written by the shadow block |
| B cannot change ranking | `selectedCompIds`/best-match untouched by shadow |
| B cannot change recommendation | Recommendation derives from valuation outputs downstream of the Jev block; shadow writes only display fields |
| JEV failure cannot break evaluation | Service throws → catch → `jev_selection` fallback → rules selection stands (same doctrine as A; tested: timeout/HTTP/no-key/malformed all throw, never force a class) |
| All three B probabilities persisted | `probabilities` map verified on live items `{ARV, AS_IS, UNIDENTIFIED}` |
| Confidence persisted | `confidence` on every classified comp |
| A/B disagreement persisted | `jevCompClassification.disagreements` (3 and 3 on live runs) + per-comp `jevPriceClassification` vs `jevArvTruth`/`jevInvestmentTruth` on items |
| top1/top2/margin persisted | New parser fields verified live (`top1 0.75, top2 0.25, margin 0.5`) |

## 10. Known limitations

- **No human labels exist yet** — accuracy/contamination/calibration metrics await
  a reviewed dataset (harness accepts `labels.json` keyed by comp id/address).
- `UNIDENTIFIED` removes a comp from BOTH pools — pool coverage drops where price
  evidence is genuinely thin; the rules-selection fallback still covers the
  all-abstain edge.
- Under shadow, B runs on ~the same evidence A scores — but only eligible comps,
  so the eligible-market stats are computed over a smaller, cleaner pool than A
  sees. Deliberate, but it means evidence distributions differ slightly.
- `confidence` semantics are Jev-internal and run LOW in this market (median
  pick ~0.5; 68.8% of picks below 0.6) — a conf-based abstention threshold
  must come from labeled calibration, not intuition. `margin` looks like the
  more informative abstention signal so far (mislabels live in the 0–0.1 band).
- Shadow mode doubles Jev spend per analysis while it runs (bounded by
  `JEV_COMP_CLASSIFIER_V2_SHADOW=false`).
- Abstention analysis is measurement-only — no threshold is implemented in
  routing code. Any future rule is a one-line deterministic remap
  (low-confidence/low-margin ARV/AS_IS pick → UNIDENTIFIED) gated by its own
  flag; choosing it requires the labeled dataset.

## 11. Recommendation

**Keep Baseline A in production; keep B in shadow and collect labeled data.**
The architecture is in place, fail-closed, and flag-isolated. First live signal
is promising (a defensible abstention + a resolved argmax tie, at ~half the
latency) but also shows a low-confidence forced pick on a flip — exactly the
class of error the labeled dataset should quantify before promotion. Promotion
gate suggestion: ≥20 labeled reports, ARV-pool contamination materially below A's,
UNIDENTIFIED precision ≥80%, and no systematic flip misreads.
