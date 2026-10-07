# Band First Principles — comp band membership doctrine

Read by the reasoning model when it adjudicates band membership (include /
exclude / move) after the deterministic draft bands form. These are the
rules of evidence for what may sit in each band — the same doctrine the
gate enforces (verdict-grade d1–d8) and the Evaluation Agent reads in
docs/EVAL-AGENT-RULESET.md.

## What the bands are

- **as_is** — distressed/dated sales. The floor: what the subject sells for
  today. A renovated-looking listing that *sold distressed* (nominal sale,
  foreclosure language, investor-marketed) is as_is evidence, not ARV.
- **median** — maintained/transitional retail. The market's middle.
- **arv** — genuinely renovated retail sales. The ceiling the subject can
  reach after the scoped rehab. ARV members MUST be real renovation
  evidence: after_renovation classification, verified flip resale, or a
  condition read of Updated/Renovated. A comp that merely sold high is
  not ARV evidence.

## Hard rules — never adjudicated away

1. **Priceable only.** Missing sale price or square footage → unbanded.
2. **Distress overrides vision.** nominal_sale, foreclosure, or
   investor-marketed listings cannot sit in arv even if photos look
   renovated (owner rule: investor language disqualifies the ARV stamp).
3. **Flagged/unpriceable comps never belong to a band** — data_error price
   sanity, non-arm's-length, disabled comps.
4. **Single membership.** A comp sits in exactly one band.
5. **A single member can form a band.** n=1 produces a point band
   (low=mid=high) — thinness is carried by confidence, not by discarding
   the only evidence the pocket produced.

## Include/exclude judgment — what the reasoning model is for

The deterministic pass trims by 1.5×IQR on unit rate. The reasoning model
handles what math can't:

- **Price coherence inside a band.** A member whose unit rate is wildly
  inconsistent with the band's core (>1 IQR) is excluded — e.g. a $253k
  "renovated" comp in a band whose coherent cluster reads $380–400k.
  Prefer excluding the incoherent member over letting it drag edges.
- **Reader over-promotion.** If the condition reader stamped 'renovated'
  on evidence that can't support it (a vacant lot, a mislabeled flip
  acquisition, price inconsistent with the claimed finish level), move it
  out of arv — usually to as_is or median, or unband it.
- **Under-reading.** A dated-stamped comp with verified renovation
  evidence (permit trail, flip resale, explicit remodel language) may be
  promoted INTO arv.
- **Geo does not change band, it changes tiers.** Band labels apply
  identically at every geo level; block group / neighborhood / tract are
  membership filters, not different conditions. Tightest geo evidence
  outranks wider evidence of the same quality.
- **Adjacent-band boundary cases.** A comp within ~5% of an adjacent
  band's median rate is transitional — it may count toward its band's
  IQR but is suspicious as an edge-setter; prefer excluding it from
  arv when a cleaner member exists.

## Output contract

For each comp reviewed, return include (keep assigned band), exclude
(unbanded), or move (to a named band) with a one-line reason citing the
evidence. When uncertain, keep the deterministic assignment — adjudication
fixes clear violations, it does not relitigate close calls.
