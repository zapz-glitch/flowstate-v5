# Engineering State — flowstate-v5

## Current Objective
End-to-end hands-off fix-&-flip evaluation: accurate, fast, scalable, with evidence.

## Completed (this session arc)
- Vision/photo latency: merged subject renovation+curb-appeal into ONE LLM call;
  all vision resolves in one parallel batch; comp photos capped 6 (selected+nearest
  first); per-fetch timeouts (subject 20s/comp 12s). Engman 11.1s -> 7.8s.
- Renovated subjects: skipBaseRehab — vision curb-appeal "renovated" => $0 base
  $/sqft rehab; major items still charge; rehabLevel shows "Renovated".
- 7-day restore + cross-device resume of last analysis (localStorage pointer +
  GET /user/reports?limit=1 fallback).
- No-shortcuts enrichment: ALL returned comps get property-detail calls
  (subdivision + foundation + style + features) — reverted the lazy gate.
- foundation_match filter added (API evaluator + shared package), runs on all
  enriched comps; subdivision_match + foundation_match always-enabled
  (not_verified never disqualifies — safe when data missing).
- OSM location risks moved INTO enrichment batch (was post-eval fire-and-forget);
  commercial/major-road/railroad now deducts locationPenaltyPercent (default 3%
  of ARV) from buy price; surfaced in riskFlags + valuation breakdown.

## Verified
- Engman: 6.9s, ARV $344k, eval pass. After no-shortcuts enrich: all 6 comps
  carry foundation+subdivision; foundation_match passed on all; subdivision_match
  fired -> nearest_comps fallback documented (comps genuinely outside subdivision).
- Bergstrom Bay: curbAppeal renovated@100% -> rehabLevel "Renovated", rehab $0.
- Both typechecks clean.

## Pipeline Order (as specified by product)
comps search -> enrich ALL (subdivision/foundation/style) -> appraisal rules
(subdivision+foundation are hammers; not_verified-safe) -> photo+vision ONLY on
selected/rule-passing comps (+subject) -> permits subject-only -> major items ->
valuation (renovated-skip, location penalty) -> report.

## Pending / Next
- Observability: extend evidence with photo/vision metrics if desired.
- foundation_match visible in Evaluation Settings UI (preset editor lists filters).
- Deploy: migration 0021 needs db:migrate:remote at deploy time.

## Last Handoff
Pipeline hardened per spec. Next likely: more comp-quality evidence or
foundation_match toggle in preset UI if user wants it configurable.
