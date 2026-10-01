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
- Still blocked on user-supplied ATTOM REST API docs for the provider
  swap itself. User will supply corrected endpoints for any call that
  errors during the swap.

## Last handoff

PR #79 merged and deployed. ATTOM MCP server connected + authenticated +
verified end-to-end against the Magnolia test address (attomId 291488).
`attom` tools appear in new sessions in this repo. Resume: REST adapter
swap per `docs/attom-migration/PROVIDER_SWAP.md` "Semantic gaps" once
ATTOM API docs/key arrive; MCP tools can serve as live schema reference.
