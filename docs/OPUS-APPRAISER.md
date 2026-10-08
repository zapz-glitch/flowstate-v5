# Opus Call: The Appraiser

**One decision loop, one job: review the complete dataset and post the final comp selection + ARV.**

## Contract

- **Input:** the entire frozen evidence bundle — subject facts + haiku's condition tier, every comp with haiku's classification (label, tier, evidence summary, rulesCheck), pocket desirability, geo stamps, verification flags, cover-photo URLs, the deterministic engine's suggestion (context, not an anchor), and the eval rules.
- **Output:** `selectedCompIds`, `drivers`, `arv`, `conf`, `notes`, `dataQuality`, `flags`, `clarifyRequests`.
- **dataQuality /10:** Opus also rates the dataset it was handed — 10 means the evidence made the eval easy and unambiguous. Thin pools, missing condition reads, and conflicting evidence push it down. Per-attempt, in the trace.
- **Sub-agent:** on gaps it may issue up to 5 clarify requests; haiku answers (see HAIKU-CLARIFY.md) and the loop resumes.
- **Gate discipline:** every posted selection is graded by the deterministic gate (verdict-grade.ts — pocket discipline, flagged picks, as-is drivers, coherence outliers, envelope). A reject comes back as named violations plus a haiku debug note (see GATE-DEBUG-RULESET.md); Opus revises, at most 2 rounds. The gate is code — it cannot be argued with, only satisfied.
- **Exhaustion:** if the budget runs out with no accepted selection, the deterministic engine completes the eval on its own selection — a persistently failing pool ships an honest fallback, never a forced number.
- **Implementation:** `apps/api/src/services/evaluation/appraiser.ts` — `runOpusAppraiser`.
- **Trace:** `harness.trace.opus` — model, clarifications, debugNotes, per-attempt decisions (arv, conf, picks, drivers, notes, dataQuality), final selection.
