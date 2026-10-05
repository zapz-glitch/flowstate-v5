# B Harness + Tricks of the Trade

> Historical record of the harness that won the A/B test and shipped.
> The script that ran it: `scripts/ab-eval.py` (reference version at
> commit `31cdd3f`). The shipped port: `packages/shared/src/appraisal/
> set-b.ts` at `5953349` + the retry loop at `c0f7bcc`.
> This is not the current ruleset — `docs/APPRAISER-RULESET.md` and
> `docs/FILTER-LADDER.md` govern today's V2 harness.

## The timeline

**2026-10-02, evening** — the live A/B test begins on
`feat/attom-provider-swap`. Set A = the pipeline's existing ARV math.
Set B = the appraiser "trade tricks" spec, recomputed by
`scripts/ab-eval.py` off the same API results — same comp pool, different
math. `1ff47c1` (19:44): "A/B calibration in progress, B=1".
`bb502c8` (19:58): first proven findings committed — Geraci Rd, Tampa,
40th St S.

**2026-10-03, overnight** — the methodology is built out inside the
Python script, one rule at a time, each tested on the address set as it
lands. Fourteen commits, 01:49 → 05:32.

**2026-10-03, 05:47 — the day the A/B was won and the ship decision
landed.** Commit `5953349` ports the calibrated methodology to TypeScript
(`set-b.ts`) with the verdict in the message: **27-case scoreboard,
A=2 / B=26**. It ships as *parallel* output first — `valuation.arvB`
next to `valuation.arv`, unchanged until the swap decision. Live parity
proof in the same commit: Indianapolis run, arvB $318,659 vs harness
$319,059 (0.1%, serialized-field variance), identical flag trail.

**2026-10-03, 14:46** — `c0f7bcc` adds the verify-and-retry ladder
inside the pipeline (widen → deepen). Ship-time harness = `5953349`
+ `c0f7bcc`.

**2026-10-03 → 10-04** — post-ship drift: price terciles, devalue /
time-adjust rungs, land-extraction "land play", min-3 weighted
reconciliation.

**2026-10-04** — `docs/HARNESS_KEEP_DROP_AUDIT.md`: every later layer
measured alone on 48 saved pools. Taken together they moved answers
*away* from the band of real comp prices (in-band: 16 → 13 → 11 of 48;
extreme results: 9 → 16 → 15). Product-engineer decision the same day:
the ship-time B harness is the official harness again — `f279560`,
`982b13f` restore it. Nineteen additions kept, fourteen dropped.

## What the A/B test actually showed

Twenty-seven scored live addresses. B won 26, A won 2, one run had no
winner (Surrey Bnd — 0 of 13 comps enabled on both sides; a legitimately
thin golf-community pool, no evidence for either math to use).

The wins were not "B guesses better" — each one was a mechanism catching
a specific, named failure of A:

| Address | What happened | Rule it earned |
|---|---|---|
| 18810 Geraci Rd | A's full-proportional sqft scaling charged ~$407/sf for a 256sf gap → invented $104k ($664k on a $560k comp). Marginal scaling + the outlier ceiling restored the real sale price. User verdict: "that saved this evaluation." | Marginal-rate sqft scaling; outlier ceiling |
| 4507 E 24th Ave, Tampa | B averaged an all-as-is pool to $184,637 on a property whose closest comp sold $300k+. | No-ARV-tier refusal — an as-is-weighted pool yields an as-is value, not an ARV |
| 2821 Eagle Run Cir S (run 1) | **A's only win** — B anchored a stale 2020 sale. | Verification layer born: stale/divergent stamps; pocket catch (runs 2–3 went to B) |
| 3814 E Cayuga St | A blended +31% above its own evidence on 2 comps. B anchored the corroborated 0.08mi comp and capped at its actual sale — the comp's own AVM ($315k) agreed with B. | Anchor, don't blend |
| 331 Marie St | A solo driver at similarity 0.2 dragged the answer. | Similarity floor + median fallback |
| 7230 Toledo Rd / 3232 Lenwood Dr / 2906 Oak Crest Dr | A blended sales at 60% / 43% / 45% below their own AVMs — non-arm's-length noise. | Divergent-sale exclusion |
| 205 Emerald Ln | Flat scaling on a small comp ($428/sf on 912sf) inflated to $448k; the >25% gap taper (0.30) landed $424.7k. | Marginal taper bands |
| 1801 Carlton Dr | Median anchor + contributory uplift → $341k, within $4k of the seller's $345k list — produced independently. | URAR condition adjustment |
| 4000 Indianapolis St NE | Anchor-floor invariant caught a bad anchor → widen/deepen → self-heal → $319k, convergent across independent runs. | Verify-and-retry loop |
| 1105 Woodcrest Ave | Single-comp pool; uplift computed but capped — no supporters. | Ceiling needs ≥2 supporters |

Cross-cutting findings that shaped the design:

- **A drifts upward on thin pools** — blends above its own evidence when
  1–2 comps drive (Cayuga +31%, Eagle Run +12% over the actual sale).
- **Proportional scaling misprices size both ways** — over on bigger
  subjects, under on smaller ones (21st Ave, 27th St).
- **Provider data can be wrong** — 2069 59th Way N actually sold ~$430k
  per the owner; ATTOM recorded $320k. Sale-vs-AVM cross-checks are
  load-bearing, not optional.
- **Most wins came from retrieval and catches, not math** — the
  market-context supplement pulling a missed next-door sale did more
  than any weighting tweak.
- **Similarity must gate AND weight** — an adjustment-only weight let a
  dissimilar far comp (w≈0.93) drag ARV ~$40k before the 60% gate.

## The shipped harness, mechanism by mechanism

Everything below is what `set_b()` in `scripts/ab-eval.py` (→
`set-b.ts`) actually does, in order.

### 0. Conclusion cascade — B never refuses outright

```
T0 verified ARV anchor (enabled comp pool)
T1 delta-adjusted rescue — comps whose ONLY kill is lot size, verified
   same pocket: ≤0.5mi, no major-road crossing, same tract/BG
T2 pocket-implied — same-tract median $/sf × subject sqft (needs ≥3)
T3 subject AVM floor
T4 county assessed value
T5 report-only — no comp evidence, no anchor
```

A comp pool that never materializes still yields a labeled floor, never
a made-up number.

### Trick 1 — Marginal sqft rate, measured not assumed

A comp's contribution = base price + size gap at the **marginal** rate,
never the average. The rate ladder:

- **T1 pool-derived**: least-squares price~sqft slope over ≥5 verified
  comps — same-tract first, then the whole fit pool. Stale/divergent
  sales are excluded from the fit. The slope must land below the pool's
  average $/sf or it is thrown out.
- **T2 taper** (when no fit is possible): the marginal foot is priced at
  50% of the comp's $/sf for gaps ≤10%, 40% for gaps ≤25%, 30% beyond —
  inside the appraiser 25–50% marginal range, declining as the gap grows.

Why: Geraci proved full-proportional pricing invents value — the
marginal foot of a house is worth less than its average foot.

### Trick 2 — Marginal land rate ladder

- **T1** vacant-land sales in the same tract (≥2) → median sale $/lot-sf
- **T2** assessed-land regression over ≥5 same-tract parcels (+subject)
  → slope, scaled to market by the subject's AVM/assessed ratio (default
  1.4 when unmeasurable)
- **T3** per-parcel assessed delta × market ratio × **0.35**
- **T4** flag-only — no land data

Cap: ±20% of the comp's sale price; ignored under $1,000.

### Trick 3 — Adjustment cap

Net adjustment > **25%** of sale price → the comp still counts, at
**half weight** and flagged. Base weight is `1/(1+adj_pct)` —
least-adjusted evidence leads inside a tier.

### Trick 4 — Verification gates who may drive

A sale stamped **stale** or **divergent** (its price can't be squared
with its own AVM) stays in the pool as context but can never set the
value. This came directly out of Eagle Run run 1 — the one case A won.

### Trick 5 — Condition tier discipline (Clef)

Clef's curb-appeal read tiers every comp at a confidence floor of **30**:

- `tier:median` / `tier:premium` / `tier:luxury` tokens are authoritative
- condition ∈ {renovated, updated, turnkey, move-in ready} → **renovated**
- condition ∈ {dated, maintained, as_is, distressed, needs_work} →
  **median**
- below the confidence floor → unknown (a weak stamp neither upgrades
  nor downgrades)

Driver set, in order:

1. ARV-tier comps that are not median-graded and clear **similarity ≥3.0**
2. else median-tier comps (flagged: "median-tier driver — no
   high-similarity renovated evidence")
3. else the **retail band**: non-as-is, non-median comps within **70%**
   of the pool's top $/sf
4. else — as-is-only evidence — **ARV is withheld**. Floor evidence
   can't price a renovation. (Median-only special case: ARV = the
   median ceiling of the similarity-gated set; if the subject AVM sits
   above it, the AVM is the answer — "corroborated uplift", conf low.)

### Trick 6 — Anchor, don't blend

Inside the picked class, the **most-similar verified comp is the
anchor** and ARV is its repriced contribution. The rest of the driver
set bounds the range — never blended in. The weighted blend survives
only as the anchor of last resort when nothing dominates similarity.

Similarity score: distance `max(0, 1−d)×3` · same block group `+3` (else
same tract `+2`) · same subdivision `+2` · era ±10yr `+1.5` (±20yr `+0.75`)
· size ±150sf `+1.5` (±300sf `+0.75`).

**Similarity gate:** drivers must score ≥ **60% of the anchor's** score
or they drop out entirely — a far, cross-pocket comp with a clean
adjustment is still weak evidence (the 109th Ave / Marie St lesson).

### Trick 7 — Self-heal

If the anchor is the *floor* of its own driver set (< 80% of the driver
median, or below the supporting range), the most-similar comp was also
the cheapest product — re-anchor to the median-contribution driver. One
heal, then the verdict stands with the trail.

### Trick 8 — Condition adjustment (the URAR Condition line)

Only fires when **every** driver is median-tier — the set prices median
condition, and the subject's as-repaired condition earns the market's
renovation premium:

- **T1** pool tier spread — ≥2 premium-tier comps, median-to-median
  spread × rehab fraction
- **T2** contributory — subject rehab cost × **80%** (the appraiser
  never credits renovation dollar-for-dollar)
- **T3** flag-only

Rehab fractions: Full Gut 95% · Heavy Rehab 85% · Full Cosmetic 75% ·
Light Cosmetic 45% · Lipstick 30%. Must be ≥$1,000 to apply.

### Trick 9 — Outlier ceiling in subject units

ARV cannot exceed the ceiling unless **≥2 drivers** support the higher
value. The ceiling is measured in *subject units*: each comp's raw sale
+ its size gap repriced at the marginal rate, bounded by the top
**verified contribution**. A bigger comp's raw sale is the price of
more product — at subject units it is worth less, not more. One comp
can never push the answer past all the other evidence.

### Trick 10 — Bracket + confidence

All-smaller or all-bigger driver sets are flagged (no size bracket =
weaker evidence). Confidence: `high` needs ≥3 drivers and a clean flag
trail; bracketed or capped → `low`.

### Trick 11 — Verify-and-retry (the loop around it)

`verify_b()` tests invariants, not outcomes — symmetric, heals low AND
high anchors:

- no ARV produced
- thin evidence (< 2 drivers)
- ARV **below the as-is AVM** — a renovation can't be worth less than
  the un-renovated property
- uncorroborated flag present
- ARV < 0.8× the driver median / > 1.25× the driver top

Max 3 attempts. On failure: **widen** (pull market-context nearby sales
the comp fetch missed, dedupe by normalized address), then **deepen**
(fill missing comp AVMs + land values, cap 12 fields per attempt). If
every attempt fails, the withheld ARV falls to the labeled AVM floor —
never silent, never a bare refusal.

## The calibrated constants

| Knob | Value | Where it came from |
|---|---|---|
| Marginal taper | 50 / 40 / 30% of $/sf by gap ≤10 / ≤25 / >25% | Geraci, Emerald Ln |
| Adjustment cap → downweight | 25% → half weight | appraiser note: ~10–15% is normal |
| Outlier supporters | 2 | Geraci, Woodcrest |
| Retail band | 70% of pool top $/sf | Tampa refusal case |
| Similarity floor / gate | 3.0 / 60% of anchor | Marie St, 109th Ave |
| Clef confidence floor | 30 | tiering sessions |
| Land factor / cap / floor | 0.35 / ±20% of sale / <$1,000 ignored | land ladder sessions |
| T1 lot rescue | ≤0.5mi, no major-road cross, same tract/BG | Ruskin cascade debut |
| T2 pocket-implied | ≥3 same-tract sales | same |
| Sqft slope fit | ≥5 comps, tract first, slope < avg $/sf | appraiser ladder |
| Self-heal | anchor < 0.8 × driver median | Indianapolis |
| Verify bounds | < 0.8× median · > 1.25× top | verify_b invariants |
| Deepen cap | 12 fields per attempt | call-volume bound |
| Rehab fractions | 95 / 85 / 75 / 45 / 30% | URAR condition line |

## Known defects it shipped with

The audit was honest about this — being the winner doesn't make it
clean (`docs/HARNESS_KEEP_DROP_AUDIT.md` §4, `docs/OFFICIAL-HARNESS.md`):

- The "renovated" tier is picked by price with no ceiling — a $1.6M
  outlier still reads as "premium".
- Most answers rest on one comp yet get called "verified" (32 of 42
  replays).
- "Stale" is a price test, not a date test — a recent cheap sale counts
  as stale.
- Confidence carries no information — "low" on 43 of 48 runs.
- The market-measured uplift is dead code; only cost×80% ever ran.
- Subdivision matching is exact-string — spelling variants miss.
- The scoreboard scored a moving target — the script changed ~12 times
  during scoring, and several rows were scored on the address their rule
  was written for.

## Why the decision was still ship

26 of 27 cases, and the losses were honest ones — the refusal case and
the stale-anchor case each produced a rule, not an excuse. Every
mechanism traces to a named address where the old math visibly invented
or destroyed value, and the port proved 0.1% live parity before the
swap. The defects were known, listed, and bounded — the alternative
(Set A) drifted above its own evidence on exactly the thin pools where
an investor needs the number most.

## Sources

- `scripts/ab-eval.py` — the harness itself (reference at `31cdd3f`)
- `packages/shared/src/appraisal/set-b.ts` — the shipped port (`5953349`)
- `.data/ab-calibration/scoreboard.md` — the 27-case record
- `docs/CALIBRATION-FINDINGS.md` — the first proven rules
- `docs/OFFICIAL-HARNESS.md` — the ship-time description
- `docs/HARNESS_KEEP_DROP_AUDIT.md` — the post-ship layer audit
- `docs/HARNESS_FINDINGS_LOG.md` — address findings + owner decisions
