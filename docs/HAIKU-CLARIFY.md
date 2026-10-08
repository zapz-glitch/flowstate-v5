# Haiku Call: Clarify (Opus Sub-Agent)

**One call per question. One job: answer what the appraiser asked — classify missing information or find it in the evidence.**

## Contract

- **Trigger:** the Opus appraiser hits a gap or ambiguity mid-review and issues a clarify request (a targeted question, optionally scoped to one comp). Questions on five comps → five separate calls, one per question.
- **Budget:** at most 5 clarify calls per eval — enough to cover a full hand of doubtful comps, bounded so a confused review cannot spin.
- **Input:** the question, the comp's evidence row (when scoped), and the subject facts.
- **Output:** `answer` (1-3 sentences citing the evidence) + `confidence` (0-1).
- **Authority:** strictly none — haiku answers; Opus decides. The sub-agent never offers verdicts or comp-selection advice, and its answers cannot override a classification it already made.
- **Implementation:** `apps/api/src/services/evaluation/appraiser.ts` — `haikuClarify`, `CLARIFY_PROMPT`, `CLARIFY_SCHEMA`.
- **Trace:** `harness.trace.opus.clarifications[]` — compId, question, answer, confidence.
