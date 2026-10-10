# type.flowstate.homes — TypeScript instant-eval lane

Goal: **eval latency = provider latency only.** Zero model calls, zero photo/scrape fetches, zero satellite or street-view tiles — **strictly mathematics over data-provider matches**. The same deterministic selector from corelogic-alpha runs, but every vision/LLM-derived input is either provider-sourced or honestly labeled `unknown`.

Evaluations on this lane are **supervised** — the report presents the math and a human confirms; nothing on this lane drives autonomous action.

## Infrastructure (mirrors the core sibling)

- Branch: `type.flowstate.homes`
- Worker `flowstate-api-type` — `wrangler.type.toml`, route `api-type.flowstate.homes`, `PROPERTY_PROVIDER=corelogic`, `DEFAULT_HARNESS=typescript`
- Dashboard `flowstate-dashboard-type` — `wrangler.type.jsonc`, route `type.flowstate.homes`, `NEXT_PUBLIC_API_URL=https://api-type.flowstate.homes`
- Same D1 / KV / R2 / auth / CoreLogic credentials as `flowstate-api-core` — secrets copied across with `wrangler secret put` (CORELOGIC_*, GEOCODIO_API_KEY, EVAL_API_KEY, DASHBOARD_INTERNAL_SECRET, FASTMAIL_API_TOKEN)

## Pipeline (harness `typescript`)

1. Subject resolve: CoreLogic search → detail (+ parcel retry). Unchanged.
2. Comparables: CoreLogic comparables call. Unchanged.
3. Geo: Geocodio per comp + subject → block group / tract / pocket. Parallel, ~100–300ms. Already code.
4. Labels per dimension, provider data only: sqft / beds / baths / lot / year / distance / sale-age / price-position → `exact | close | recoverable | hard_failure | unknown`. Existing label machinery.
5. Selector: lexicographic rank → price segmentation gate → R7 foreign-pocket gate → true-comp pick bar. All already TypeScript.
6. Report + saved report: same shapes; `visionAssessment` / `observables` sections return `skipped` or are absent.

## Price segmentation (hard gate, pocket-relative)

Every comp's sale $/sf is measured against the pocket's qualified median $/sf (similarity-qualified when ≥3 sqft-close pocket comps exist, else broad pocket):

- **Too high** — above the upper band → `outlier`, rejected. Existing bound: >2.5× pocket median (R4). Tune-down candidate: ~1.5–2.0×.
- **Too low** — below the lower band → `outlier`, rejected. New bound: distress/as-is-priced sales can't drive the verdict. Default proposal: <0.5× pocket median.
- **Inside band** → segmented top / median / bottom by natural breaks; price class (ARV / MEDIAN / AS-IS evidence) stamped on every comp.

## Match boundaries (appraisal-rule tolerances drive the labels)

The preset tolerance ladder maps directly onto the label classes — no fuzzy judgment anywhere:

- sqft twin / close bounds → `exact` / `close` / `recoverable` / `hard_failure`
- beds / baths exact or ±1, year range, lot size range, distance radius, sale-age window → same ladder
- geo dims from provider data: block group + tract (Geocodio), subdivision + neighborhood (CoreLogic detail)
- condition: CoreLogic assessor `buildingCondition` code (Excellent → Very Poor) where the county ships it — display only, `unknown` otherwise
- >365d sale-age and gross physical mismatches remain hard failures; every rejected comp keeps its reason string

## Cut list (everything that costs the 60s)

| Lane | Status | Consequence |
|---|---|---|
| Photo service (Scrapfly → Redfin stingray) | removed, 0 listing fetches | no photos in report |
| Observables / Decisions (subject + comp + benchmark + satellite + street view + site-exposure edge questions) | removed, `observablesOn=false` | vision-derived dims = `unknown` |
| Pocket desirability score, gate note writers, any LLM call | removed | $0 model spend |

## What fills the gaps without models

- **ARV fitness:** deterministic price-position — comp sale $/sf vs pocket median → ARV / MEDIAN / AS-IS class (the same math the client badge already renders).
- **Site exposure** (waterfront / corner / cul-de-sac / busy road): `unknown` — CoreLogic ships no field; out of scope (Nominatim geometry inference cut per strictly-provider-math spec).
- **Confidence:** derived from pick quality + label coverage — honestly lower than the model lanes by design.

## Latency budget (per eval, fresh address)

| Stage | Est. |
|---|---|
| CoreLogic subject search + detail | ~1–2.5s |
| CoreLogic comparables | ~2–3s |
| Geocodio × ~40 comps (parallel) | ~0.5–1s |
| Selector + report | <100ms |
| **Total** | **~4–7s**, all provider time |

## Tradeoffs (honest)

- No renovation read — can't tell flipper-complete from dated. Type lane is a fast market screen; the model lanes remain the underwriting verdict.
- Site deductions (backing-busy −$10k etc.) can't fire without exposure labels.
- Thinner report: no photos, no vision assessment, no satellite stamp.

## Open questions

1. Exact band bounds for price segmentation: upper ~1.5×/2.0×/2.5× and lower ~0.5× of pocket median? (Defaults above.)
2. If assessor condition is present — display only, or a math adjustment against the band?

## Latency budget (per eval, fresh address)

| Stage | Est. |
|---|---|
| CoreLogic subject search + detail | ~1–2.5s |
| CoreLogic comparables | ~2–3s |
| Geocodio × ~40 comps (parallel) | ~0.5–1s |
| Selector + report | <100ms |
| **Total** | **~4–7s**, all provider time |

## Tradeoffs (honest)

- No renovation read — can't tell flipper-complete from dated. Type lane is a fast market screen; the model lanes remain the underwriting verdict.
- Site deductions (backing-busy −$10k etc.) can't fire without exposure labels.
- Thinner report: no photos, no vision assessment, no satellite stamp.

## Open questions

1. If assessor condition is present, do we apply a discount/adjustment rule or display only? (Default: display only.)
2. Cul-de-sac / corner inference from road geometry — worth the extra call?
