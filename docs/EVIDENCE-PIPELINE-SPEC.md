# Evidence Pipeline Spec — Listing-Fetch Layer (Serper + Scrapfly → Clef/Luna)

Owner spec (2026-10-06). Comp condition labels must be **evidence-based** —
curb-appeal photos + listing description — not price-position inference.
This spec adds the missing fetch layer so the existing Clef/Luna
classification chain runs on real listing evidence.

## The problem this fixes

- `classification.type` (`transitional` / `as_is` / `after_renovation`) is
  assigned by a price-percentile rule: top price/sf group in the pocket =
  `after_renovation`. No photo or description is consulted. Verified wrong
  on 4428 Crenshaw (labeled renovated; it was not).
- `comps[].curbAppeal` is empty (0/27) because `gatherCompConditionEvidence`
  starts with a listing scrape through the photo-provider — and every
  provider (Zillow, Redfin, Realtor) is built on Firecrawl, which was
  removed. `CLEF_COMP_CONDITION_ENABLED` also isn't set.
- Subject vision returns `insufficient_photo_evidence` — same dead fetcher.
  The subject has 10 photos on Zillow; the pipeline can't see them.

## Tool verification (all four confirmed in-repo)

| Tool | Role | Verified |
|------|------|----------|
| **Serper** (`google.serper.dev`) | Resolve an address → listing URL. Pattern live in `flowstate-workers/src/enrich.ts` (`serperSearch`, `X-API-KEY` header, organic results). | Code exists; needs `SERPER_API_KEY` in v5 env |
| **Scrapfly** | ASP-protected render of the listing page (Zillow/Realtor block bots). Tiered ladder: ASP datacenter → ASP residential → `render_js`. | Full client in `flowstate-workers/src/scrapfly.ts` — port it |
| **Clef** (Workers AI `env.AI`) | Reads up to 4 photos + description → condition label, score, investor-language probability. | `classifyCompCondition` + `gatherCompConditionEvidence` already exist and wired — just starved |
| **GPT-6 Luna** (OpenRouter) | Fallback classifier when Clef fails; also the subject reno-tier vision model. | `classifyCompConditionLuna` fallback already wired |

**Redfin is nearly free:** workers' Stingray JSON API
(`src/redfin.ts`, `photoUrlsFromGis`) returns photo URLs + listing data as
JSON — no Scrapfly credits burned, no HTML parsing. One Scrapfly call to
resolve the GIS endpoint per search (cacheable).

## Fetch ladder (per property — subject AND each comp, in parallel)

```
address
  → SERPER: "<address> site:zillow.com" → Zillow homedetails URL
       └─ no Zillow hit → "<address> site:redfin.com" → Redfin URL
            └─ no hit → "<address> site:realtor.com" → Realtor URL
  → SCRAPFLY (ASP ladder) renders the page
       └─ Redfin path may shortcut via Stingray JSON (no render needed)
  → extract: photos[], description, whatsSpecial[], features[], yearBuilt, sqft
       (fields already defined on ZillowListingData — interface unchanged)
```

Failure at every rung → `null`, chain records `condition_source:
'no_listing'`, and the comp's condition stays `unknown`. No price-based
label is ever applied — the price-percentile rule is removed as a
classification input entirely. Labels come only from curb-appeal photos +
listing description.

## Classification layer (already built — just needs feeding)

Per comp, once listing data lands:
1. **Clef** gets curb photo + up to 3 more images + description →
   condition classification, confidence, investor-language read.
   Overrides the price-inference `classification.type` when it returns a
   confident, evidence-backed label.
2. **Luna** runs only when Clef is unavailable or fails — same stamp
   contract.
3. Investor-language keyword pass runs free regardless.

## Subject path — parallel with comps (your directive)

Subject fetch + vision is NOT serialized after comps:

```
pipeline start
 ├── SUBJECT lane: Serper/Scrapfly fetch → photos + description
 │                  → Luna/Clef reno-tier vision (8-zone / Full Cosmetic etc.)
 │                  → feeds renovation engine pricing + tier classification
 └── COMP lane: all comps fanned out in parallel (existing clefCompPromise
                pattern — already overlaps vision + valuation)
```

The plumbing for parallelism already exists — `clefCompPromise` is kicked
off early and awaited later; the subject `photo_fetch` step already runs
independent of comps. This spec only replaces the dead fetcher inside
both lanes.

## Harness integration points

| Field | Change |
|-------|--------|
| `subject.condition` / `visionAssessment` | populated by real photos — reno-tier stops being text-only |
| `comps[].curbAppeal` | Clef/Luna evidence stamp (label, confidence, model, source) |
| `comps[].classification.type` | evidence label from Clef only — no price distinctions; `condition_source` records `evidence` / `no_listing` / `clef_unavailable` |
| bundle `steps` | `comp_curb_appeal` + `photo_fetch` report real counts instead of fallbacks |
| Basin lake rows | already capture comp condition stamps — provenance auditable per run |

## Cost/latency budget

- Serper: ~1 query/property (~$0.002) — subject + comps ≈ 30 queries/eval
- Scrapfly: ~1–30 credits/page depending on ASP tier — Redfin lane often $0
  via Stingray JSON
- Wall-clock: comp batch overlaps vision/valuation (existing pattern);
  subject lane starts at kickoff. Target: no net pipeline-time increase —
  the dead-fetch fallbacks already burn their timeouts.

## Prototype scope (minimal diff)

The only new code is a **fetcher** implementing the existing
`ZillowFetcher` interface — `serper-scrapfly-fetcher.ts` in
`photo-provider/providers/`. Everything downstream (Clef classification,
curb-appeal stamps, bundle serialization, lake rows, the agent's evidence
view) is already written and tested. Port `scrapfly.ts` from workers,
wire the fetcher into the provider registry ahead of the dead Firecrawl
one, set `CLEF_COMP_CONDITION_ENABLED=true` + keys, and the chain lights
up end-to-end.

## Open decisions for owner

1. Serper key for v5 (exists in workers `.dev.vars`? or new key)
2. Scrapfly key same — port `SCRAPFLY_URL`/`SCRAPFLY_API_KEY`
3. Per-comp scrape cap (`CLEF_COMP_MAX` — all comps vs top-N by distance)
4. ~~Price-inference as fallback~~ — RESOLVED: removed entirely. Labels
   are evidence-only (curb appeal + description); unverifiable comps are
   `unknown`, never price-guessed
