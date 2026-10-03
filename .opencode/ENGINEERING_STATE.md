# Engineering State — flowstate-v5

> This file is a session handoff, not a log. It holds ONLY: the current
> objective, active work, live blockers, durable facts the codebase can't
> tell you (external wiring, prod quirks, secret locations), and the last
> handoff. Everything else — what changed, why, how it was verified —
> lives in git history and PRs. If you're tempted to write a narrative,
> put it in the commit message instead.
>
> Write rules: update ONLY when the objective changes, a blocker appears
> or clears, a durable external fact is learned, or the session ends.
> Never record completion narration for work that's already in a commit.

## How to work in this repo

- **E2E only — never write unit tests.** Verify by running the real
  system end-to-end (dev servers, authed curl, real API calls) or the
  `*.test.ts` regression harness (`node scripts/run-regression-tests.mjs
  api|dashboard`) — those files run real pipeline code against stub envs,
  not mocks. Write the failing check first, then implement against it.
- **The codebase is the source of truth.** Read the actual files before
  assuming behavior; this file records only what code can't tell you.
- **Typecheck, never auto-deploy.** `npx tsc --noEmit` per app after
  changes. Deploy only when the user asks.
- **Git:** branch off `main` → commit → push → PR → merge. Never commit
  to main, never merge main into a feature branch (full rules: AGENTS.md).
- **Dev env:** everything lives in this checkout — `apps/api/.dev.vars`,
  `apps/dashboard/.env.local`, `apps/api/.wrangler` local D1. After
  `npm run dev`, run `npm run dev:check`. Local login creds:
  `.data/local-candidate/login.json` (sign in at /auth/sign-in/email).

## UI / theme conventions (durable)

- **Property Search (`analyze`) is the reference layout.** Other views
  match its chrome: 64px header band aligned to the sidebar logo divider
  (the `-m-8` pull-up is intentional — nothing renders above it).
- **All overlays/menus are opaque.** `bg-popover`/`bg-background` tokens
  exist — never leave a Radix surface transparent.
- **Stale-bundle is the recurring prod failure mode.** VersionGuard
  auto-reloads tabs on new deploys; when a shipped fix "isn't working",
  suspect the stale bundle before the code.
- **List price always renders** on offer/report surfaces (`List $X` or
  `List —`), never hidden conditionally.
- **Offer price is locked to the computed value** — no editable offer
  input anywhere (product discipline rule).
- **Request shape (PR #72 ruleset):** one navigation → one composite
  authenticated view request → parallel internal reads → one response.
  Caches declare scope/key/TTL/invalidation; mutation always invalidates.
  Measure navigation/data-loading changes with `scripts/perf-audit.mjs`.

## External wiring (not in the code)

- Engine repo: `zapz-glitch/conversation-intelligence`. Push events to
  `POST /v1/activity` (Bearer `CI_INGEST_KEY`); engine pulls results by
  jobId via `notifyEvalComplete`. `/engine/queue` does a serial Close
  getLead per opp — our proxy KV-caches it (30s SWR).
- Listener Devin session `devin-fbfcfad371534372bff22b123657c41f`
  ("Conversation Engine"), org `org-6c0122ecb67544ccb259ae9b1e9cc4dc`;
  `CLOSE_API_KEY` org secret `secret-a7058ea65e1c4644af6e39ffd5c49415`.
- Prod quirks: CF edge 403s Python-urllib UA on POST (use curl/browser
  UA); `deploy.yml` does NOT run migrations (`npm run db:migrate:remote`
  separately); wrangler token may lack D1/secrets scope — remote ops can
  need OAuth login.
- Insufficient-comps evals now SAVE a report (`valuation: null`,
  `comps.insufficientComps: true`) instead of erroring — jobs endpoint
  returns `status: 'complete'` for these (post-PR-#79 contract).

## Current state

- `main` is production (auto-deploys on push). Merged through PR #79 —
  insufficient comps degrade to a saved report. Prod verification of a
  known-insufficient address (12717 Dunn Creek Rd / 1802 Hunters Gln NE,
  Marietta GA) still pending after that deploy.
- Objective: swap data provider Cotality → ATTOM for all property API
  calls (clean per-call swaps; nothing removed unless told) + add an
  ATTOM MCP server for tool calling. Working branch:
  `feat/attom-provider-swap`.
- Inventory + gap map lives in `docs/attom-migration/PROVIDER_SWAP.md`.
  Read-only scan done: adapter boundary is `PropertyProviderAdapter`
  (`services/property-api/types.ts`), selected by `PROPERTY_PROVIDER`
  env; ATTOM adapter exists but is partial (no parcel flood/AVM/building
  detail, no typeahead, no throttle/rotation).
- `ATTOM_API_KEY` is declared in `types.ts` but NOT in
  `apps/api/.dev.vars` — needed before local verification of the REST
  adapter. (MCP path does not use it — OAuth instead.)
- ATTOM MCP server is LIVE and verified: `https://mcp.intelligence.attomdata.com`
  (streamable HTTP, OAuth/Descope via `devin mcp login attom` — token in
  `~/.local/share/devin/mcp/oauth/`). Configured in `.devin/mcp_config.json`.
  Tool surface: `get_property_data`, `resolve_property_identity`,
  `find_property_candidates`, `find_comparable_sales`,
  `resolve_area_geo`, `get_community_data`, `find_nearby_poi`,
  `search_taxonomy`. Resource-first: tools return `property://{attomId}/*`
  resource links; catalog at `mcp://catalog`.
- Verified call: `resolve_property_identity` on test address
  16049 Magnolia Hill St, Clermont, FL 34714 → attomId 291488
  (rooftop match, FIPS 12069, APN 22-24-26-1500-000-02700).
- CLI harness: `node scripts/attom-mcp.mjs "<address>" [--datasets a,b]
  [--raw]` — resolves + pulls datasets in one `get_property_data` call,
  saves artifacts to `.data/attom-mcp/`. Token quirks: access token
  ~10 min; refresh hits Descope at
  `auth.intelligence.attomdata.com/oauth2/v1/apps/token` (NOT the MCP
  host's /token, which rejects the public client); refresh token rotates
  per refresh — script persists it back to the Devin creds file.
- `get_property_data` datasets verified live: identity, overview,
  valuation (AVM + confidence), comparables, permits, fema-context,
  sales-history, tax-history — all `status: ok` on Magnolia.
- ATTOM-MCP PROVIDER INTEGRATED (2026-09-30): `providers/attom-mcp.ts`
  implements PropertyProviderAdapter over MCP JSON-RPC — full pipeline
  runs on MCP, no ATTOM_API_KEY. OAuth pair injected via ATTOM_MCP_* in
  .dev.vars (run `node scripts/sync-attom-token.mjs` before `npm run dev`
  — refresh token rotates, stale pair → resync). property provider union
  gained 'attom-mcp'; find_comparable_sales limit caps at 25 (tool max).
  E2E verified: POST /v1/analyze "3509 E Chelsea St Tampa" → ARV
  $319,878, 25 comps w/ subdivision+N4+tract enrichment, AVM $248,864/93,
  flood via listing scrape. Artifacts: .data/attom-mcp/pipeline-*.
  Census: pipeline already had fetchCensusGeography (same endpoint the
  user's PDF documents) — comp-hybrid derives sameBlockGroup/crossesMajorRoad.
- PIPELINE PARITY (2026-10-01): census-first ordering + evidence
  classification now in the real path under attom-mcp only.
  getPropertyBundle geo-gates enrichment on census BG/tract (free-first);
  comps carry flip (provider sales-history, 30-365d profit rule) +
  distressedSale + censusTract; comp-hybrid stage 6 splits ARV/as-is on
  flip evidence instead of top-15% price band (corelogic unchanged);
  asIsMarketIntel folds flip acquisitions into the investor floor.
  CompCard/CompGridCard gained DISTRESSED chip + BG/tract geo chips.
  E2E job_1790815961481 Chelsea: 7/25 enriched, 3 flips, ARV $319,878,
  investor floor $176,798 (1 distressed + 3 flip buys). Local API key
  for testing: fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d
  (local@flowstate.test, inserted directly into local D1).
- JEV REMOVED from attom-mcp path (2026-10-01): runJevEvaluation +
  classifyOutcomeWithJev + comp jevHybrid all gated off
  bundle.metadata.provider==='attom-mcp' — deterministic rules + flip/
  distressed evidence drive selection; Jev UI cards self-hide on null.
  ARV set = enabled flip-resale comps when present else rules selection.
  Group B = distressed-transaction comps (not price ceiling).
  SEMANTIC FIX: pool distressedStatus is property-level (distress on
  file) — NOT a distressed sale; only sales-history transaction flag
  counts now. Verified job_1790817380644 Hubert.
- DO-PATH GATE (2026-10-01): the analyze pipeline orchestrates inside
  AnalysisJobDO — getPropertyBundle is just the prefetch warmer. Census
  gate + gated enrichment now live in the DO (initial pool AND expansion
  refetch; enrichment overlay survives mergeComparablePools' expanded-
  pool preference). classifyCompsByEvidence replaces price-percentile
  grouping for attom-mcp (flip→after_renovation, distressed→as_is,
  else transitional). E2E job_1790818674653: ARV $308,356 (flip resales
  only), investor floor $194,991, 14/32 enriched, no Jev.
- OLD HARNESS EXCISED (2026-10-01): services/jev, comp-hybrid,
  comp-screen deleted; Zillow reconcile + assessor condition gate +
  condition_match default filter removed; classifyCompsByEvidence is the
  only comp classifier; ARV = verified flip resales only (no evidence →
  report-only, no fabricated ARV); Group B = distressed + flip buys
  (no ARV dependency); confidence grades flip count/staleness; all jev*
  response/comp/UI fields + 5 dashboard Jev components + score
  sort/filter deleted; subdivision_match passes on census tract/BG
  verification. E2E job_1790820587972: ARV $307,000, floor $194,991.
- CONDITION_MATCH DELETED + E2E (2026-10-01): filter type, evaluator,
  tiers, defaults all removed — comp condition is never verifiable under
  ATTOM; subject vision reno stays subject-only. Verified
  job_1790820852548 (3111 N 18th St): 5 reports, 3/25 census-gated, 2
  flips + 1 distressed, ARV $95,100, floor $76,501.
- Temp eval harness: `npx tsx scripts/tmp-attom-eval.mts "<address>"` —
  MCP data → CompLike/PropertyLike → real DEFAULT_FILTERS/ADJUSTMENTS +
  pickBestComps/calculateARV. Features: sale-age ladder + vintage cap,
  geo verification (SD→N4→N3 match via geography-context, then ±25%
  medianPPSF value-equivalence per scope), ARV/as-is price bands
  (splitPriceBands-equivalent), DEGRADED nearest-miss fallback so it
  always emits an estimate. Evidence classifier replaces price bands:
  flip chain (buy 30–365d prior + profit) → investor-buy + ARV-sell pair;
  distressed flag → as-is; >15% over own scope median $/sf or >own AVM →
  ARV; permits w/o flip timing → market. Survivor enrichment is ONE call
  per comp (geography-context+sales-history+permits+valuation). Note:
  permits have no date field — flip permit timing unverifiable.
  artifacts → .data/attom-mcp/.
- MCP geo surface: geography-context gives CO/CS/DB/N3/N4/PZ/SD scopes
  with geoIdv4 + per-scope market stats (saleCount, median price/PPSF
  90/180/365d); geo://{id}/community has demographics. NO census
  tract/block anywhere — sameBlockGroup needs external API. Comps carry
  N4 inline; SD/geoIds need per-comp enrichment call.
- Verified evals: 12312 N 27th Tampa ARV $261,945 (AVM $223k); 3509 E
  Chelsea Tampa ARV $319,519/AS-IS $243,200 (AVM $248,864 — 2% off our
  floor); 1028 Sunshine Lakeland geo-verify cut ARV $256k→$159k (comps
  were in +35–73% pricier pockets — correct rejection); 7230 Toledo
  Spring Hill degraded ARV $179,840/AS-IS $127,076 (AVM $293,750).
- Swap finding: ATTOM `neighborhoodN4` is a micro-neighborhood name, NOT
  the legal subdivision — mapping it into `subdivision` makes the hard
  `subdivision_match` filter disqualify nearly every comp. Leave
  subdivision unmapped (→ not_verified) unless a real legal-subdivision
  field is found in ATTOM payloads.
- FLEX LADDER + VALUE-EQUIVALENCE (2026-10-01): numeric filters stretch
  ×1.15→×5 until ARV evidence or pool exhaustion; geo stays census-hard
  at strict, then value-equivalent (±10% $/sf vs subject ref) cross-road
  comps admit under flex. road_barrier/subdivision_match/
  neighborhood_match carry a flex marker (value>1). Pool fetch floored
  at 18mo for attom-mcp (was truncating at ~6mo from sale_age). ARV =
  after_renovation evidence only; floor = distressed ≤subject AVM +
  flip acquisitions; transitional = display-only everywhere including
  the client recalc (was averaging all enabled comps → phantom $294k).
  Default UI selection = ARV comps only; card list has All/ARV/Median/
  Investor tier chips; map colors by class; DISTRESSED chip removed;
  paramFlex.concessions renders plain-English ("sale age to 720 days").
  Subject classification restored via vision level (0-1→after_renovation,
  2→transitional, 3+→as_is).
- VISION FIX (2026-10-01): dead CDN photo URLs killed the whole batch
  (provider-side fetch); photos now fetched server-side via
  fetchImageAsBase64 → dead links drop, live go as base64. Also
  detail:'high'×12 images + Gemini reasoning ate the 1024-token output
  cap → detail:'auto', maxTokens 8192/2048. Verified job_1790829852024:
  vision ok, subject=transitional, ARV $255k/floor $251.7k on Sterling.
- ATTOM MCP AUTH HARDENING (2026-10-01): rotated creds persist to KV
  (`API_CACHE` key `attom-mcp:creds`) so all isolates share the latest
  pair — rotation races resolved by KV reload on refresh failure.
  401/403 → forced refresh + single retry; "missing allow grant"
  surfaces a re-login instruction (consent revocation can't self-heal).
  Prod-scale path still unresolved: ask ATTOM for client_credentials
  grant on MCP, or fall back to REST API key.
- Still blocked on user-supplied ATTOM REST API docs for the provider
  swap itself. User will supply corrected endpoints for any call that
  errors during the swap.

- TOMORROW'S WORK PACKAGE — "trade tricks" (user-named appraiser rules
  module): implement as packages/shared/src/appraisal/trade-tricks.ts so
  server + client recalc share one implementation. Spec agreed with user:
  (1) marginal-rate sqft scaling — compARV = adjustedPrice + (subjSqft −
  compSqft) × compPpsf × 0.5 (symmetric, tunable via settings
  marginalSqftFactor); (2) market-conditions time adjustment from comp
  ppsfMedians 90d-vs-365d drift, downward-only (conservative in soft
  market); (3) total-adjustment cap — >25% net adj → downweight/flag;
  (4) bracketing check — all-smaller/all-bigger ARV set → confidence
  downgrade; (5) outlier ceiling — ARV may exceed pool's top actual sale
  only if ≥2 evidence comps support it; (6) least-adjustment weighting —
  weight ∝ 1/(1+adjPct), WITHIN-TIER ONLY: user clarification —
  tier delineation dominates weighting. A $150k investor-priced comp
  needing zero adjustment is floor evidence and must never pull weight
  in ARV; a $300k ARV comp needing slight adjustment still outranks it
  for ARV because it evidences the exit price. Least-adjustment applies
  between comps inside the ARV-evidence set (and separately inside the
  as-is set), never across tiers. Calibration goal per user: conservative
  risk-adjusted ARV, "99% calibrated" = engine knows when evidence is
  thin. Extend provider ppsfMedians to carry 90d/365d trend per scope.
- DATASET ENRICHMENT QUEUE (user approved, not started): timeline/
  ownership-periods → stronger flip evidence; mortgage-history/
  foreclosure-history → separate estate-sales from investor buys (fixes
  floor≈ARV collision); property/{id}/comparables → scarce-pool backstop;
  rental-valuation → hold-vs-flip output; equity/ownership → negotiation
  signal; schools/market-context → report richness. Provider note:
  get_property_data caps at 524KB → response_too_large must retry with
  fewer datasets (not handled yet).
- ATTOM MCP ACCESS REVOKED (2026-10-01 regression — was working same
  day): BOTH auth paths dead. PKCE OAuth for hello@flowstate.homes:
  fresh `devin mcp login attom` completes and mints a valid JWT, but
  the surface 403s EVERY method incl. initialize — "Missing active
  allow grant for mcp:mcp:* access" (Descope grant, admin-side, not
  user consent). M2M client_credentials now worse than before:
  mcp.intelligence.attomdata.com/token returns invalid_grant "access
  key rejected" (previously minted). Each `devin mcp login` registers
  a NEW dynamic client_id — grants may be per-client. ACTION NEEDED:
  ATTOM admin must re-enable mcp:* grant for hello@flowstate.homes /
  tenant T3K1bLuvqCHNzsYz8r4BW9Zr2MPE (and the access key). When
  enabled: `node scripts/sync-attom-token.mjs`, restart wrangler,
  rerun Sterling E2E. Local pipeline still works meanwhile —
  attom-mcp failures fall back to CoreLogic
  (searchPropertyWithFallback/getComparablesWithFallback).
- DEV ENV VERIFIED (2026-10-01): attom token synced (rotated),
  `npm run dev` clean, `dev:check` all-green — login local@flowstate.test,
  Google Maps key authorized for :3000, provider creds mint. Auth/log
  spot-checked: 401 unauthed, API key 404s clean, api_usage_logs writing.
- CLOUDFLARE LEVERAGE PLAN (2026-10-01): Birthday Week picks mapped in
  docs/attom-migration/CLOUDFLARE-LEVERAGE-PLAN.md. Owner constraint:
  comp condition = curb-appeal photos + listing description (Zillow
  persists both post-sale); Clef (Jev-API-compatible, Workers AI) is the
  target classifier. Eval-logic changes stay parked until live data.
- REPLAY HARNESS (2026-10-01): `npx tsx scripts/replay-pipeline.mts
  <pipeline-artifact.json|--all>` — rebuilds PropertyBundle from a saved
  response, re-applies recorded retrieval.paramFlex.factor via
  flexNumericFilters (the flex ladder lives in AnalysisJobDO, NOT
  performAnalysis — a replay boundary), reruns the real eval, diffs vs
  recorded → .data/replay/. Serializer gained comp ppsfMedians/avmValue/
  transaction + subject ppsfMedians — pre-change artifacts replay with
  known field loss. ATTOM_MCP_RECORD=1 in .dev.vars logs every tools/call
  ([MCP_RECORD] lines → harvest for wire-level fixtures). Regression
  sweep: removed 5 orphan tests (deleted jev/comp-hybrid/comp-screen),
  fixed insufficient-comps (last appraisal_rules step) + headline-money
  (useEvaluation mock) — api 22 + dashboard 10 green, tsc clean.
- KV INSTANT + AI GATEWAY gated on user: KV Instant = private beta
  (dashboard signup); AI Gateway needs a gateway instance configured
  before vision/LLM calls can route through it.
- E2E HARNESS (2026-10-01): tester-army/e2e@0.15.1 in apps/dashboard —
  `npm run test:e2e`. Targets: `web` (Chromium on :3000, reuseExisting
  attaches to running dev) + engine-free `api` (fetch+zod). Session via
  test.setup → `?signin=true` modal (locators: placeholders, the labels
  read "Liquidity."/"Profitable Investments."). `?address=` deep-links
  auto-run analysis; "Existing Reports Found" dialog needs a New Analysis
  click-through. WSL2 chromium syslibs unpacked to
  ~/.local/lib/playwright-deps via apt download+dpkg -x (no sudo),
  wired through LD_LIBRARY_PATH in e2e.config.ts. Model: OpenRouter
  gemini-2.5-flash, key from .dev.vars via process.loadEnvFile.
  Findings: attom-mcp dead grant fails analyze
  outright — DO calls searchProperty() not the WithFallback variant, so
  .dev.vars is on PROPERTY_PROVIDER=corelogic until the grant returns.
- GEOCODING FIXED (2026-10-02): maps key's GCP project is 600584575168 —
  Geocoding API enabled in console; live probe returns OK + formatted
  addresses. (Geolocation/Elevation still off; Places legacy deprecated.)
- ATTOM_MCP SPLIT RETRY (2026-10-02): propertyData() bisects the datasets
  list and merges results on a >524KB response (thrown RPC error, isError
  tool result, or structuredContent error marker all detected via
  TOO_LARGE_RE); a single overflowing dataset returns a status:'error'
  entry so dataset() degrades to absent. tsc clean; live-verify pending
  grant restore — wire shape is speculated, not yet observed.
- CLEF COMP-CONDITION LIVE (2026-10-02): services/clef (Workers AI
  clef-flash; noul/score answers observed on the wire — parse via
  o.noul / probabilities-argmax) + services/comp-evidence (Zillow→Redfin
  listing fetch, photos embedded at cc_ft_384 — full-res images blow the
  65k context at ~60k tokens each). Dev routes /dev/clef-status +
  /dev/comp-condition for chain verification. Pipeline wiring: when
  CLEF_COMP_CONDITION_ENABLED=true (set in .dev.vars, off in prod), the
  enabled comp set (ARV-selected first, then closest, max 8, 45s/comp
  timeout) gets classified and stamped onto comp.curbAppeal — the
  pre-existing UI slot (comp-feedback.ts ARV-condition-gate rendering).
  SHADOW MODE: evidence lands on the report, never feeds the classifier.
  Verified live: 8/8 enabled comps classified on Sterling run
  (renovated 90%/dated 30%-as-is variance). Local wrangler: AI binding
  needs remote=true AND wrangler dev without --local (--local forces ALL
  bindings local incl. AI). Local test key quota bumped to 50k (was
  exhausted at 100/mo).
- WORKERS BUILDS PREVIEWS LIVE (2026-10-02): repo-level CI over git — every
  push/PR builds an API preview (<branch>-flowstate-api.<sub>.workers.dev)
  + dashboard preview (<branch>.flowstate.homes) on the REAL runtime.
  Setup needed: [previews] blocks in both wrangler configs (vars+bindings
  re-declared, sharing prod D1/KV/R2/AI — smoke tests, not isolation),
  preview_urls=true, previews_enabled=true on the flowstate.homes domain
  record (API: PUT /accounts/{id}/workers/domains/{id}), and
  *.flowstate.homes in CORS + trustedOrigins so preview auth works.
  Orphan "flowstate-v5" project deleted. NOTE: preview builds need the
  config in the pushed branch — branches cut before these commits fail
  until rebased.
- ATTOM PRODUCTION LIVE (2026-10-02): M2M client_credentials work —
  client_id + secret in .dev.vars (ATTOM_MCP_M2M_CLIENT_ID /
  ATTOM_MCP_CLIENT_SECRET) → token at mcp.intelligence.attomdata.com/token
  (audience + scope=mcp:*), ~10min bearer, isolate-cached. PROPERTY_PROVIDER
  =attom-mcp. First live eval: 1103 La Mesa Ave Spring Valley CA → 25
  comps, ARV $1.134M, Clef classified 24/25 comps (all-comps change live),
  stamps on comp.curbAppeal incl tier+renovated/as-is/investor probs.
  Subject vision skipped — no listing photos for that address (expected:
  vision needs an active listing).
- BASIN LAKE LIVE (2026-10-02): stream flowstate_analysis_events (HTTP
  ingest adbb75b369b645cc930401161827d832.ingest.cloudflare.com, schema
  .data/basin/analysis-events-schema.json) → pipeline → basin-catalog
  sink → Iceberg table flowstate.analysis_events in R2 bucket
  flowstate-data-lake (catalog enabled, 300s rolls). recordRun emits each
  outcome — status, arv, comp curb-appeal evidence (Clef labels), steps,
  fallbacks — non-fatal. This is the calibration corpus for Clef +
  trade-tricks. KV Instant NOT granted yet ("account is not allowed to
  create Instant namespaces") — API_CACHE stays classic; binding swap is
  a 1-line id change when access lands.

## A/B calibration run (live, in progress)

Sequential real-address calibration vs the "trade tricks" spec —
Set A = live pipeline ARV; Set B = marginal-sqft scaling + within-tier
least-adjustment weighting + bracketing/outlier flags (harness:
`scripts/ab-eval.py`, untracked; scoreboard: `.data/ab-calibration/scoreboard.md`).

| # | Address | A | B | Winner |
|---|---------|---|---|--------|
| 1 | 800 40th St S, St Pete | $159,107 | $175,956 | **B** — premium renovated comp was real evidence; all-bigger bracket flag was a false positive (comps better, not bigger) |

Shipped during calibration (all on feat/attom-provider-swap):
- parcel-GIS bridge (ATTOM-only identity rescue: Census geocode → county
  ArcGIS → APN → fipsApn → attomId; Pinellas verified; registry:
  `services/geo/parcel-gis.ts`)
- CoreLogic fallback REMOVED (license ending) — `searchProperty` now
  takes fips/apn; `apnSpellings()` handles punctuation variants
- county canonical-address photo-scrape retry
- nominal-sale + symmetric rural-lot hard gates; tract rescue ≤0.75mi
- word-form deltas ("540 sf larger") in comp cards
- docs/attom-migration/ATTOM-MCP-ENDPOINTS.md — full surface reference
- Geocodio census enrichment (GEOCODIO_API_KEY, 25k credits, 1k lookups/min):
  Geocodio → Census direct → Firecrawl relay; 180d KV cache; geo-gate
  concurrency 15. Stamp-loss fix: expansion merge overlay from all gated comps.
- Redfin MLS property-details (services/redfin-details) — subject + top-15
  comps: Firecrawl search/DuckDuckGo URL resolution (street-number
  validated via ListingPhotoScraper.resolveUrl) → scrape → gpt-6-luna
  structured extraction → comp.listingDetails / subject.listingDetails.
  Shadow evidence only — comp cards + map hover card + subject card.
  Verified live: Chenwood 14/15 comps enriched, all URLs number-checked;
  sold comps retain full MLS details on Redfin pages.
- Perf: ReportStep.durationMs; Clef comp batch + Redfin batch start at
  evidence selection (overlap vision+valuation, ~15-25s saved/run).

Known gaps: subject photo scrape can't surface low-footprint listings
(site:search discovery); `crossesMajorRoad` proxy fires ~30% of pools.

## Last handoff

2026-10-03: ATTOM MCP restored (access grant active — see prior note as
stale). Calibration mode: user sends addresses one at a time; each gets
scorecard (subject/comps/gates/Clef/valuation) + A/B card. B currently
leads 1-0. Resume: next user-provided address → `scripts/ab-eval.py`
+ `scripts/address-scorecard.py` (both send skipCache).

- MAP ZERO-HEIGHT FIX (2026-10-03): black-map root cause — vis.gl <Map>
  container height:100% collapsed to 548x0 inside min-h-[160px] flex
  wrapper; zero-size viewport → map instance up (markers/legend live)
  but ZERO tile requests → transparent.png placeholders. Fixed with
  style={{position:absolute,inset:0}} on <Map> + renderingType only
  passed when Map ID exists. Verified headless-playwright: 87 real
  tiles + subject pin on live report.
- VINTAGE ERA WINDOW (2026-10-03): year_built_diff hybrid — subjects
  ≤1945 gate on era window (comp ≤1969 = same buyer class), modern
  subjects keep symmetric band. API + shared evaluators.
- GEO-NAME NORMALIZATION (2026-10-03): geo_scope_match normalizes
  "Saint/St., Mount/Mt., Fort/Ft., directions, Hts, Bch" — killed a
  23-comp false mismatch (Saint Petersburg ≠ St. Petersburg).
- 21ST AVE AUTOPSY: 0/35 enabled → after both fixes, 1/31 enabled,
  comp-driven ARV $427,137 (was assessed-anchor refusal).
- PREVIEW INFRA: workers.dev URLs need *.weareflowstate1.workers.dev
  in API CORS + trustedOrigins (committed). feat-attom-provider-swap
  .flowstate.homes preview = Workers Builds, DNS NXDOMAIN so far.
- A/B SCOREBOARD: A=1, B=4 (21st Ave → B, marginal-rate correctly
  prices small-home $/sf premium).
