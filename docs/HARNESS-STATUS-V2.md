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
| Compliance | `scripts/replay.mts` reads `run_records` first, verifies payload hashes, replays the last frozen attempt, compares ARV/source/anchor/drivers/confidence/flags/check IDs/result grade/process grade/buy price/rehab/ROI/recommendation, and supports `--strict`, `--report`, and `--snapshot-out`. `scripts/audit-run-records.mts` independently audits saved records for stale/noisy/divergent drivers, grade mismatch, missing evidence, and hash failures. |
| Result | `result-grade.ts` separates verified/weak/floor/withheld from clean/retried/unverified. Floor sources are checked before withheld, and `verified` requires at least three drivers with usable verification evidence. |
| Feedback | Reports can record append-only actual-sale outcomes in `report_outcomes`, linked to the report and latest/specific run record, without changing the issued ARV. |
| Change control | `fixtures/snapshots/bagpipe-2026-10-05.run-record.json` is a frozen replay fixture. `npm run replay:snapshots` runs strict replay. The candidate workflow runs it. Result-cache keys include `HARNESS_VERSION`. |
| Runtime | `rules.models`, `rules.providers`, and `rules.valuationDate` pin the active model/provider context and valuation date inside each hashed run record. |

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
  - `apps/api/tests/comparable-retrieval.test.ts`
  - `apps/api/tests/rural-pocket.test.ts`
- `npx tsc --noEmit -p apps/api/tsconfig.json`
- `npm run replay:snapshots` — eleven frozen run records pass strict replay.
- `npm run audit:snapshots` — twelve frozen run records pass the independent record audit.
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
- **Structured condition wins.** Confident condition reads take precedence
  over legacy `tier:*` text; low-confidence reads stay unverified.
- **Stale/low AVM cannot mint ARV support.** Own-AVM evidence now needs a
  15% premium, and below-pocket sales cannot qualify through the subject-AVM
  fallback.
- **Transaction noise is explicit.** Same-day same-price package deeds,
  same-day shared-party bulk sales, nominal sales, and extreme price outliers are stamped and cannot drive ARV.
- **Rural wide-scope evidence must prove market fit.** Subject AVM/sqft is
  used first; same-scope comp AVMs can establish the reference when the
  subject AVM is missing; missing evidence cannot rescue an adjacent comp.
- **Paid enrichment runs in ranked waves.** Dead and package-deed comps skip
  paid calls; live candidates enrich six at a time, stop after three usable
  ARV-evidence comps, and cap at 25 paid enrichments.

## Still open

- Extend transaction-noise screening beyond the shipped same-day same-price
  package-deed, bulk-sale, nominal-sale, and extreme-outlier checks;
  cross-date or document-only variants remain open.
- Audit any remaining condition reads outside `bCondTier`; Set-B now trusts
  structured condition and confidence before legacy `tier:*` text.
- After Claude's UI pass, verify server → dashboard → selection change →
  save → reload parity in a browser.
- Extend the independent auditor. It now checks the evidence contract and
  record integrity; deeper policy checks still remain.
- Add representative live fixtures: rural/large-lot, dense subdivision,
  older/historic, and failure paths. Synthetic fixtures already cover
  verified, floor, package-deed, distressed-only, and withheld outcomes.
- No production migration or deploy has been run from this work.

## Known local fixture

`fixtures/snapshots/bagpipe-2026-10-05.run-record.json`,
`anglewood-2026-10-05.run-record.json`,
`charles-2026-10-05.run-record.json`,
`constitution-2026-10-05.run-record.json`, and
`dunseath-2026-10-05.run-record.json` are live-data replay contracts.
`fixtures/failures/unresolvable-address.run-record.json` covers a real
provider-resolution failure. Five
smaller synthetic fixtures cover verified, floor, package-deed,
distressed-only, and withheld outcomes. Strict replay currently passes 11/11.
These prove deterministic replay and hash integrity;
they do not prove appraisal accuracy against actual sales. `npm run
audit:snapshots` audits eleven replay records plus the failure record without
re-running Set-B.
