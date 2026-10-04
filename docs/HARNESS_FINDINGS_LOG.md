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
| 5 | 2184 Dunseath Ave NW, Atlanta GA 30318 | min-3 | $1,110,927 (unverified, low) | ~$450–525K | badly wrong — one $1.6M sale at 67% weight |
| 5 | same | current (saved replay) | $466,159 | same | in range — 21-day cache served pre-reconcile code; `skipCache` forces fresh |
| 5 | same | min-3 + pocket/no-ARV fixes | $313,966 (AVM floor, "no verified drivers") | same | outlier caught — but size grid (±437sf) disabled every real comp too; floor ≠ value |

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
- **F15. In-tier outlier takes top weight.** 2360 Bolton Rd NW ($1.6M,
  1,415 sf, 0.65 ac, $1,131/sf — 3–4x every other sale, no AVM check) gets
  67% weight. It also sets the pocket rate, so normal sales ($365K, $420K)
  are thrown out as "55–67% below the pocket". Confirmed live: Dunseath
  ARV $1,110,927, buy price $769,714. — open
- **F25. Outlier is flagged but not removed — and is promoted.** Bolton Rd
  was stamped "423% of pocket — premium evidence, verify" and
  "unverified" (no comp AVM), but only `divergent`/`stale` stamps block a
  comp. The classifier then labeled it `after_renovation` because it
  "sold 410% above subject AVM" — price alone made it ARV evidence. The
  warning never reached the flag trail or risk flags. (Dunseath) — open
- **F26. Geography tiers ran in order but on a poisoned rate.** All 7 pool
  comps were same-tract; 4 same block group. The block-group tier went
  first (correct), but its pocket rate was the midpoint of two sales
  ($1.66M and $466K = $949K), so same-tract sales were rejected against
  it. A third same-block-group, same-subdivision sale (1951 Sumter St,
  $350,000, corroborated) was dropped with no flag. (Dunseath) — open
- **F24. Subject condition unknown, rehab level assumed.** Dunseath had no
  condition read ("NA") yet priced Full Cosmetic ($130,120). — open
- **F27. Eval cache is harness-version-blind.** The 21-day result cache
  keyed on address + params returned a report produced by the
  pre-reconciliation code ($466K, anchor path) against the current
  harness ($1.11M, reconcile path). Same address, two ARVs 2.4× apart
  depending on when the cache wrote. `skipCache` bypasses; nothing stamps
  the code version into the key. (Dunseath) — open
- **F28. Size grid emptied the pocket.** After the outlier exclusion +
  tract pocket landed, EVERY real comp on Dunseath was still disabled —
  all ~950–1,400 sf vs the 1,566 sf subject, over the ±437 sf cap (grid,
  not verification). Result fell to the AVM floor despite corroborated
  pocket sales at 90–156%. A comp 600 sf smaller is still evidence —
  size adjustment exists for exactly this. Related: F5, F26. — open

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
- **F21. Served ARV does not replay from the saved report.** The pipeline
  overwrites a comp's square footage with the listing size (or a permitted
  addition) before `evaluateB` runs (`evaluation/index.ts:1184-1195`,
  `:1135-1136`), but the response is built from the untouched originals
  (`analysis/index.ts:1400-1402`, `:1478`). On Ashley Lake, 2106 Blaylock
  Dr was 2,567 sf in the math and 1,743 sf in the saved report, so the
  dashboard recalc cannot match the server. — open
- **F22. Dashboard recalc cannot reproduce a rung 4–5 answer** (no
  devalue/stale flags passed). — open
- **F23. No unit tests on `evaluateB`.** Golden-case ranges were derived
  from the ruleset, not from closed sales. — open

## Product-engineer decisions (2026-10-04)

- **Official harness:** the original A/B-tested Set-B (`set-b.ts` at
  `5953349`, Python reference `scripts/ab-eval.py`) plus its tricks of the
  trade. Later additions are audited keep / drop, not assumed.
- **Engine of record:** TypeScript (`ts-v5`). The Python engine in
  `services/eval-engine` is not the live path.
- **Dashboard recalcs move to the server.** The dashboard displays; it
  does not compute.
- **Weak evidence:** the target is an after-repair value. Worst case the
  result is a range. Either way it must be evidence-backed, and the loops
  run toward a buy price under the appraisal rules.
- **The 25-comp cap is intentional.** Intent: enrich the comps that match
  the subject's tract, block group, and neighborhood; when there are fewer
  than 25 of those, fill with the closest by distance.
- **Pocket = tract match and/or block match.** The pocket reference rate
  draws on the tract pool (block group + tract matches), never a 2-comp
  closest-tier median — a single outlier must not be able to define the
  pocket. Applies to the market-area check, pocketRatio verification, and
  stale-adjust repricing alike. (Dunseath, F15/F26) Open question, not
  yet checked in code: whether the 25 the provider returns are picked that
  way, or simply the 25 nearest.
- **A run's record must not fail to save.** The storage design has to make
  that true (save the record before the math answers, then copy it to
  long-term storage with retries), rather than failing runs.
- **Storing provider data is allowed.** Saved runs can be checked into the
  repo as fixtures.
- **Enrichment runs in waves (approved).** Rank comps on free data first
  (same block group, then same tract, then same neighborhood, then
  nearest), drop noise before spending a call, enrich the top 6, and stop
  once 3–6 good comps pass. If fewer pass, enrich the next 6. Ceiling 25.
  The wave size of 6 is a starting value to tune on the address set.
- **Classify first, then pick.** The harness does not just grab one
  anchor — it classifies every usable comp into its evidence class:
  renovated anchors, medians, and as-is. Selection happens inside the
  class, never across it.
- **Geo hierarchy holds in every phase: tract 1st, block 2nd,
  neighborhood 3rd.** First try or retry, for renovated anchors, medians,
  and as-is alike — tract matches first, then block matches, then
  neighborhood matches. (Overrides audit K17's proposed block-first
  ordering; matches ruleset R1.)
- **Rural rule.** When neighborhood matches fail, the subject is likely
  rural. A distant comp can still be eligible — by pocket equivalence:
  find the comp's own pocket value (its renovated level, median level,
  or AVM — whichever exists) and compare it to the subject's pocket value
  (renovated comps, median comps, or AVM). If the pockets are priced
  alike, the comp may be considered for selection.
- **Comp condition classification: Clef first, GPT-6 Luna fallback.**
  Comps get classified by Clef vision; if Clef fails, Luna classifies
  instead — using the same classification fields (renovated, dated, …).
  Subject classification and comp classification are separate paths and
  must never mix — the Luna fallback fills the comp fields only.
