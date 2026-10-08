# Haiku Call: Comp Classification

**One call per comp. One job: read the comp's cover photo + listing description and produce its condition classification.**

## Contract

- **Input (per comp, its own API call):** the comp's cover photo, listing description, listing highlights/features, sale facts (price, date, sqft, year built), plus the pool's price ladder as context.
- **Output:** condition label (Poor / Dated / Maintained / Updated / Renovated), comp tier (arv / median / as_is / investor), as-is flag, investor-language probability, a 1-2 sentence evidence **summary**, and a **rulesCheck** — whether the comp meets our comp-selection rules and exactly what it is missing (sale price, sqft, recency, legitimacy, condition evidence).
- **Authority:** classification only — no decision authority. The rulesCheck notates what a comp fails; it does not exclude the comp. The Opus appraiser and the deterministic gate decide what gets picked.
- **Unification:** photo analysis + description analysis resolve into ONE classification and ONE summary per comp — never two competing labels.
- **Calls stay separate:** every comp gets its own call. They may run in parallel lanes for latency, but no call ever shares or merges another call's job.
- **Cache discipline:** a cached classification only counts when the current classifier model wrote it AND it carries the rulesCheck field. Stamps from older lanes (luna/Decisions/Clef) are dropped and reclassified on the cached listing/photo evidence — old models can never reach the appraiser through the cache.
- **Implementation:** `apps/api/src/services/comp-evidence/index.ts` — `classifyCompPoolHaiku`.
- **Trace:** `harness.trace.haiku.comps[<compId>]` — executor model, durationMs, conditionLabel, tier, asIs, summary, rulesCheck.
