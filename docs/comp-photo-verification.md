# Comp Photo Verification — design notes (idea stage)

> **Scope note:** this file is note-taking only. It is **not** read by the
> evaluation pipeline, the dashboard, or any automation. Nothing in the eval
> path loads `docs/` at runtime, and nothing here should be executed per-run.
> It exists to record the current process and a proposed direction.

## The evaluation process as it stands today

The Jev funnel (live in prod on `swe-2-eval` → `main`):

1. **Test 1** — raw-field gate: sqft, lot size, year built, sale price,
   sale date. Configured appraisal-rule gate.
2. **Proximity score** — test-1 passers score 90–100 on distance only.
3. **Enrich top ~10** — the nearest passers get the property-details call
   (subdivision, neighborhood, style, material, foundation, census tract).
4. **Test 2** — enriched-field gate: subdivision preferred, neighborhood
   as fallback; material/style/foundation lift score but never hard-fail.
   Two scoring bands (95–100 same-tract subdivision, 90–95 hood-only or
   crossing).
5. **Tier split** — top 10% of test-2 passers **by adjusted price** = ARV
   comps; the rest = as-is market reference. No fill. Zero passers →
   humanHandoff.

## The gap this idea addresses

Report `job_1790233689475_049295ac3f1d47cd` (3249 54th St N, St Pete —
flagged "improve" 2026-09-24) exposed it:

- 10 test-2 passers → top-10% = **exactly 1 comp** → ARV = that comp's
  price alone ($565k), no averaging, no outlier guard.
- Comp `classification` is **price-derived and circular**: a comp is
  labeled `after_renovation` *because* its sale price is in the top 15%
  — price creates the label, then the label justifies the price.
- The enriched comps had **0 photos**, no condition/grade fields. The
  system cannot distinguish "genuinely renovated sale" from "anomalous
  overpay" — it just takes the price extreme.

## The idea — verify comp condition from listing photos

Use photo evidence as the independent condition signal the ARV tier is
missing:

1. **Photo retrieval for enriched comps**
   - Firecrawl on Zillow (already in stack) for the comp's listing
     photos / cover photo — even when the comp record itself has none.
   - Playwright (possibly via Playwright MCP tooling during dev, or
     Cloudflare Browser Rendering in prod) as a second, more reliable
     extraction path — direct page screenshots when scraping fails.
   - Optional: a quick listing search to find *updated* photos that
     coincide with the recorded sale price/address (post-renovation
     listing photos are what make a comp ARV-relevant).

2. **Vision scoring per comp**
   - Curb appeal / exterior condition assessment.
   - Style comparability vs the subject (verify style match when tax
     data is missing).
   - Feeds a real `after_renovation` signal instead of the circular
     price-derived one.

3. **Where it could land in the funnel**
   - As evidence inside test 2 or as a post-tier ARV guard: an ARV-tier
     comp with no renovation evidence (or visible as-is condition) gets
     demoted or flagged — the "top cluster + outlier guard" discussion
     in `ENGINEERING_STATE.md` relates.

## Existing infrastructure to reuse (already built)

- `services/photo-provider/providers/zillow/firecrawl-fetcher.ts` —
  Firecrawl v2 scrape + JSON extraction + photo URL pull, KV-cached.
- `services/photo-provider/providers/zillow/gemini-fetcher.ts` —
  Gemini URL-context fetcher.
- `services/vision/index.ts` — `analyzePropertyCondition`,
  `compareCompToSubject`, `analyzeCompQuality` are **defined but not
  wired** into the pipeline today (vision runs on the subject only;
  `analysis-job.ts` reads `visionAssessment.status` for subject).
- `FIRECRAWL_RATE_LIMITER` Durable Object — 50-concurrency limiter.
- KV photo caching (`listing-photos:*`) + R2 `REPORT_PHOTOS`.
- Cloudflare Browser Rendering is already used by the vision layer to
  fetch photos.

## Open questions (for when this is picked up)

- Cost/latency: photos + vision on ~10 enriched comps per run — batch
  or only ARV-tier candidates?
- Does photo evidence gate ARV membership, or only annotate confidence?
- Fallback when Zillow has no photos at all — county records? Street
  imagery? Or treat as "unverifiable" and penalize score?
- Playwright MCP is a dev-agent tool — production equivalent is
  Cloudflare Browser Rendering (already in use). Keep the boundary
  clean: MCP for exploration/debugging, Browser Rendering in prod.
