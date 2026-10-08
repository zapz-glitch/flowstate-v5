# Haiku Call: Subject Condition

**One call. One job: read the subject property's photos + listing description and produce its condition classification.**

## Contract

- **Input:** subject listing photos (chunked across the full photo set), listing description, listing features, property facts (year built, sqft).
- **Output:** a renovation assessment — zone grades (kitchen, bathrooms, flooring, walls/ceilings, exterior), system + structural concerns, a renovation level on the standard tier scale, a path gate (photo confidence → recommended read path), and description claims extracted from the listing copy.
- **Authority:** classification only. Haiku has no decision authority — the tier it produces is evidence for the Opus appraiser, never a verdict.
- **Unification:** the photo read and the description read resolve into ONE classification and ONE summary — the subject never carries two competing condition labels. If the calls ever split, they merge into the same record before the appraiser sees it.
- **Degradation:** if the call fails, the eval records the failure honestly (the trace shows the error; rehab falls back to the deterministic tier) — a missing read is never silently replaced by a different model's stamp.
- **Implementation:** `apps/api/src/services/vision/renovation.ts` — `createReasoningProvider` (claude-haiku-5-5) with `RENOVATION_SCHEMA` structured output.
- **Trace:** `harness.trace.haiku.subject` — zoneGrades, pathGate, descriptionClaims count.
