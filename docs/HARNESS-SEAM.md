# Harness seam — Evaluation Agent inside the analyze pipeline

Status: design contract for `SWE-10-5-2026` harness rebuild. Natural
language, matching EVAL-AGENT-RULESET.md.

## What changes

`evaluateB` stays the deterministic default (Property Search UI, batch,
every caller that does not opt in). A job dispatched with `harness: "agent"`
in the `POST /v1/analyze` body pauses at the evidence-complete point and
hands the comp-selection judgment to the Evaluation Agent instead.

Nothing else moves: provider fetch, geocode tiers, enrichment, Clef/Luna
vision, permits, evidence verification, classification, valuation math,
report persistence — all stay deterministic in the Worker.

## Agent-run rule authority

For `harness: "agent"` jobs the appraisal grid is the caller's
`appraisalOverrides` verbatim — the user's saved preset and the
`DEFAULT_FILTERS`/`DEFAULT_ADJUSTMENTS` injection do NOT apply (they still
apply to every deterministic run). Doctrine lives in
EVAL-AGENT-RULESET.md, not the preset: an empty override means "no
filters", so a comp is enabled unless it fails a hard data gate
(non-market price, lot-category mismatch, transaction noise). Geo, age,
size, and distance preferences are the agent's call, not server gates.
Filterless runs surface the same raw evidence fields (distanceMiles,
sameBlockGroup, censusTract, yearBuilt, saleDate, crossesMajorRoad) for
the agent to weigh. Because sqft-less comps can stay enabled, selection
validation enforces a math floor: every pick must carry `salePrice > 0`
and `squareFeet > 0`.

## The seam

```
performAnalysis
├── phase 1 (deterministic, unchanged): property → geocode tiers →
│   enrichment → appraisal grid → photos/vision → permits → Redfin +
│   listing evidence → Clef stamps → evidence verification →
│   classification. Ends where `evaluateB` is called today.
├── harness decision point
│   ├── harness unset → evaluateB(bSubject, toBComps()) — today's path
│   └── harness = "agent" → freeze evidence bundle, status =
│       "awaiting_agent", SSE step agent_selection pending
└── phase 2 (deterministic, unchanged tail): selection → valuation on the
    anchor → Group B → response build → saved report → evaluation_complete
```

The frozen evidence bundle IS `BSubject` + `BComp[]` — the exact
subject/comp shapes `evaluateB` already consumes (address, sale price,
sale date, sqft, distance, sameBlockGroup, censusTract, neighborhoodName,
subdivision, yearBuilt, lot, AVM/land, propertyType, crossesMajorRoad,
disableReasons, verifiedFlip, classification, curbAppeal,
evidenceVerification, appraisalRules.totalAdjustment) plus the pocket
inputs. The agent sees exactly what the engine saw — no more, no less.

## API surface (Bearer API key, same as /v1/*)

- `POST /v1/analyze` body gains `"harness": "agent"` — everything else
  unchanged. Without it the job runs deterministic end-to-end.
- `GET /v1/analyze/jobs/:jobId/harness/evidence` — returns the frozen
  bundle `{subject, comps, classifications, curbAppeal, verification,
  pocketInputs, rulesetVersion}` once `status === "awaiting_agent"`.
- `POST /v1/analyze/jobs/:jobId/harness/selection` — the agent's verdict:

```json
{
  "selection": {
    "arv": 412000,
    "conf": "high | medium | low | none",
    "selectedCompIds": ["id1", "id2"],
    "drivers": ["id1", "id2"],
    "bands": { "id1": "arv", "id2": "median", "id3": "asis", "id4": "outlier" },
    "adjustments": { "id1": [{"type": "sqft", "amount": -15000, "note": "..."}] },
    "flags": ["excluded id4 — unexplained high-price outlier"],
    "pocketScore": 7.5,
    "dealEconomics": "..."
  }
}
```

or, before answering, a request for more evidence:

```json
{ "needsMoreEvidence": "widen" }
{ "needsMoreEvidence": "deepen" }
```

## Validation (server-side, before phase 2)

- `selectedCompIds` must be a subset of the enabled pool — unknown or
  disabled ids are rejected, not silently dropped.
- Every pick must carry `salePrice > 0` and `squareFeet > 0` — the
  valuation math needs a defensible $/sqft per comp.
- `arv` sanity: inside the pool's evidence range (rejected if outside the
  [min enabled sale, max enabled sale] envelope by more than the ruleset's
  own tolerance).
- Same verification invariants `verifyB` applies: arv present, ≥1 driver,
  conf ≠ none — else the result counts as an unverified attempt.

## Retry ladder (agent-driven)

`needsMoreEvidence` triggers evidence retries against the live provider:
`widen` = provider refetch at +12mo sale window per round in the SAME
geography (go back in time, never out of the block group — EVAL-AGENT-RULESET
§8a), `deepen` = AVM/land enrichment for thin comps. Widened candidates are
geo-stamped and enriched through the census gate before joining the pool.
Bounded at 2 evidence rounds total. After the last round the agent must
answer; if it still cannot, the job falls back to `evaluateB` as an honest
final answer rather than hanging.

## Timeout / fallback

- `awaiting_agent` is exempt from the existing 5-minute watchdog (which
  only covers dead `processing` runs). It gets its own longer deadline
  (30 min default).
- On deadline, or on any agent-side failure, the DO runs `evaluateB` on
  the same frozen bundle and completes normally — the run degrades to the
  deterministic answer, labeled `source: "deterministic_fallback"` in the
  report and run record. No job ever dies waiting on the agent.
- SSE sees an `agent_selection` step (waiting → completed|fallback) plus
  the selection payload in the run record for audit.

## Offer queue + reports

Completion still lands in `saved_reports` and the report URL; the agent
POSTs fw `/engine/eval/complete` so `finalizeEval` does Close writes and
the waiting-for-offer → ready transition exactly as today.

## Geo doctrine fix bundled here

`geoPriority` currently orders censusTract(0) > sameBlockGroup(1) >
neighborhood(2). Ruleset says block group first, neighborhood second,
tract as fallback — the enrichment-target ordering flips to match.
