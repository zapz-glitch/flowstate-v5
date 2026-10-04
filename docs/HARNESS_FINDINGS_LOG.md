# Harness findings log

Running notes from address evaluations. Each address is a read-only run —
no harness change is made per address. Findings are collected here and
resolved together when the v2 harness is designed (after the OG vs new
A/B test).

Harness versions:
- **current** = `feat/attom-provider-swap` (single anchor + bounds)
- **min-3** = `feat/set-b-min3-reconciliation` (3–6 sales reconciled)
- **OG** = `set-b.ts` at `5953349` + retry loop `c0f7bcc` (the A/B-tested port)

"Appraiser read" below is the engineer's reading of the comp sales, not a
licensed appraisal and not ground truth.

## Address runs (2026-10-04)

| # | Address | Harness | ARV | Appraiser read | Verdict |
|---|---|---|---|---|---|
| 1 | 115 Charles Ave SE, Marietta GA 30067 | current | $252,834 (unverified) | as-is ~$255–264K; renovated ~$290–300K unproven | not an ARV |
| 1 | same | min-3 | $285,786 (thin, unverified) | same | 2 sales of ~$240K each adjusted up ~$45K |
| 1 | same | OG (replay) | $333,353 ("verified") | same | too high — $240K sale + 80% rehab bump |
| 2 | 4425 Chestnut Lake Ave, Lithonia GA 30038 | current | $272,646 | ~$228K | too high — anchored on 2.1-acre comp |
| 2 | same | min-3 | $239,960 (3 runs, identical) | ~$228K | close; acreage comp still 27% weight |
| 2 | same | OG (replay) | $218,602 (1 comp) | ~$228K | close, single comp |
| 3 | 1176 Ashley Lake Dr, Marietta GA 30062 | min-3 | $513,299 | ≥$526K as-is; renovated higher, unproven | too low — ignored next-door sale |
| 4 | 1643 Bagpipe Pl, Conley GA 30288 | min-3 | $205,963 | ~$225–250K | plausible, wrong method |

## Findings

Status: `open` until resolved in the v2 design.

### Comp selection
- **F1. Rule-disabled comps carry weight.** A comp flagged "Lot category
  mismatch — not comparable" (2.10 ac vs 0.14 ac, different subdivision)
  anchored the ARV on current and holds 27% on min-3, with $0 land
  adjustment because the land-rate slope was $0.00/sf. (Lithonia) — open,
  needs policy call: are lot-category mismatches hard?
- **F2. The best comp is skipped.** A same-street, same-subdivision,
  same-size sale ($526,000, 0.07 mi) did not drive; three unverified sales
  1.1 mi away on small lots did. (Ashley Lake) — open
- **F3. Renovated sales nearby go unused while dated sales get marked up.**
  Sales of $225–268K within 0.7 mi were excluded on age or subdivision name;
  three dated sales of $145–213K were bumped to ~$206K. (Bagpipe) — open
- **F4. Bulk / portfolio sales are not detected.** 11 of 30 comps on
  Marietta were same-day deeds at $747K–$3.4M; two passed the rules grid.
  They also inflate the pocket $/sf reference, which marks real sales
  "stale". (Marietta, Lithonia has two) — open
- **F5. Price terciles decide ARV eligibility** (current). A $5–7/sf gap
  demoted every rule-enabled comp on Lithonia and left one driver on
  Marietta. — open (min-3 bands on size-adjusted price instead)

### Adjustments
- **F6. Adjustment stacking.** Two ~$240K sales become ~$286K each via
  bed/bath + land + size adjustments. (Marietta, min-3) — open
- **F7. Bed/bath double-count rule is inert in the pipeline.** Call sites
  pass only `totalAdjustment`, not the adjustment list, so rule 13 never
  runs; Branchwood golden case fails in the pipeline ($257,400 vs
  $285–300K). — open, plumbing fix
- **F8. "Time adjustment" is not time-based.** Rung 5 reprices any low
  sale up to the pocket $/sf (+50% on a 3-month-old sale, +100% on
  others). (Bagpipe) — open
- **F9. Renovation uplift is manufactured.** OG adds 80% of rehab cost in
  most runs; min-3 adds "market gap × rehab fraction" ($37,532 on Bagpipe;
  $416K on a saved Grande Vista replay). — open
- **F10. Outlier ceiling no longer caps** on min-3: two stacked drivers
  count as each other's supporters. (Marietta) — open
- **F11. Bogus land outputs.** "Extracted land $2,267,558 — land play" on
  a $513K house; "extracted dirt $273,245" above a $252K ARV. — open

### Honesty / failure behavior
- **F12. Unverified results still ship as the ARV with a buy call.** The
  rulebook (§6) says they fall to a floor tier; the code applies them.
  (Marietta) — open, needs policy call
- **F13. Retry ladder uses the AVM as a trigger**, against rulebook rule 9
  (AVM has zero influence). — open, needs policy call
- **F14. Min-3 is rarely met.** Fewer than 3 sales on 40 of 45 saved
  pools at first try (offline replay). — open
- **F15. In-tier outlier takes top weight.** One $1.6M sale gets 67% on a
  saved Dunseath replay ($1.26M ARV). — open

### Reporting
- **F16. Confidence labels disagree.** `valuation.confidence` says "high"
  with "N verified flip resales" while `bMechanics.confidence` says
  "medium"/"low" and no driver is a verified flip. (all four addresses) —
  open
- **F17. Polluted display fields.** `afterRenovationValue` $1,430,815 and
  avg comp $2,039/sf on Marietta. — open
- **F18. Call stats labeled "corelogic"** on an ATTOM run. — open, cosmetic
- **F19. Clef confidence floor is bypassed.** A "Renovated" label at
  confidence 27 (floor 30) is treated as a verified renovated anchor. —
  open

### Stability / symmetry
- **F20. Buy price swings between identical runs.** Vision read "Heavy
  Rehab" on two runs and "Full Cosmetic" on one for the same 12 photos:
  rehab $93,175 vs $77,025, buy price $72,789 vs $98,939. ARV was
  identical. (Lithonia) — open
- **F21. Served ARV does not replay from the saved report.** Live $513,299
  vs offline replay $529,419; widened comps appear to be valued before
  their major-road stamps land. Cause not confirmed. (Ashley Lake) — open
- **F22. Dashboard recalc cannot reproduce a rung 4–5 answer** (no
  devalue/stale flags passed). — open
- **F23. No unit tests on `evaluateB`.** Golden-case ranges were derived
  from the ruleset, not from closed sales. — open
