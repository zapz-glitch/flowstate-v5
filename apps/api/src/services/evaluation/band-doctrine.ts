/**
 * Band membership doctrine — the first-principles rules the reasoning
 * model applies when adjudicating band membership. Source of truth:
 * docs/BAND-FIRST-PRINCIPLES.md — keep this string in sync with it.
 * (Workers can't read the filesystem, so the doc is inlined here.)
 */
export const BAND_DOCTRINE = `# Band First Principles — comp band membership doctrine

## What the bands are
- as_is — distressed/dated sales. The floor: what the subject sells for today. A renovated-looking listing that SOLD distressed (nominal sale, foreclosure language, investor-marketed) is as_is evidence, not ARV.
- median — maintained/transitional retail. The market's middle.
- arv — genuinely renovated retail sales. The ceiling the subject can reach after the scoped rehab. ARV members MUST be real renovation evidence: after_renovation classification, verified flip resale, or a condition read of Updated/Renovated. A comp that merely sold high is not ARV evidence.

## Hard rules — never adjudicated away
1. Priceable only. Missing sale price or square footage → unbanded.
2. Distress overrides vision. nominal_sale, foreclosure, or investor-marketed listings cannot sit in arv even if photos look renovated.
3. Flagged/unpriceable comps never belong to a band — data_error price sanity, non-arm's-length, disabled comps.
4. Single membership. A comp sits in exactly one band.
5. A single member can form a band (point band). Thinness is carried by confidence, not by discarding evidence.

## Include/exclude judgment
- Price coherence inside a band: a member whose unit rate is wildly inconsistent with the band's core (>1 IQR) is excluded; prefer excluding the incoherent member over letting it drag edges.
- Reader over-promotion: a 'renovated' stamp on evidence that can't support it (vacant lot, mislabeled flip acquisition, price inconsistent with claimed finish level) moves out of arv — usually to as_is or median, or unbanded.
- Under-reading: a dated-stamped comp with verified renovation evidence (permit trail, flip resale, explicit remodel language) may be promoted INTO arv.
- Geo does not change band, it changes tiers: band labels apply identically at every geo level; block group / neighborhood / tract are membership filters, not different conditions. Tightest geo evidence outranks wider evidence of the same quality.
- Adjacent-band boundary cases: a comp within ~5% of an adjacent band's median rate is transitional — it may count toward its band's IQR but is suspicious as an edge-setter; prefer excluding it from arv when a cleaner member exists.
`
