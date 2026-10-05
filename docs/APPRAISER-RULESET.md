# Appraiser Ruleset — current Set-B harness

This is the active product rule record for the TypeScript Set-B evaluator.
Rules change only with product-engineer sign-off. `docs/OFFICIAL-HARNESS.md`
is the historical A/B winner; this file controls the current V2 harness.

## Governing question

Would a highly skilled residential appraiser support this answer for this
subject, using this evidence and these configured rules? If not, the harness
should withhold or weaken the result rather than invent support.

## Active rules

1. **Geography uses the tightest proven scope.** Block group is the tightest
   match, then tract, then neighborhood name. A comp outside all three is
   out-of-pocket evidence, not pocket evidence. Wide-scope evidence must prove
   market equivalence from the closest adjacent block/tract/neighborhood
   groups first.
2. **Evidence is screened before it can drive.** A comp stamped stale,
   divergent, below-pocket, unexplained above-pocket, package-deed, or
   nominal-sale cannot set ARV.
3. **Stale means old.** A sale is stale only when it is outside the
   configured preferred `sale_age` window. Price is a separate market-fit
   check.
4. **Market fit is separate from age.** A sale far below the comp's current
   pocket rate is `below_pocket`. A sale far above it is `above_pocket` unless
   renovated evidence explains the premium.
5. **Sale price is the final market anchor.** Clef/Luna condition and the
   classification can change whether a comp may drive, but they do not
   replace the recorded transaction. Rural market equivalence uses subject
   AVM/sqft first; when the subject AVM is missing, same-scope comp AVMs can
   establish the subject pocket, then tight scope medians may fill the gap.
6. **Condition evidence is structured.** A confident structured condition
   read wins. Old `tier:*` summary text is fallback only. Low-confidence
   reads stay unverified.
7. **Distressed and as-is sales are floor evidence.** They can bound or
   explain the market, but they cannot set ARV.
8. **One anchor sets ARV.** Other accepted drivers bound the answer; they are
   not averaged into it. Similarity gates trim weaker drivers.
9. **No unexplained uplift.** Market-measured premium-vs-median spread can
   support a condition adjustment. If it cannot be measured, the median
   anchor stands and the flag says uplift is unverified.
10. **Median-only exception is limited.** When no ARV-tier evidence exists
    but the subject AVM is above the gated median ceiling, the approved path
    may move halfway toward that AVM. This is labeled `median+50% AVM uplift`
    and graded weak. Otherwise AVM remains floor/display evidence only.
11. **Fallbacks are explicit.** No comp evidence falls through labeled
    floors: pocket-implied, AVM floor, assessed value, then report-only.
    The fallback is not presented as verified comp evidence.
12. **Result grade is evidence quality.** `verified` needs at least three
    drivers with usable verification evidence. `weak` means the answer used
    soft, thin, rescued, or unverified evidence. `floor` means non-comp
    evidence. `withheld` means no defensible answer.
13. **Process grade is attempt health.** `clean`, `retried`, and
    `unverified` describe the evaluation path only. Hash/archive integrity is
    reported separately.
14. **Enrichment is staged.** Free evidence ranks candidates first:
    block group, tract, neighborhood, then nearest. Provably dead or noisy
    comps do not receive paid enrichment. The ladder enriches six candidates
    at a time, stops once three usable ARV-evidence comps exist, and caps at
    25 paid enrichments.
15. **Every run must be replayable.** The run record stores request, rules,
    subject, comp evidence, every Set-B attempt, result, hash, model/runtime
    context, and archive status.
16. **Actual outcomes do not rewrite predictions.** Later verified sale
    results are stored separately for calibration and audit.
17. **Dashboard/server parity.** The server computes the appraisal and
    downstream offer values. The dashboard renders and submits selections;
    it does not calculate a second ARV.

## Superseded rules — do not implement from old text

- Minimum-three reconciliation as an automatic formula.
- Price terciles or banding as the main evidence class.
- Price ratio as the definition of stale.
- Devalue/time-reprice rungs.
- Automatic rehab-cost × 70% or ×80% condition uplift.
- Land-extraction or `land_play` output as valuation evidence.
- Free-form `tier:*` summary text overriding structured condition evidence.

## Open decisions / not yet built

- Broader bulk-sale variants and same-day different-price package patterns.
- Independent rule auditor. Replay proves determinism; it does not prove
  every configured rule was followed.
- Complete browser/server parity check after the dashboard edits settle.
