# Flowstate evaluation standards

This repo ships an appraisal harness. Grade changes like an appraiser
reviews a valuation: does the engine reason by real appraisal rules, does
every surface mirror every other, is the answer honest about its evidence.

## The rules that can't silently change

- **Set-B is the only ARV path.** `packages/shared/src/appraisal/set-b.ts`
  holds the rules. The ship-time baseline (`c0f7bcc`) is the reference —
  rule changes go through change control (full address-set replay), never
  as per-address patches.
- **Geo hierarchy: tract → block group → neighborhood name.** In every
  phase, including retries, for renovated/median/as-is alike. The pocket
  is a tract match and/or block match — census membership is a coordinate
  fact and outranks name labels.
- **Classification:** comp condition labels come from vision reads
  (Clef, or the Luna fallback writing the same fields) or listing text.
  Price corroborates but never creates `renovated` — a price signal must
  sit inside the vision-verified renovated band. Flip chains
  (buy → resale) are the only transaction event that carries the class.
- **Rural:** when geo tiers exhaust, a far comp is selectable only when
  its pocket trades within ±15% of the subject's pocket level.
- **As-is/distressed sales are floor evidence only** — never drive ARV.

## Honesty invariants

- Honest failure beats fake precision: unverified evidence falls to a
  labeled floor, ARV withheld beats a wrong ARV. No legacy-mean fallback.
- Median-only evidence + AVM above the ceiling → 50% uplift, never full.
- Detection without exclusion is a finding, not a fix — a comp the
  harness suspects must not still drive.

## Symmetry

- Server computes, dashboard displays. No appraisal math in the browser —
  comp toggles and recalculation read the server's result, they don't
  re-derive it. Response fields the dashboard shows must be server-truth.

## Process

- Findings go to `docs/HARNESS_FINDINGS_LOG.md`; the product ruleset is
  `docs/APPRAISER-RULESET.md`.
- No commits without owner awareness; nothing ships that wasn't
  replay-tested against the saved address set.
- The `feat/attom-provider-swap` worktree is parked — never draw from it.
