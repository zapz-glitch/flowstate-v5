# Harness keep / drop audit (2026-10-04)

**Base:** the original A/B-tested Set-B harness ("OG") — `set-b.ts` at
`5953349`, Python reference `scripts/ab-eval.py` at `31cdd3f`. The product
engineer chose it as the official harness. This audit reviews everything
added after it and says what to keep on top of it.

**Standard:** national appraisal practice and `docs/APPRAISER-RULESET.md`.
Would a top appraiser do this? Is it repeatable? Does it keep noise out?

**Method:** 11 reviewers. Each later rule was split out, judged, and run
alone on top of OG over 48 saved comp pools. A second reviewer then tried
to overturn each verdict. Read-only; no provider calls. No true resale
prices were available, so "better" means closer to the band of real comp
sale prices — a proxy that favors OG slightly, because the band is built
from the comps OG uses.

Status of every row below: **proposed — not approved, nothing built.**

## Headline findings

1. **No later commit adds a formula that cuts price outliers.** The noise
   screen the product engineer asked for does not exist in any version.
2. **The Dunseath $1.6M outlier came in through a later addition, not
   through OG.** Commit `d4cc12c` made the lot-size filter soft. With that
   filter hard again, OG gives Dunseath $418,562 (was $1,434,322) and
   Lithonia $228,178 on 4 comps. A plain revert breaks the Baywood golden
   case, so the fix is a lot-ratio rule, not a revert.
3. **Taken together, the later additions moved answers away from the comp
   band and upward.** Inside the band: OG 16 of 48, after the 12 commits 13,
   after min-3 11. Extreme results: 9, 16, 15.
4. **OG has real defects of its own** (section 4). Choosing OG as the base
   does not make them go away.

## 1. Keep on top of OG

| # | Rule | From | Change needed |
|---|---|---|---|
| K1 | Ceiling comes only from similar, verified comps | `8b5c830` | Keep the 60% gate as written. Caveat: 6 of its 8 moves land under the as-is AVM. |
| K2 | Distressed / as-is sales never drive ARV | `8b5c830` | Only works with K3. Also close the median-fallback path. |
| K3 | Read Clef's physical condition, not its "tier:" token | `22d77af` (label half) | One package: confidence floor first, then the structured condition field. Unknown condition = typical tier, never renovated. |
| K4 | Mis-sized comps are excluded | `c4ef619`, `a552e48` | Plain exclusion from drivers, ceiling, and rate fits. Flag both sizes. Never overwrite a comp's square footage. Ignore a "marketed size" that equals the lot size. |
| K5 | Subdivision name cleanup ("UNIT NO 4" = "UNIT 4") | `ef313da` | None. |
| K6 | Same-block-group renovated comp anchors first | `d8674d7` | Apply the confidence floor before trusting the label; pick from the similarity-ranked list so order cannot change the answer. |
| K7 | Rescue of rule-disabled comps | `ef313da` | Not on the first try. Extend OG's existing rescue step with an allow-list: size gap, lot gap, sale age up to 365 days, name-only mismatch inside the block group. Keep its distance and tract limits. |
| K8 | Lot-size difference is adjustable, not disqualifying | `d4cc12c` | **Mandatory fix first:** soft under about 2x the subject's lot, hard above. Acreage category stays hard. |
| K9 | Python verify checks the port dropped | `ab-eval.py:474-487` | Restore: thin evidence, uncorroborated top driver (test the stamps, not flag text), below evidence median, above 1.25x the top driver. |
| K10 | Retry ladder: widen, then deepen | `c0f7bcc` | Widened comps must pass the same rules grid as first-pass comps. A widened comp may not replace a grid-passing in-tract sale. |
| K11 | "Unverified" risk flag | `bbfb42f` | Keep the flag. What the product does with an unverified answer is decision D5. |
| K12 | Single-comp flag | `6e6312a` | Flag every one-comp answer; drop the AVM condition. |
| K13 | Same-parcel dedupe | `5dfa507` | Keep the most recent arm's-length sale. Keep the earlier purchase as a paired sale (buy = as-is, resale = renovated). |
| K14 | Pinned comp evidence stamps | `f6f6e5c` | Do not pin a blank; add the model version to the key; pin the subject photo read the same way. |
| K15 | Bed/bath not double-counted with size | min-3 `e0d7054` | Wire it at every call site (today it never runs). |
| K16 | Gross adjustment counts grid + size + land | min-3 | Keep. Do not admit size-unverified comps as the "last resort". |
| K17 | Tier order: block group, tract, neighborhood, widened | min-3 | Rank same street and same subdivision inside a tier. Run the noise screen first. |
| K18 | Renovation uplift measured from the market | min-3 | Measure the gap only between condition-verified renovated and dated sales. See decision D4. |
| K19 | Plumbing and display | `749b61d`, `808d60d`, `fbb2ce5`, `4a5db36`, `62eaf02`, `93d7d0d` | Keep: legacy path removed, dashboard shows server ARV, queryable mechanics, geo evidence, role labels, Redfin bed/bath fill. |

## 2. Drop

| # | Rule | From | Why |
|---|---|---|---|
| X1 | Comps with no condition read count as top-tier evidence | `ecddef4` | Makes "no evidence" the best evidence. One unread comp 1.54 mi away moved an ARV to $545,053. |
| X2 | Price terciles decide the tier | `30452d4` | Price picks the comps. 12 pools changed: 0 toward the band, 9 away. |
| X3 | A high price promotes a dated comp to ARV evidence | `22d77af` (upward half) | This is the exact door for lot-value and inflated sales. One run went $568,047 to $946,998. Touches approved rule 3 — see D6. |
| X4 | Tercile demotion of renovated comps | `22d77af` (downward half) | OG's existing 70%-of-pocket test already covers it without moving cut points. |
| X5 | Subdivision-name mismatch blocks the anchor | `a552e48` | Names are noisy; a sale two doors down was blocked on spelling. |
| X6 | Different block group can never anchor | `a552e48` | Block-group lines run down streets. Make it a flag and a confidence step-down. |
| X7 | "Devalue" rung, and its 0.33x–3x size band | `be8c59f` | A house a third the size is a different product. The rung trades the best comp for a comp count. |
| X8 | Lot-category mismatch made rescuable | `be8c59f` | Directly caused the Lithonia miss (2.1-acre comp anchored a 0.14-acre subject). |
| X9 | "Time adjustment" rung | `dbe5f3e` | Not time-based. It lifts any cheap sale to the pocket rate: minimum +43% by construction. |
| X10 | Land extraction and "land play" | `13bfe1b`, `4883cbd` | Built on invented constants. Flagged $2,267,558 of land on a $513K house. |
| X11 | Single-driver premium as a retry trigger | `1cce8aa` | An ARV 20% above the as-is AVM is normal for a flip. The thin check covers the real problem. |
| X12 | Permit text-match to resolve size conflicts | `a552e48` | A word match on free text, with no date check. Exclude the comp instead (K4). |
| X13 | "Thin means retry" as built | `80c3ea4` | Caused the Ashley Lake miss: a same-street sale at 67% weight was swapped for three far, unchecked comps. |
| X14 | Browser runs the harness | `93eea87` | Already decided: recalcs move to the server. |

## 3. Decisions for the product engineer

These are places where the approved ruleset and OG disagree, or where a
new rule is needed. Nothing here is decided.

| # | Question | Options | Reviewer's pick |
|---|---|---|---|
| D1 | Anchor or blend? | OG: one anchor, others bound it. Ruleset rule 6: reconcile 3–6 sales by weight. | Anchor sets the value; "verified" needs at least 2 other screened sales that bracket it. |
| D2 | Similarity cutoff? | OG: drivers must score 60% of the anchor. Ruleset rule 15: no similarity cutoff. | Open. |
| D3 | May the AVM influence anything? | OG: floor and retry trigger. Ruleset rule 9: zero influence. | Flag and "search harder" trigger only, with about 5% tolerance. Never decides verified vs unverified. |
| D4 | Renovation uplift | OG: 80% of rehab cost (not market-based; the ceiling clips it in most runs). | Market gap between condition-verified sales; when it can't be measured, no uplift and label the result "typical-condition value". |
| D5 | Unverified or thin answer | Already stated: an ARV ideally, a range worst case, always evidence-backed. | Open detail: does a range carry a buy-price range and a buy call? |
| D6 | Price as condition evidence | Ruleset rules 3–4 say price is 80% of the condition call and unread comps are banded by price. X2 and X3 are those rules as built. | Park both until the noise screen exists, then rebuild on screened, size-adjusted prices. |
| D7 | Noise screen | New step, not part of OG. | Approve the step; the first design needs another pass (section 5). |
| D8 | Minimum evidence count | OG reaches 3 drivers in about 5% of runs because its driver list is trimmed by design. | Count screened supporting sales, not trimmed drivers. |

## 4. Defects in OG itself

OG is the base, so these need fixing regardless of what is kept above.

- **The "renovated" tier is picked by price.** The label comes from "sold
  above its AVM" or "sold 15% above the subject AVM", with no upper limit.
- **The condition read is mostly ignored.** A "tier:median" token is read
  first, so 31 of 42 replays ran on all-median drivers. K3 fixes this.
- **Distressed sales can drive ARV** through the median fallback. K2.
- **The market-based uplift is dead code;** only the cost-based one runs.
- **Most answers rest on one comp** (32 of 42 replays) and are still called
  "verified" in the TypeScript port. K9.
- **Confidence carries no information.** "High" is unreachable; 43 of 48
  replays say "low".
- **"Stale" is a price test, not a date test.** A recent cheap sale is
  "stale"; a 2021 sale at pocket price is "current".
- **Subdivision match is an exact string.**
- **The scoreboard did not test the shipped version.** The Python script
  changed about 12 times during scoring, and several rows were scored on
  the same address their rule was written for.

## 5. Noise screen — first design and its test

A first design was built and run on 47 full saved pools (1,616 comps).

**What it does:** runs before any valuation math. It removes duplicate and
same-day same-price package deeds, nominal sales, and wrong property types,
then builds a robust pocket rate (median, leave-one-out, at the subject's
size) and tests each sale against it. Verdicts: clean, exclude, hold, or
different class. A set-aside comp cannot set the pocket rate, the bands, the
ceiling, or the weights, and is shown with its reason.

**Results**
- Caught all 19 known noise comps (Bolton Rd, Francis Ave, the Marietta
  package deeds, the $25.3M and $7.6M deeds, the $3,800 and $40,000 sales).
- Marked 0 of 62 real flip resales as noise.
- Same input in any row order gave the same output (640 runs).
- Noise had moved the tract pocket rate by more than 3% in 7 of 47 pools
  (Marietta +36%).

**Why it is not ready (second reviewer)**
- It needs both a high ratio and a high statistical score, so messy pockets
  wave outliers through. Real misses: $924,000 and $915,000 same-day sales
  next to an identical house at $250,000.
- With 5 or fewer neighbors no test runs at all; Bolton Rd passes.
- Its "proof" paths can be fooled. A comp's own AVM often just echoes its
  sale (41% within 1%).
- Old sales still set the pocket rate (160 clean comps over 12 months old).
- The lot rule is wrong when the subject has the big lot: it removed 7 of
  62 real flips, including two near Ashley Lake.
- It must run in two passes to fit the approved wave enrichment: free data
  first, proof after.
- Missing checks: same-street same-size pairs, split-price packages, new
  construction, and deed type.

**Not verified:** no deed was checked for any flagged sale; Georgia and
Florida only. The 1.8x "renovated premium" line used in the design came
from the audit brief, not from any approved rule.

**What the screen does not fix:** Bagpipe and Ashley Lake barely move.
Their problem is comp selection, not noise.

## 6. Evidence

Scripts and outputs are in the session scratchpad, not in the repo:
`kd/first6_zq/`, `kd/other/`, `kd/steps/`, `kd/noise/`, `kd/adv/`,
`kd/chk/`. They should move into tracked fixtures when the build starts.
