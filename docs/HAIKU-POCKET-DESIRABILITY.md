# Haiku Call: Pocket Desirability

**One call. One job: rate how desirable the subject property's LOCATION is for a wholesale deal, 0-10.**

## Contract

- **Gather (code, not the model):** a Serper search on the subject's neighborhood/city/state for real-estate demand signal — market activity, homes-for-sale character, neighborhood profile. Up to 6 result snippets feed the model. No Serper key → the call judges on location identity alone and must say so.
- **Input:** subject location identity (neighborhood/subdivision, city, state, zip, census tract, block group, address) + the gathered web evidence.
- **Output:** `score` (0-10, one decimal allowed), `summary` (1-3 sentences citing what the evidence showed), `signals` (the concrete factors the score rests on).
- **Judgment criteria:** demand depth, turnover speed, resale strength of the ARV product, buyer-pool depth (first-time, move-up, landlords), and the livability signals that drive them (schools, crime, employment access, amenities, price trend).
- **Scale:** 10 = the location nearly sells the deal itself; 0 = buyers will not come at any price. Thin evidence gets an honest middling score, not invented confidence.
- **Authority:** classification only — the score is evidence the Opus appraiser weighs; it never changes a comp pick or the ARV by itself.
- **Runs every eval:** each run re-rates; the score lands on the report (`harness.pocketScore`) and the trace.
- **Implementation:** `apps/api/src/services/evaluation/pocket-desirability.ts` — `ratePocketDesirability`.
- **Trace:** `harness.trace.haiku.pocketDesirability` — score, summary, signals, model, durationMs.
