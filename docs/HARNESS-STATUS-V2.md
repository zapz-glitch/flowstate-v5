# V2 harness status

Current worktree: `/home/lucke/src/flowstate-v5-attom-v2`
Branch: `feat/attom-provider-swap-v2`

This file tracks the evidence and compliance harness. UI edits are owned by
Claude in the same worktree and are intentionally not part of these API
commits.

## Settled base

- TypeScript Set-B is the appraisal engine.
- ATTOM MCP remains the property-data provider.
- One anchor drives value; supporting sales bound the answer.
- The 19 parked rules remain separate and are not imported as a bundle.
- Do not restore min-three reconciliation, price terciles, old devalue or
  time-reprice rungs, or land-extraction outputs.
- Address runs are read-only evaluations, not permission to change policy.

## Implemented evidence layers

| Layer | Current state |
|---|---|
| Facts | Every run can write a canonical `run_records` payload with request, subject, comps, effective settings, Set-B attempts, result, hashes, and timestamps. |
| Harness | Set-B receives the frozen comps and options from each recorded attempt. |
| Trace | `bMechanics.flags` are paired with stable `checks[].ruleId` values in `services/analysis/rule-registry.ts`. |
| Compliance | `scripts/replay.mts` reads `run_records` first, verifies payload hashes, replays the last frozen attempt, compares ARV/source/anchor/drivers/confidence/flags/check IDs/result grade/process grade/buy price/rehab/ROI/recommendation, and supports `--strict`, `--report`, and `--snapshot-out`. |
| Result | `result-grade.ts` separates verified/weak/floor/withheld from clean/retried/unverified. Floor sources are checked before withheld, and `verified` requires at least three drivers with usable verification evidence. |
| Feedback | Reports can record append-only actual-sale outcomes in `report_outcomes`, linked to the report and latest/specific run record, without changing the issued ARV. |
| Change control | `fixtures/snapshots/bagpipe-2026-10-05.run-record.json` is a frozen replay fixture. `npm run replay:snapshots` runs strict replay. The candidate workflow runs it. Result-cache keys include `HARNESS_VERSION`. |

## Verified locally

- `node --import tsx`/`npx tsx` focused tests:
  - `apps/api/tests/run-record.test.ts`
  - `apps/api/tests/rule-registry.test.ts`
  - `apps/api/tests/result-grade.test.ts`
  - `apps/api/tests/evidence-verification.test.ts`
  - `apps/api/tests/comp-badges.test.ts`
  - `apps/api/tests/set-b-distressed-floor.test.ts`
  - `apps/api/tests/recalculate-no-stale-arv.test.ts`
  - `apps/api/tests/eval-cache.test.ts`
- `npx tsc --noEmit -p apps/api/tsconfig.json`
- `npm run replay:snapshots` — frozen Bagpipe run record passes strict replay.
- Local D1:
  - `run_records` exists and stores separate rerun records.
  - `report_outcomes` exists and returned a Bagpipe outcome linked to a run record.
  - `run_records.archive_*` columns exist.
- Local R2:
  - Bagpipe's latest record archived to `run-records/<job>/<record>.json`.
  - The archive retry route returned 200 and left `hashOk: true`.

## Corrected semantics

- **Stale means old.** `evidenceVerification.staleness` is now based on the
  configured preferred `sale_age` window, not price. A recent low-priced sale
  is `marketFit: below_pocket`; it is not stale.
- **Market fit is separate.** `marketFit` records `in_range`,
  `below_pocket`, `above_pocket`, or `unverified`.
- **Legacy payloads are handled conservatively.** Old records that used
  `staleness` for pocket-price fit still map into the corresponding
  market-fit exclusion during replay.
- **No stale ARV retention.** A comp-selection recalc that produces no Set-B
  answer now withholds ARV and clears downstream offer fields instead of
  keeping the old number.
- **Record integrity is separate from process grade.** `hashOk`, archive
  fields, and run-record status are exposed through report APIs; a `clean`
  process grade does not claim that storage is complete.

## Still open

- Reconcile `APPRAISER-RULESET.md`, `APPRAISAL_HARNESS.md`, and
  `OFFICIAL-HARNESS.md` with the decisions actually implemented.
- Extend transaction-noise screening beyond the shipped same-day same-price
  package-deed and nominal-sale checks; bulk-sale variants and broader
  outlier policy remain open.
- Audit any remaining condition reads outside `bCondTier`; Set-B now trusts
  structured condition and confidence before legacy `tier:*` text.
- Review rural wide-scope paths where missing reference data can weaken the
  evidence test.
- Finish the approved enrichment waves: best six, then next six, stop when
  enough defensible evidence exists.
- Pin any remaining mutable inputs needed for perfect live reruns. Model and
  provider names plus valuation date are now recorded in `rules`.
- After Claude's UI pass, verify server → dashboard → selection change →
  save → reload parity in a browser.
- Build the deferred independent rule auditor. Replay proves the result
  changed or did not; it does not prove every configured rule was followed.
- Add more representative frozen fixtures: rural/large-lot, dense
  subdivision, older/historic, distressed, withheld, and failure paths.
- No production migration or deploy has been run from this work.

## Known local fixture

`fixtures/snapshots/bagpipe-2026-10-05.run-record.json` is the current strict
replay contract. It proves the Bagpipe run record reproduces under
`og-2026.10.04.1` with hash verification. It does not prove appraisal
accuracy against an actual sale.
