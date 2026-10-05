# V2 harness status at 7be2d7f

This is a source and local saved-data review, not a new test run or a
production sign-off. The user has assigned UI work to Claude. UI edits,
mapping, routing, and the final browser parity check are deferred.

The earlier conversation claim that Phase 2 was complete was too broad.
The evaluator, report trace fields, a basic replay script, and result
grades exist. The full snapshot/compliance/change-control design does not.

## Working baseline

- Worktree: `/home/lucke/src/flowstate-v5-attom-v2`.
- Branch: `feat/attom-provider-swap-v2`.
- TypeScript Set-B is the valuation engine; ATTOM MCP remains the provider.
- The A/B winner was restored in `982b13f`, then selected hardening was
  added. The current file is therefore not a byte-for-byte ship-time copy.
- One anchor sets the answer; other drivers bound it rather than blend.
- The 19 parked audit items are not a bundle approved for automatic import.
- Do not restore min-3 reconciliation, price terciles, devalue/time-reprice
  rungs, or land-extraction outputs from the abandoned design.
- An address evaluation does not authorize a policy change.

## Implementation present

| Area | Source and scope |
|---|---|
| Engine | `packages/shared/src/appraisal/set-b.ts`: marginal size/land contributions, anchor and support, similarity gate, ceiling, fallbacks. |
| Classification | `apps/api/src/services/evaluation/comp-classification.ts`: flip/distress evidence, a vision-backed price band, and probability arbitration for opposite-end condition/class conflicts. Flip chains are exempt from that arbitration. |
| Condition readers | `apps/api/src/services/comp-evidence/index.ts`: Clef with Luna fallback on the comp condition contract. |
| Geography | Tract, block group, then neighborhood selection; the card's tighter-scope naming is a separate concern. |
| Rural selection | `services/appraisal/evaluator.ts` and `index.ts`: pocket value comparison at wider scopes. This still needs missing-evidence and outlier review. |
| Size ladder | Configured strict band, then 500/750/1000 sqft defaults. |
| Retry path | `services/evaluation/index.ts`: initial evaluation, wider retrieval, then deeper enrichment. Newly retrieved comps pass the appraisal grid. |
| Distress | Distressed/as-is evidence is excluded from the ordinary ARV driver paths. This does not establish that every fallback path is fully screened. |
| Uplift | Median-only evidence can move halfway toward a higher subject AVM. The automatic rehab-cost × 80% fallback was removed; a market-spread adjustment path remains. |
| Result | `services/analysis/result-grade.ts`: verified, weak, floor, withheld; separate from comp condition/classification. |
| Trace | Mechanics include a harness version string, fallback used, relaxed filters, attempt trail, flags, and drivers. |
| Replay | `scripts/replay.mts`: JSON reports or local D1 `--all`, sharing `saved-pool.ts` with server recalc. |
| Recalc | `services/evaluation/recalculate.ts` and `routes/user-reports.ts`: saved evidence, server valuation, revision conflict checking, persisted selection changes and history. |
| Sqft repair | `1fcd0b9`: response uses the square footage evaluated by the math; listing size remains evidence. |
| Confidence repair | `52d5b38`: removed the whole-report confidence overwrite of the initial valuation's confidence. Recalc parity still needs completion. |
| Feedback | `routes/user-reports.ts`: validation/improvement status, notes, generated report, timestamp. |

## Saved local examples inspected

Read from the local API D1 `saved_reports.full_response_json`. These are
stored predictions, not new provider runs, actual resale outcomes, or
proof of appraisal accuracy.

| Property | Stored ARV | Result / process | Recorded basis |
|---|---:|---|---|
| 115 Charles Ave SE | $289,095 | weak / unverified | Median + 50% AVM uplift; widen/deepen; below-AVM verification failure. |
| 1643 Bagpipe Pl | $228,269 | weak / clean | Anchor path; sale-age expansion. |
| 2184 Dunseath Ave NW | $411,427 | weak / clean | Anchor path; sqft expansion. |
| 4425 Chestnut Lake Ave | $228,178 | Grades absent | Older unstamped anchor-path report. |

The first three carry `og-2026.10.04.1`. None of these four payloads has
an `evaluationRevision` value. Do not repeat the earlier claim that every
full rerun already increments that field; the comp-selection recalc does.

## Compliance gaps

1. **Frozen run record:** no Set-B snapshot module, content manifest,
   snapshot hash, snapshot retrieval route, or `fixtures/snapshots/`
   corpus was found in this branch. The design spec describes machinery
   that has not been rebuilt here.
2. **History is not an immutable run archive:** `report-upsert.ts`
   overwrites the property report on reanalysis. Its history entry stores
   ARV, buy price, and rehab cost, not the full prior evidence. Comp
   selection history separately stores before/after reports.
3. **Durability:** the main job path attempts report persistence before
   completion and reports an error if saving fails. That is useful, but
   it is not the approved durable record plus retryable long-term archive.
   The report update and history insert are separate operations.
4. **Trace:** flags are free text, without stable rule IDs on each
   decision. The retry trail also does not preserve every attempt's full
   inputs and output.
5. **Replay:** currently compares ARV with a 2% tolerance. It does not
   fail a number-to-null or null-to-number change, skips empty comp sets,
   and does not check offer, grade, selected drivers, or trace equality.
   It has no `--strict` implementation or saved machine-readable
   scoreboard. The documented npm replay commands are not registered.
6. **Process grade:** `clean/retried/unverified` describes the evaluation
   attempt path. It does not check snapshot completeness, a hash, or
   durable storage. A clean attempt is not a compliance pass.
7. **Versioning/cache:** the harness has a manual version string. The
   21-day evaluation cache key hashes parameters and address, but does
   not incorporate the harness version/content. Stale-code reports can
   still be returned unless refresh/skipCache bypasses them.
8. **Change-control gate:** no Set-B strict replay step is present in
   the checked-in CI workflows. Remote branch protection was not queried.
9. **Actual outcomes:** report feedback exists, but the planned verified
   actual-sale outcome linked to a specific prediction/run is not built.
10. **Auditor:** the independent offline check of each rule remains
    deferred by design. Reproducing a number is not proof that its rules
    were followed.

## Remaining harness work and review risks

- **Policy documents conflict.** `APPRAISER-RULESET.md` and
  `APPRAISAL_HARNESS.md` still contain min-3, obsolete retry rungs, and
  other abandoned policies. `OFFICIAL-HARNESS.md` describes the original
  winner, including its old cost uplift, not all current hardening.
  Reconcile them against the user's recorded later decisions before
  claiming rule-by-rule compliance.
- **Staleness is still price-based.** `services/appraisal/verification.ts`
  calls a sale stale below 70% of a pocket reference without checking the
  sale date. Sale-age filters exist separately. The user's request to
  define staleness by age is not completed.
- **Noise screening is unfinished.** The general package-deed/outlier
  screen remains unshipped. One outlier being excluded by lot or
  classification rules does not prove the whole evidence set is clean.
  Rate construction and fallback paths need coverage too.
- **Condition precedence remains mixed.** `bCondTier` still reads
  `tier:median`/`tier:premium` before the confidence floor and most
  structured conditions. Distressed condition has an earlier guard.
- **Grade checks are incomplete.** `gradeResult` does not examine driver
  verification stamps or prove bracketing. The actual `T4 assessed`
  result has `conf: none`, which reaches the withheld branch before the
  intended floor-source branch; the current floor test uses `conf: low`.
- **Missing rural evidence:** some wide-scope call sites allow selection
  when the subject reference is null. The subject's "renovated" reference
  can be the upper half of tract prices rather than condition-verified
  renovated sales. Review against the approved rural intent.
- **Recalc is partial parity.** It can retain a prior ARV when Set-B
  returns no answer; it refreshes result grade with an empty attempt
  trail, carries some prior top-level fields, and does not pass all initial
  valuation options. Prove ARV, confidence, grades, offer, settings, and
  selected evidence together. Browser mapping/routing work waits for Claude.
- **Enrichment waves:** the approved top-six/next-six stopping strategy
  and its durable evidence log have not been completed.
- **Repeatability:** subject condition/rehab reads, model versions,
  valuation date, settings, and all rules inputs need to be pinned in the
  run record before live repeat runs can serve as deterministic proof.
- **Regression acceptance:** do not inherit the earlier “all phases done”
  claim. The prior thread recorded broad replay drift and a vintage-year
  regression failure. No new test suite or corpus replay was run for this
  status review, and no accuracy against real sales was established.

## Recommended continuation

1. Reconcile the current policy record without changing valuation behavior.
2. Capture exact evidence/options and every Set-B call in a durable run
   record, including reruns and failed persistence.
3. Finish strict replay over fixed fixtures, stable rule IDs, record
   integrity checks, and an enforced review artifact.
4. Fix confirmed harness defects one at a time, comparing the same frozen
   cases before and after. Keep policy changes separate from repairs.
5. Add actual-sale outcome capture; keep CDARV shadow-only.
6. After Claude's UI pass, finish selection/save/reload parity and the
   technical plus appraisal acceptance gate.

No runtime code or UI was changed during this review. This note does not
authorize deploying, changing thresholds, or importing parked rules.
