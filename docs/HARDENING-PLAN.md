# Hardening plan — ship-time Set-B, hardened, synced

**Goal:** ship the A/B-winning Set-B harness + tricks of the trade,
hardened by the new rules, with the tools that keep it honest, and a
client that shows exactly what the server computed.

**Hard rules for this build:**

- The shipping harness is **ship-time Set-B only** — the file content at
  `c0f7bcc` (the A/B winner). Nothing added after it ships: no reconcile,
  no terciles, no devalue/stale rungs, no land extraction, no
  price-decides-condition patch.
- **The parked branch does not exist for this work.** Nothing is drawn
  from `feat/attom-provider-swap`'s session commits or uncommitted state.
  `c0f7bcc` is shared history — restoring the winner's own content is
  not drawing from the parked branch's new work.
- Every harness change runs the recorded address set; the answer diff is
  what gets reviewed. No per-address patching.
- No deploy until the product engineer says ship. `main` moves only by
  reviewed PR.

## Phase 0 — restore the winner

v2 sits on the drifted base (`set-b.ts` is +649/−185 vs ship-time).

1. Drop the v2 patch commit (`a093186`) — price-corroboration is
   superseded by the classification design below.
2. Restore these files to their `c0f7bcc` content:
   - `packages/shared/src/appraisal/set-b.ts` (the rules)
   - `packages/shared/src/appraisal/filters.ts` (1-line drift)
   - `apps/api/src/services/evaluation/index.ts` — the ladder reverts to
     widen → deepen; devalue/stale rungs, market-area gating, land
     extraction all out
   - `apps/api/src/services/evaluation/recalculate.ts` — ship-time recalc
3. Fix downstream consumers of dropped fields (`bMechanics.bandLo/thin/
   land`, reconcile roles) in `report.ts`, the analysis response, and the
   dashboard types — they must read ship-time output only.
4. Gate: `npx tsc --noEmit` + replay of the 5 saved address results
   (Charles, Chestnut Lake, Ashley Lake, Bagpipe, Dunseath) — answers
   must match what ship-time rules produce on that evidence.

The provider swap (ATTOM MCP) stays — it's infrastructure, not a rule.

## Phase 1 — harness rules (new design, on top of clean OG)

Each item is its own commit, each gated by a replay diff on the
address set.

1. **Comp condition classification chain.** Order of evidence:
   Clef curb-appeal read → listing description text → GPT-6 Luna vision
   fallback → price. Clef and Luna write the SAME comp classification
   fields (renovated / dated / …). Subject classification and comp
   classification are separate paths and never mix — Luna fills comp
   fields only. Price is corroboration only: a comp may hold "renovated"
   only when its price sits inside the band of the other renovated
   comps — price never promotes a comp on its own.
   - Touches: `services/comp-evidence`, `services/vision/renovation.ts`,
     `services/redfin-details` (listing text source), `bCondTier`,
     `set-b-input.ts`.
2. **Geo hierarchy everywhere: tract → block group → neighborhood.**
   First pass and every retry, for renovated anchors, medians, and
   as-is alike. (Overrides audit K17's block-first proposal.)
3. **Rural rule.** When neighborhood matches fail: a distant comp is
   eligible by pocket equivalence — its own pocket level (renovated →
   median → AVM, whichever exists) priced against the subject's. Same
   price level, counts.
4. **OG's own defects** (audit §4 — fix only what the owner approves):
   one-comp answers can't say "verified"; condition read before the
   `tier:` token; market-measured uplift made live; stale = a date test;
   subdivision matching normalized.

## Phase 2 — tools around it (fresh build, per the spec)

`docs/EVALUATION-SYSTEM-SPEC.md` is the design; build ours here:

1. **Facts:** snapshot record per run — frozen inputs per rules call,
   the comp pool (decided: in), the served block, rule manifest, SHA-256.
   Saved before the answer is used; a lost record never lets the run
   look verified.
2. **Trace:** rule IDs on every flag — our own registry mapping to
   `APPRAISER-RULESET.md`.
3. **Compliance:** `replay` + `replay:all` scripts (offline, free) —
   scoreboard over `fixtures/snapshots/`; DRIFT lines are the review
   artifact. `--strict` becomes the pre-merge gate (decided).
4. **Result:** evidence grade `verified / weak / floor` from the price
   stamps + process grade `complete / incomplete`. One confidence label
   everywhere (kills F16).
5. **Feedback:** manual outcome field on the saved report — the owner
   marks what the property really sold for.

## Phase 3 — server⇄client symmetry (the rehaul)

The client must never do math the server wouldn't reproduce.

1. **Delete browser `evaluateB`** — `apps/dashboard/src/lib/recalc`
   runs the harness in the browser today (two call sites). Comp toggles
   go through server recalc only.
2. **Recalc reproduces the run exactly** — the server needs the same
   inputs AND the same options the run used (closes F21, F22): the
   serialized comp set must carry what the rules saw (incl. the sqft the
   math used), and the request must name the ladder rung's options.
3. **One vocabulary** — dashboard shows the server's grade and flags
   verbatim; no second confidence.
4. **Pin it:** a test proving displayed ARV == server ARV for every
   saved fixture (the shape the ship-parity test implies — written by
   us, for our code).

## Phase 4 — ship gate

- `tsc --noEmit` clean; `replay:all` green on the full address set;
  known-defect tests flipped where fixed.
- Golden cases re-derived and approved.
- PR to `main` — merge = deploy. The scoreboard diff is the review page.

## Open confirmations

1. Restore = literal `c0f7bcc` content (incl. its cost×80% uplift and
   2-rung ladder), then new rules land on top? — assumed yes.
2. The keep-list (K1–K19): default is none of it ships now; items can be
   re-proposed one at a time under change control. OK?
3. Snapshot/replay machinery gets rebuilt here rather than ported —
   same spec, our implementation. OK?
