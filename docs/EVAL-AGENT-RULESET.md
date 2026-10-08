# Evaluation Ruleset — Opus Appraiser Architecture (v2)

Source of truth for how a property evaluation runs end to end. The goal of
the system is fully autonomous offers: no human reviews drafted offers, so
the harness has to be good enough that manual evaluation is unnecessary.
Target throughput: 1,000+ evaluations per week, production hardened.

## Model map — who does what

- **claude-haiku-5-5 — classifier only, zero decision authority.**
  - Subject property: reads all listing photos + the description and assigns
    the renovation tier (`apps/api/src/services/vision/renovation.ts`,
    reasoning lane).
  - Comparable pool: one call per comp over the cover photo + listing
    description → condition label, tier, description summary, and a
    `rulesCheck` (`classifyCompPoolHaiku` in `services/comp-evidence`).
    Rules-check gaps are ALSO merged deterministically — a comp missing sale
    price, square footage, or a usable sale date gets the gap notated by
    code even if the model missed it.
  - Pocket desirability: one call per eval — Serper gathers web signal on
    the subject's location, haiku rates desirability 0-10 with rationale
    (`services/evaluation/pocket-desirability.ts`,
    `HAIKU-POCKET-DESIRABILITY.md`).
  - Clarify sub-agent: Opus can ask haiku to clarify, classify, or surface a
    missing fact mid-review (max 5 calls per eval, `CLARIFY_PROMPT`).
    Haiku answers — it never advises on selection.
  - Gate debugger: when the deterministic gate rejects Opus's selection,
    haiku writes a plain-English debug note explaining WHY it was rejected
    (`GATE-DEBUG-RULESET.md`). Annotates, never re-judges.

  Each haiku call is its own contract with its own doc — one call per job,
  never merged or shared: `HAIKU-SUBJECT-CONDITION.md`,
  `HAIKU-COMP-CLASSIFY.md`, `HAIKU-POCKET-DESIRABILITY.md`,
  `HAIKU-CLARIFY.md`, `GATE-DEBUG-RULESET.md`.
- **claude-opus-5-5 — the appraiser.** Reviews the complete evidence bundle
  and makes the final comp selection + ARV call (`services/evaluation/
  appraiser.ts`, `runOpusAppraiser`, `OPUS-APPRAISER.md`). The only model
  with decision authority. Also rates the dataset it was handed —
  `dataQuality` 0-10 per attempt, where 10 means the evidence made the
  decision easy and unambiguous.
- **Deterministic code — all plumbing and all refereeing.** Comp fetch,
  geo gating, price coherence, the gate (`verdict-grade.ts`), ARV
  application, valuation math, trust floor. No model edits or overrides it.
- **SWE-2 / Devin — builds and maintains the system.** Never an actor in
  the eval reasoning chain; not referenced in rules or docs as one.

## The pipeline, A to Z

`POST /v1/analyze` with `harness: "agent"` runs this inside the job's
durable object — self-completing, no `awaiting_agent` park:

1. **Phase 1 (code).** Subject from ATTOM, comp pool fetched relative to the
   subject, census geo-stamped (block group → neighborhood → tract gating),
   enrichment (sales history, permits, listing data, cover photos). Agent
   runs keep the caller's overrides verbatim — no default filter injection.
2. **Classification (haiku).** Subject renovation tier from photos +
   description. Every comp: condition label/tier, description summary,
   `rulesCheck { meets, missing[] }` — which of our comp rules it satisfies
   and exactly what it lacks.
3. **Evidence bundle (code).** `buildHarnessEvidence` assembles subject
   fields, renovation evidence, and per-comp rows carrying condition,
   rulesCheck, cover photo URL, geo tiers, sale stamps — everything the
   appraiser sees.
4. **Pocket desirability (haiku).** `ratePocketDesirability` gathers web
   signal on the subject's location and haiku scores it 0-10 — evidence
   the appraiser weighs, stamped onto `harness.pocketScore`.
5. **Appraisal (opus).** `runOpusAppraiser` hands Opus the bundle under
   `APPRAISER_PROMPT` + `COMP_DOCTRINE` (`comp-doctrine.ts`). Opus returns a
   structured selection or clarification requests; clarifications route to
   haiku and feed back in (≤5).
6. **The gate (code).** `gradeVerdict` scores the selection against the
   evidence — checks below. Validation coherence (enabled comps, ARV within
   the pick-price envelope) runs first.
7. **Revision loop.** Gate reject → haiku writes the debug note → the named
   violations + note go back to Opus under `REVISION_PROMPT` → Opus revises
   and reposts (≤2 revisions). The gate is code — it cannot be argued with,
   only satisfied.
8. **Completion (code).** Accepted selection flows into phase 2 → ARV,
   rehab level, MAO, wholesale, recommendation → report persisted. If Opus
   exhausts revisions or is unavailable, the deterministic engine's own
   selection completes the job — nothing parks.
9. **Trust floor (code).** Gate grade < 0.7 composite AND low confidence →
   `trustFloor: hold`, `requiresHumanReview: true` (goes to the hold list,
  flowstate-workers keeps it in Underwriting). Every other accepted verdict
   is an explicit `clear`.

## What the ARV is

The price the subject sells for after the scoped rehab — set ONLY by
genuinely renovated retail sales. As-is, distressed, investor-marketed, and
nominal sales price the floor (as-is value), never the ARV, however
updated they look.

## The gate — deterministic checks (code, not a model)

- **d1 — pocket discipline.** Pricing weight goes to in-pocket comps (same
  block group > neighborhood > census tract) while usable in-pocket comps
  sit unpicked. Warn-only when every unpicked pocket comp is as-is
  classified.
- **d2 — flagged picks.** Picking a comp flagged nominal_sale, data_error,
  price-sanity failure, non-arm's-length, or disabled → reject.
- **d4 — as-is driver.** An as-is-classified comp cannot be a driver of the
  ARV. Also flags skipping qualified ARV evidence the pool contains.
- **d5 — coherence outlier.** A pick priced >1.5×IQR from its condition
  group's price core (group needs ≥4 members) is not evidence → reject.
- **d6 — missing evidence.** Selection that ignores material missing-data
  notation → warning surfaced.
- **d7 — ARV envelope.** The ARV must sit inside the sale-price range of
  the qualified renovated comps ±10%. Hard fail when ≥2 qualified comps
  exist; soft warning against the wider non-as-is pool otherwise.

## Selection contract

Opus's selection carries: `arv`, `conf` (high|medium|low),
`selectedCompIds` (enabled pool only), `drivers` (the subset whose prices
drive ARV), `adjustments`, `flags`, `pocketScore`, `dealEconomics`,
`renovation`, `notes`. Driver prices must bracket the ARV honestly —
anchor on the middle of the qualified group, not the edge.

## Comp rules — what qualifies a sale as evidence

(haiku notates each comp against this list; code merges mechanical gaps)

- Real arm's-length sale — no nominal/distressed-sale flags, no data_error.
- Priced in market — sale price + square footage present, $/sf coherent
  with the pocket.
- Recency — inside the preferred sale-age window.
- Geo — same block group preferred; tract acceptable; beyond is weak.
- Usable condition read — enough listing evidence to classify.
- A comp that misses a rule stays listed, annotated with what it lacks —
  never silently dropped.

## Selection judgment

- Tightest geography wins at equal quality — block group outranks tract.
- Verified-flip / renovation proof outweighs condition stamps.
- Price outliers inside a condition group are trimmed before they distort.
- Anchor on the qualified group's middle, not its edge.

## Legacy seam (dormant)

`GET /harness/evidence`, `POST /harness/selection`, `POST /harness/consult`,
`/harness/claim` and the `awaiting_agent` state still exist for manual
debugging and external-agent experiments. The production path never parks —
the endpoints simply never see a waiting job.
