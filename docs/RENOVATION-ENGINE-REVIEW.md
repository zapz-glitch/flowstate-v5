# Renovation Engine — New Ruleset vs Current System: Coverage Review

**Verdict first: the new doc is a real upgrade — roughly 2x the
capability of the current mechanism — but parts of it need plumbing that
doesn't exist yet.** Today the system assigns ONE renovation level from
subject photos and charges big-ticket items at FIXED default costs gated
by permit age. The new doc turns it into a scoped estimate priced at
local rates with a market-signature check. That's the right direction;
the gaps are about what the machine can actually reach today.

## What the new doc adds over the current system

- **Itemized scope** vs a single level + $/sqft — GC-style lines instead
  of `35/sqft × sqft`.
- **Local unit pricing** — today major items are flat defaults
  ($10k roof, $8k HVAC …) set once in `MAJOR_ITEMS`; the doc prices every
  line at the subject's market.
- **Market scope** — reads what the ARV comps actually renovated TO
  (finishes/materials) and budgets the subject to match. Nothing in the
  current system does this.
- **Hybrid mode** — custom where evidence exists, $/sqft fallback where
  it doesn't. Today it's all-or-nothing per level.
- **Per-area condition read** — today vision returns one level index; the
  doc wants a room-by-room matrix.
- **Flip-delta fallback rate** — deriving the pocket's real $/sqft from
  verified flips in-pool is smarter than any web lookup. Genuinely good.

## What current code already does that the doc should keep

- **Permit-age gate per item** (roof 20y, HVAC 15y, water heater 10y,
  panel 30y, replumb 40y, …) — the doc mirrors it; keep user overrides
  winning over lookups (`major_item_setting` table).
- **Seller notes can only ADD scope** — already in code, doc keeps it.
- **skipBaseRehab** — vision-verified renovated + Lipstick skips base
  $/sqft but still charges major items. New doc should say this
  explicitly.
- **5-level table keyed by ARV tier** (25/30/35/45/60 under $501k …) —
  the doc's "system default" fallback layer.

## Gaps the doc doesn't cover / questions for you

1. **NET ACCESS BLOCKER (biggest).** The Evaluation Agent's automation
   allowlist only reaches git + api.flowstate.homes + the engine worker.
   It CANNOT reach Homewyse/Angi/local contractor sites. Either widen the
   automation's net policy (homewyse.com, angi.com, fixr.com, homeadvisor.com)
   or the API has to proxy pricing lookups. Doc assumes it works — it
   won't until that's opened.
2. **No scope field in the verdict schema.** `selection` has adjustments/
   flags/notes — no `scope_lines`. Options: new verdict field (code work)
   or the renovation verdict rides inside `dealEconomics`/notes as JSON
   (no code work, ugly).
3. **Per-area vision doesn't exist.** Vision returns a single reno level,
   not a kitchen/bath/roof matrix. The condition table needs a vision
   prompt upgrade (code work) or the doc's custom mode can't populate.
4. **Comp interior photos.** Market scope needs ARV-comp finish evidence;
   today Clef curb-appeal is exterior-only. Interior comp photos aren't
   fetched — needs a fetch or the market-scope step degrades to
   descriptions.
5. **Confidence threshold for custom vs fallback.** Doc says "when the
   vision model can't read enough" — needs a number (e.g. <3 readable
   areas or vision conf < X → fallback).
6. **Who prices when both exist?** User-set major-item cost vs local
   lookup — recommend user override wins, lookup fills unset items.
7. **Foundation severity tiers** — doc wants 3 tiers; today it's one
   flat $12k. Needs the tier table priced per market too.
8. **Does the renovation engine run inside the eval session or a second
   agent?** Doc assumes same session has web access for lookups; if it
   stays inside the eval verdict, one prompt covers both — needs the net
   policy answer first.
