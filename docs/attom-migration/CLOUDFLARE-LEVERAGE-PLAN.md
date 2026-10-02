# Cloudflare Leverage Plan

Source: Cloudflare Birthday Week 2026 announcements (Sept 29 – Oct 1). Goal:
turn newly-shipped Cloudflare primitives into product advantage for the
underwriting platform.

## Design constraint (from product owner, 2026-10-01)

Comp condition classification must be evidence a human appraiser would use:

1. **Curb appeal** — exterior/street photos of the comparable (from its Zillow
   listing; listing photos persist after sale).
2. **Listing description** — agent-written listing text persists on Zillow
   post-sale and reveals renovation status ("fully renovated" vs "fixer
   upper" vs "as-is").

These signals classify each comp's condition tier, feeding the evidence
classifier (`classifyCompsByEvidence`). Deterministic transaction evidence
(sales-history flip chain, distressed-sale flag) remains primary;
curb-appeal disambiguates the unlabeled "transitional" bucket. This is
INPUT-side enrichment — it feeds the classifier, it does not change
appraisal math. All eval-logic changes stay parked until they can be
verified against live data (owner directive, 2026-10-01).

## Phase 0 — groundwork (no ATTOM dependency, no eval-logic changes)

1. Fixture-replay harness — feed saved `.data/attom-mcp/pipeline-*`
   payloads through the attom-mcp provider offline; repeatable verification
   artifacts without live calls.
2. KV Instant — move `API_CACHE` to Instant mode (sub-2ms p99, same API).
   Speeds repeat analyses + `/engine/queue` SWR reads.
3. AI Gateway in front of vision/LLM calls — Auto Router + User Insights
   for spend visibility and cheaper routing.
4. Regression sweep — `node scripts/run-regression-tests.mjs api|dashboard`
   + `npx tsc --noEmit` over the 10-01 changes.

## Phase 1 — curb-appeal comp enrichment (Clef)

5. Comp listing fetcher — extend `photo-provider` (Zillow via
   Firecrawl/Gemini, subject-only today) to fetch each comp's Zillow
   listing: exterior photos + listing description text. Gate to
   evidence-relevant comps (census geo-gate survivors), not the full 25.
6. Clef client — Jev-API-compatible decision model on Workers AI
   (`services/` adapter mirroring the removed Jev shape). One
   schema-bound call per comp: curb photos + description →
   `{condition_level, renovation_signals, distressed_signals,
   probabilities}`. Clef for accuracy, Clef-flash (38.8ms median) for
   latency-critical paths.
7. Evidence fusion — curb-appeal classification stamps comp condition
   evidence into `classifyCompsByEvidence`. Verify live before merge.

## Phase 2 — data moat

8. Basin lake — land provider payloads (CoreLogic now, ATTOM on return),
   comp evidence labels, ARVs, vision scores into Iceberg on R2 via Basin
   Pipelines. Uses: scarce-pool backstop (queued), trade-tricks
   calibration corpus, Clef fine-tune corpus, market-intel product.
9. Clef fine-tuning — RL platform on `/v1/ml/ideal-reports` corpus →
   proprietary appraisal decision model.

## Phase 3 — when ATTOM grant/keys land

10. Re-enable attom-mcp (`sync-attom-token.mjs` → restart → Sterling E2E),
    turn on curb-appeal enrichment in the DO path, live verify.
11. Dataset enrichment queue (timeline, mortgage/foreclosure, rental
    valuation, equity, schools) + `response_too_large` retry.
12. Trade-tricks module — implement + calibrate against LIVE data only.
13. REST adapter swap per PROVIDER_SWAP.md once docs/keys arrive.

## Phase 4 — revenue surface + ops

14. K2 event backbone — ordered durable streams for analysis/webhook/
    engine events; multi-consumer (engine, Basin, audit).
15. Real-time issue detection → coding agent → PR (self-healing prod).
16. Monetization Gateway (x402) — charge agents per /v1 call; later expose
    the evaluator as a paid MCP tool.

## Not pursued

Post-quantum crypto, CA application, sovereign AI, registrar, Containers
sandboxes (revisit for untrusted per-customer compute), Cloudflare OS
(waitlist only), Artifacts (possible report-PDF versioning later).
