# Calibration Findings — A/B Run (feat/attom-provider-swap)

Live-address A/B test: **Set A** = current pipeline ARV math · **Set B** =
trade-tricks spec (marginal-sqft scaling, within-tier least-adjustment
weighting, adjustment cap, bracketing, outlier ceiling).

Scoreboard: `.data/ab-calibration/scoreboard.md` · Harness:
`scripts/ab-eval.py` (untracked).

## Rules EARNED — implement in the pipeline (evidence-backed)

### 1. Marginal-rate sqft scaling — PROVEN (18810 Geraci Rd)

Comp contributes `adjustedPrice + (subjectSqft − compSqft) × compPpsf × 0.5`,
not `adjustedPrice/compSqft × subjectSqft` (full-proportional).

**Why:** full-proportional charged ~$407/sf for a 256sf gap on a $560k comp
→ invented $104k of value no sale supported (ARV $664k vs comp's real $560k).
Marginal scaling priced the same gap at ~$200/sf → $612k, then the ceiling
finished the job.

### 2. Outlier ceiling — PROVEN (18810 Geraci Rd, saved the evaluation)

ARV cannot exceed the comp pool's top actual sale unless ≥2 evidence comps
support the higher value.

**Why:** same run — it clamped B's scaled $612k to Griffith Rd's real
$560,000 sale price. Both sets picked the SAME comp; the mechanism was the
entire difference. User verdict: "that saved this evaluation."

### 3. No-ARV-tier refusal — PROVEN (4507 E 24th Ave)

When zero comps carry ARV-tier evidence, do NOT produce an ARV by
weighted-averaging the as-is pool — an as-is-weighted pool yields an as-is
value, not an after-repair value.

**Why:** B averaged an unclassifiable pool → $184,637 on a property whose
closest comp sold $300k+ (appraiser-adjusted ~$340k+ support). A's refusal
→ AVM anchor won. The correct output is report-only/anchor, not a fake ARV.

## Rules still shadowed — working as designed, keep observing

- **Bracketing flag** — fires correctly (all-smaller/all-bigger) but had a
  false-positive flavor on 800 40th St S (comps weren't bigger — better).
  Keep as a flag; consider flag-not-block on thin pools.
- **Within-tier least-adjustment weighting** — drove B's win on 800 40th
  (trusted the premium renovated comp). Evidence thin so far.
- **>25% adjustment cap** — untested live yet; user's appraiser note says
  ~10-15% ($35-45k) adjustments are normal — verify threshold before
  arming it.
- **Market-conditions time adjustment** — ppsfMedians 90d/365d data still
  sparse; can't calibrate until populated.

## Mechanism notes for implementation

- Outlier ceiling on thin pools (1 ARV driver): flag vs hard-cap is open —
  on Geraci the cap was right ($560k = the sale); a genuinely premium
  subject could justify flag-only. Watch more cases.
- Tier delineation dominates weighting — never let as-is/investor-priced
  evidence pull ARV (rule 6 of the spec already says this).
