# Engineering State — flowstate-v5

## Current Objective
Build a new landing page for Flowstate on `apps/dashboard`, fresh baseline.
Direction from product engineer (2026-09-11): credibility landing page for
realtors, wholesalers, and investors. Burger menu top-right with portal
access to the dashboard after auth.

## Merge & Deploy Status (2026-09-12)
- `landing-page-v2` pushed to origin; fast-forward merged into `main`
  (`16f879a..d7af415`). main now = devin-theme + landing page + Tasks.
- AUTO-DEPLOY ON MAIN PUSH FAILED (run 34671954629): repo had NO GitHub
  secrets. Typecheck passed; `wrangler deploy` exited on missing token.
  Prod UNCHANGED — still the 2026-09-11 16:56 UTC devin-theme build.
- PARTIALLY FIXED: `CLOUDFLARE_ACCOUNT_ID` repo secret set
  (52e4db30ec50dcb20a46c30a0a8da3d4). `CLOUDFLARE_API_TOKEN` still
  needed — local wrangler is OAuth-only and cannot supply one; token
  must be created in the Cloudflare dashboard, or deploy via local
  `npm run deploy` in apps/api then apps/dashboard.
- PROD D1 DRIFT FIXED: verified out-of-band `batch_jobs` matched
  0019's schema (columns, FK, both indexes), inserted `0019_batch_jobs.sql`
  into `d1_migrations`, then `db:migrate:remote` applied 0020–0024.
  Verified `analysis_runs`, `major_item_setting`, `ui_prefs` (incl.
  `nav_order_json`), and `tasks` now exist in prod. `d1_migrations`
  is caught up through 0024.
- LOCAL DEV FIXED: node_modules had drifted again (better-auth 1.4.18
  vs locked 1.7.3) breaking typecheck on `validateSchema` — resolved
  via `npm ci`. `DASHBOARD_URL` was stale at `localhost:3004` in
  `wrangler.local.toml` + `.dev.vars` (broke CORS/trustedOrigins for
  the real dashboard on :3000) — corrected to `localhost:3000`.
- Verified local: `npm run typecheck` clean both apps; dashboard :3000
  200; API :8787 /health + /health/db ok; auth probe from
  Origin: localhost:3000 returns INVALID_EMAIL_OR_PASSWORD (not
  INVALID_ORIGIN/SQLITE_AUTH) — CORS + better-auth 1.7.3 +
  `validateSchema:false` all working.
- npm audit: maplibre-gl XSS (GHSA-jrc7-96c5-q579) resolved — upgraded
  to 6.9.0 on `fix/maplibre-xss`; audit now 0 findings.
- Dev servers running: dashboard localhost:3000, API localhost:8787.
- Product engineer chose: hold deploy, upgrade maplibre-gl → done on
  `fix/maplibre-xss` (maplibre-gl 6.9.0, namespace import fix,
  audit 0 findings, typecheck clean, /dashboard/atlas compiles 200).
- NEW FEATURE `feat/hide-nav-items` @ 8abbabf (branched off
  fix/maplibre-xss): per-user hidden sidebar items via
  `ui_prefs.nav_hidden_json` (migration 0025, applied local + remote).
  Settings → Menu Bar eye-toggle; Sidebar filters hidden hrefs.
  Verified: /ui-prefs PUT→GET round trip persists navHidden;
  typecheck clean both apps.
- MERGED TO MAIN (2026-09-12): `fix/maplibre-xss` +
  `feat/hide-nav-items` fast-forwarded into main @ `56748ce`, pushed
  to origin. Deploy prep verification on main: typecheck clean both
  apps, API regression tests pass, `wrangler deploy --dry-run` bundles
  OK (prod vars: ENVIRONMENT=production, DASHBOARD_URL=
  app.flowstate.homes), OpenNext production build completes
  (22 static pages, worker.js generated). Known pre-existing failure:
  headline-money.test.mjs can't resolve `@/` alias under node --test
  (unrelated to this work; predates merge).
- DEPLOYED TO PROD (2026-09-12): `CLOUDFLARE_API_TOKEN` repo secret
  added by product engineer; CI deploy workflow run 34674609400
  GREEN — first successful CI deploy on this repo. API deployed
  (wrangler-action) + dashboard deployed (OpenNext). One fix needed:
  workflow NODE_VERSION 20→22 (locked wrangler requires >=22) —
  commit on main, pushed. Live verified: api.flowstate.homes/health
  ok, app.flowstate.homes 200, flowstate.homes 200.
- Deploy path going forward: push to main → GitHub Actions deploys
  both apps automatically. Local `npm run deploy` remains break-glass
  fallback.
- APEX DOMAIN CONSOLIDATION (2026-09-12): dashboard now canonically
  on https://flowstate.homes; `app.flowstate.homes` worker domain
  detached (deploy re-synced custom domains to declared route in
  wrangler.jsonc — apex now codified as `custom_domain`). API stays
  at api.flowstate.homes. Updated: DASHBOARD_URL prod var, auth.ts
  fallback, user-reports links, GHL base URL. Cookies unchanged
  (.flowstate.homes covers apex+subdomains). Verified: apex 200,
  app.* NXDOMAIN, sign-in via Origin flowstate.homes works.
- PROD LOGIN SET (2026-09-12): the enterprise account is now
  `hello@flowstate.homes` / password reset as requested (renamed
  from admin@flowstate.homes — same user id, all data preserved,
  plan=enterprise, emailVerified=1). Gotcha recorded: better-auth
  credential `account.accountId` must equal the userId, NOT the
  email. Sign-in verified live returning session token.
- SIGN-IN HARDENING (2026-09-12, deployed): modal now shows only
  logo header + "Liquidity." (email) + "Profitable Investments."
  (password) — no heading, no forgot-password, no sign-up links.
  SignUpModal/ForgotPasswordModal components deleted; SiteShell
  sign-up state removed. `disableSignUp: true` set API-side.
- IP lockout (deployed, v2): better-auth request-based rateLimit was
  replaced — it counted successful logins too and locked out the
  product engineer's IP during testing (shared egress IP). Now a
  Hono middleware on POST /auth/sign-in/email counts FAILURES only:
  401/403 increments `login_failures` (migration 0027, D1, applied
  local+prod), 2xx deletes the row, >=3 in a 15-min window → 429 +
  X-Retry-After. Verified local + prod (fail then success works).
  `rateLimit` table (0026) remains but unused — better-auth reverted
  to default memory limiting. ipAddressHeaders kept in advanced.
- Local test account: isaiah@flowstate.homes password reset to
  `testpass123` (local D1 only) for lockout verification.
- Post-login route (deployed): sign-in success + signed-in portal
  button route to /dashboard/analyze (property search), not the
  overview page.
- UI WORKTREE SESSION (paused): `/home/lucke/src/flowstate-v5-ui`
  branch `ui/polish` off main @6259a08. For UI changes/testing.
  Runs PROD-LIKE: `wrangler dev --remote --config wrangler.worktree.toml`
  (committed on branch) → API :8788 against REAL prod D1/KV/DOs +
  real secrets from copied .dev.vars; dashboard :3001 (.env.local
  copied, NEXT_PUBLIC_API_URL=:8788). Sign-in hello@flowstate.homes
  / flowstate123 verified. WARNING: writes hit prod D1. Main
  checkout still runs local-emulated stack on :3000/:8787.
  To resume: cd worktree, npx wrangler dev --config
  wrangler.worktree.toml (api — local code, remote D1/KV via
  `remote = true`; DO NOT use `wrangler dev --remote`, it breaks
  auth cookies on localhost), npx next dev --turbopack -p 3001
  (dashboard).
- WORKTREE PROGRESS (ui/polish, unpushed): commits 1316295,
  6fc6ea1, 1aeb004 — IndexedDB offline cache for all GETs via
  fetchApi (21-day max, cleared on sign-in, bypassed when
  impersonating); atlas popup innerHTML→textContent XSS fix;
  security headers + prod-only CSP in next.config.js; API KV TTLs
  property/comps/vision → 21 days; landing wheel-hijack scroll
  removed. Bundle audit: heavy deps already code-split (maplibre
  274KB gz → /atlas only; react-pdf 512KB gz → report downloads).
  MERGED to main + deployed (run 34710697761 green). CSP verified
  live on flowstate.homes.
- Remaining: none blocking. Optional: delete merged branches
  (fix/maplibre-xss, feat/hide-nav-items, fix/ci-node-22 are all in
  main). Pre-existing test-infra gap: headline-money.test.mjs
  `@/` alias fails under node --test.
- PHOTO PERSISTENCE (2026-09-12, deployed): `feat/photo-persistence`
  merged + deployed via CI run 34712448597 (green). Listing photo
  bytes now persist to R2 per report instance: new prod bucket
  `flowstate-report-assets` bound as REPORT_ASSETS in wrangler.toml;
  evaluation/index.ts calls persistReportAssets AFTER vision (vision
  needs live CDN URLs) and rewrites photoBundle photos to
  /user/reports/{jobId}/assets/{uuid} — served by the existing
  owner/share-gated route + dashboard proxy (already built). R2 has
  no expiry => photos outlive CDN link rot (6-month ask exceeded).
  Zillow scrape caches 24h -> 30d (zillow-fc + ZILLOW_DATA).
  persistReportAssets env gate now includes production; still no-ops
  when REPORT_ASSETS unbound. Persist batch capped 15s, non-fatal.
- Verified live on prod: analysis job_1789239868640_pwvaod60 (5802
  Misty Gln) saved report contains 6 /user/reports/.../assets/... URLs,
  0 zillowstatic URLs; asset GET returns 200 image/webp 138KB real
  image. 15/15 api regression tests pass (report-assets + deployment
  config assertions updated for prod-enable + apex domain).
- COMP FALLBACK CHAIN (2026-09-12, deployed, run 34715664434 green):
  comps now run zillow -> redfin -> realtor (was zillow-only). Per-attempt
  15s cap, 40s per-comp chain budget, comps parallel. Listing URL
  resolution reworked — Google site-search only ever got a consent wall;
  now Firecrawl /v1/search primary -> DuckDuckGo HTML (uddg decode) ->
  Google scrape. Resolved URLs validated against requested street number
  (rejects wrong-house listings — realtor returned 5747 for a 5802 query
  and was correctly rejected). safeAssetUrl widened to *.rdcpix.com so
  realtor CDN photos persist to R2. Listing scrape cache 24h -> 30d.
  VERIFIED LIVE: 5802 Misty Gln run -> "20 subject photos via redfin",
  6 comps with photos, 28 objects in flowstate-report-assets, all report
  photo URLs are /user/reports/.../assets/... — zero CDN URLs.
- Known limitation: truly unlisted properties (no listing on zillow/
  redfin/realtor) still get no photos (e.g. 1416 E Idlewild) — Street
  View fills the card. Pre-existing saved_reports dedup bug noted:
  multiple rows can exist for same user+address (upsert limit(1) picks
  one arbitrarily) — worth fixing separately.
- Local-dev quirk: worktree API (local code + remote D1/KV) hangs on
  outbound CoreLogic fetch inside the local DO — request logged, never
  returns; prod pipeline unaffected (same address errored cleanly in
  1.7s). Use prod API for e2e analysis verification.
- Verification helper: prod /v1/analyze needs an api_keys row (no
  session-cookie path on /v1); generated a temp fs_ key, verified,
  deleted it after.

## Google Cloud / Maps (2026-09-13 — RESOLVED, key rotated)
- Prod Maps key rotated to AIzaSyCQVFWXbhBwmp6mskH8ngBOLNbRds2LVDc on
  billed project 600584575168 (billing acct 0130DC-E80A6F-587A29).
  Updated wrangler.jsonc vars + .env.production + .env.development;
  deployed via run 34728767879; verified new key inlined in live chunk.
- Old key AIzaSyD1mztBbiP93zRqPiUiV0Upk7uM435EQDU was on project
  631070523239 (no billing + missing flowstate.homes referrer — that
  combo caused "for development purposes only"). Safe to delete in
  console; nothing references it anymore.
- RESOLVED: referrer restrictions added by user (verified — evil
  referer 403, flowstate.homes 200; no-referer still allowed per
  Google semantics). Remaining hardening: API restrictions on the key.

## Report dedup + fixes (2026-09-13, deployed, run 34730181169 green)
- Shared services/report-upsert.ts: matches by provider clip OR
  normalized address+city+state, updates newest match, deletes extra
  duplicate rows on every write (self-healing). GHL webhook switched
  from raw insert to the same upsert. DO call sites now pass
  propertyClip = NormalizedProperty.id.
- PROD PURGED: 774 duplicate saved_reports rows deleted (627 address
  groups + 15 clip groups, 4 users). Backup of deleted rows at
  /tmp/saved_reports_backup.json (ephemeral). 0 dup groups remain;
  report_history orphans cleaned via cascade.
- Verified live: two consecutive analyses on 5802 Misty Gln -> single
  row, latest job_id, clip 5533034499 populated.
- "Open previous report" prompt already existed (analyze page calls
  /user/reports/by-property and shows existing-report dialog) — no work
  needed.
- DO HANG FIXED: local DO outbound fetch hung on wrangler 4.129.1;
  upgraded to 4.131.1 + workers-types ^5 -> cache-miss analysis
  completes in ~9s locally. package.json pins updated.
- flowstate-extension.tar.gz reviewed: legit MV3 companion extension
  (right-click analyze), no secrets — intentionally public.
- CI: checkout/setup-node bumped to v5 (Node 24). wrangler-action has
  no v4 — residual deprecation annotation is upstream's.

## Cotality endpoints + Atlas removal (2026-09-13, deployed 34734669544)
- Atlas globe REMOVED: atlas page, GlobeInner, /user/reports/map-points
  route, getReportMapPoints, popup CSS, maplibre-gl dep (~274KB gz),
  ArcGIS hosts from CSP.
- site-location ENTITLED + VERIFIED: GET
  property.corelogicapi.com/v2/properties/{clip}/site-location works with
  existing token (also api1.cotality.com with own oauth endpoint).
  Returns subdivisionName (legal plat desc e.g. "HIGH COUNTRY BL 17786
  UN 13"), neighborhood code/name, municipality, CBSA code, census
  tract, tax district, lot dims, land-use/zoning codes, utilities.
  Integration candidates: comp matching within subdivision, market
  context, report fields, CBSA key for analytics.
- MARKET ANALYTICS NOT ENTITLED: tools pr-get_listing_trends,
  pr-get_market_trends, pr-get_rental_trends, pr-get_home_price_index,
  pr-get_home_price_index_forecast exist (MCP at mcp.cotality.com) but
  our token -> "no apiproduct match found". OAuth on api.cotality.com
  accepts our creds; api1.cotality.com also issues tokens. User must
  ask Cotality account team to add the Market Trend Analytics product
  scope, then integration = REST or MCP calls with same creds.
- Next planned work: satellite-US landing view on analyze page when no
  property loaded (maplibre removed with atlas — rebuild on Google
  Maps or re-add lighter approach), last-property focus already works.

## Completed (landing-v2)
- Rewrote `/` (`src/app/page.tsx`) as a company credibility landing page:
  Hero ("We buy houses as-is. Cash. Closed in 21 days." + stats strip),
  WhatWeBuy (01-04 criteria grid), Process (submit/evaluate/offer/close),
  WhoWeWorkWith (realtors/wholesalers/investors), CtaSection (contact,
  mailto hello@flowstate.homes), SiteFooter (not-a-licensed-broker
  disclaimer).
- New `SiteHeader`: logo + burger menu (all viewports) via shadcn Sheet
  (right slide-over): nav anchors, 4-preset Environment picker (night/dawn/
  outdoor/led, identical to dashboard Sidebar), Investor portal button.
  Portal opens AuthModals sign-in when signed out (redirects to /dashboard
  on success), or goes straight to /dashboard when signed in.
- page.tsx now reuses `components/auth/AuthModals.tsx` (inline auth forms
  deleted); `?signin=true` auto-open flow preserved (used by /docs).
- Deleted old SaaS landing: Navbar, Features, Pricing, Waitlist, Footer.
- Root metadata: "Flowstate | Real Estate Investment" + company description.

## Verification (landing-v2)
- `npx tsc --noEmit` in apps/dashboard: clean.
- localhost:3100 `/` → 200 with new hero/sections/contact markup; new title.
- `POST /api/deal`: 400 on missing fields; 501 `not_configured` without
  CONTACT_WEBHOOK_URL (client shows direct-email fallback). Needs
  CONTACT_WEBHOOK_URL (GHL/Zapier/etc.) set in the worker env to activate.
- eslint unavailable on this branch (root config needs typescript-eslint,
  not in node_modules) — typecheck used as gate per CLAUDE.md.
- Not deployed (deploy only on explicit instruction).

## Polish pass 1 (product engineer feedback, 2026-09-11)
- Speed feel: `active:scale-[0.98]` press feedback + duration-150 on all
  CTAs/menu items; smooth scroll during landing visit only.
- Submit a deal is now a real form: `DealForm` (name/email/address/notes +
  honeypot) → `POST /api/deal` route handler → CONTACT_WEBHOOK_URL forward
  (5s timeout). Inline spinner/success states, no page nav, no mailto.
- Burger menu simplified: Navigate label removed, links in Source Serif 4
  italic, Environment picker removed from public site (presets stay in the
  dashboard), "Investor portal" renamed to Login ("Dashboard" when signed
  in). Public site forces night theme on mount.

## Polish pass 2 (product engineer feedback, 2026-09-11)
- Footer minimalized: logo + hello@flowstate.homes + disclaimer + copyright
  only. Site link column and API docs link removed. The old /docs link was
  what redirected unauthenticated clicks into the login flow.
- Burger header: z-index bumped above all content (z-[60]); sections got
  scroll-mt-20 so anchor jumps don't hide headings under the fixed header.
- DealForm rebuilt as a step wizard (name → email → address → notes): one
  serif-italic question at a time, slide direction animation, progress
  "01 / 04" + hairline bar, Enter to advance, back button, per-step
  validation, autofocus guarded against page-load scroll-jump.
- /api/deal now emails hello@flowstate.homes via MailChannels
  (same tx endpoint as the API's auth emails), from noreply@flowstate.homes
  with reply_to = submitter; CONTACT_WEBHOOK_URL kept as optional extra sink.
- KNOWN UNKNOWN: MailChannels delivery from the dashboard worker is
  unverified locally (tx API rejects non-CF-originated calls with 401 →
  route returns honest 502 in dev). Confirm prod password-reset emails
  still send; if MailChannels is dead there too, switch to Resend or set
  CONTACT_WEBHOOK_URL (GHL/Zapier → email).

## Polish pass 3 (product engineer feedback, 2026-09-11)
- Menu rework: right-side Sheet drawer removed. Burger now toggles a
  full-screen overlay (same bg color, fade-in 150ms): large sans nav links
  (serif italic dropped per feedback), Login/Dashboard pill at bottom,
  Escape/scroll-lock, header X stays above overlay (z-70 vs overlay z-65).
- Theme: simple Sun/Moon toggle in header (night ↔ led "bright indoor"),
  replacing night-only lock. Mount effect normalizes dashboard-only
  presets (dawn→night, outdoor→led) so the public site stays binary.

## Polish pass 4 (product engineer feedback, 2026-09-11)
- Response-time copy unified to 24 hours everywhere (Process heading/steps,
  CtaSection, form success/footnote).
- Wizard inputs restyled into the site input language (bg-secondary/50
  border rounded-md, focus ring) + -webkit-autofill override in globals.css
  (kills browser yellow/blue wash, "old Microsoft feel").
- /api/deal never 5xxs a valid submission: every lead is console.log'd
  (worker observability on), email via MailChannels, optional webhook, and
  API /waitlist backstop if both fail. Always returns ok:true → form always
  confirms success.
- Legal: /privacy and /terms pages (site-styled, mono-label sections);
  SiteShell extracted so legal pages share header/footer/auth/theme wiring;
  form now carries Terms/Privacy consent microcopy (email follow-up consent,
  do-not-sell + STOP/unsubscribe live in the Privacy Policy); footer links
  added. NOTE: legal text is a working draft, review by counsel advised.

## Polish pass 5 (product engineer feedback, 2026-09-11)
- Form field surface: new `--input-fill` token per preset (night black
  0 0% 0%, dawn near-black, outdoor/led/root white) replacing
  bg-secondary/50 on wizard inputs; autofill inset shadow follows it.

## Polish pass 6 (product engineer feedback, 2026-09-11)
- Menu overlay right-aligned under burger (prior commit), now PERSISTENT:
  links no longer close it; overlay is translucent (bg/85 + backdrop-blur)
  so the page visibly scrolls behind while navigating; scroll-spy
  (IntersectionObserver) highlights current section; body scroll lock
  removed; X/Escape close.
- Grids made flush: rounded corners + divide utilities removed from
  WhatWeBuy/Process/WhoWeWorkWith/Hero-stats; explicit per-cell hairline
  borders connect cleanly to container edges at every breakpoint.
- Scroll snap on landing only: snap-y proximity on <html> while on /
  (short sections never trap), snap-start on all five sections.

## Polish pass 7 (product engineer feedback, 2026-09-11)
- Burger menu + overlay REMOVED. Header is now a standard top nav: logo
  left, 4 anchor links centered on md+, theme toggle + Login/Dashboard
  pill right. Mobile gets a compact mono-label links row under the bar.
  Scroll-spy highlighting kept. scroll-mt bumped to 28/24 for the taller
  mobile header.

## Branch / Baseline (updated 2026-09-11)
- `landing-page-v2` — reset to `origin/feat/devin-theme` HEAD (7afe144).
  No commits yet.
- Prod verification (read-only, GitHub + Cloudflare): flowstate.homes is
  served by Cloudflare Worker `flowstate-dashboard` (OpenNext Next.js).
  Latest deploy 2026-09-11 16:56 UTC, version 4ed6b5c0. Deployed bundle CSS
  contains 5 grayscale `--primary` values = devin-theme multi-preset mono
  system; main's purple `263 70%` absent. Prod = feat/devin-theme build.
- `main` is stale (105 commits behind devin-theme, purple SaaS landing).
  Product engineer initially chose main, then agreed to rebase onto
  devin-theme so new work matches production.
- Prior v1 landing work preserved on local branch `landing-page`
  (5844240, ad6422c, 9df2c4f ahead of devin-theme). Unpushed.

## Dev Environment (updated 2026-09-11)
- Dev server: `apps/dashboard` on **localhost:3100** (PORT=3100 npm run dev).
  Old :3000/:3001 servers killed.
- Gotcha: killing `next dev` mid-write can corrupt `.next` Turbopack cache
  → panic "Unable to open static sorted file". Fix: `rm -rf .next`.

---
# Archive — prior session state (evaluation engine work on devin-theme)

## Prior Objective
End-to-end hands-off fix-&-flip evaluation: accurate, fast, scalable, with evidence.

## Completed (this session arc)
- Vision/photo latency: merged subject renovation+curb-appeal into ONE LLM call;
  all vision resolves in one parallel batch; comp photos capped 6 (selected+nearest
  first); per-fetch timeouts (subject 20s/comp 12s). Engman 11.1s -> 7.8s.
- Renovated subjects: skipBaseRehab — vision curb-appeal "renovated" => $0 base
  $/sqft rehab; major items still charge; rehabLevel shows "Renovated".
- 7-day restore + cross-device resume of last analysis (localStorage pointer +
  GET /user/reports?limit=1 fallback).
- No-shortcuts enrichment: ALL returned comps get property-detail calls
  (subdivision + foundation + style + features) — reverted the lazy gate.
- foundation_match filter added (API evaluator + shared package), runs on all
  enriched comps; subdivision_match + foundation_match always-enabled
  (not_verified never disqualifies — safe when data missing).
- OSM location risks moved INTO enrichment batch (was post-eval fire-and-forget);
  commercial/major-road/railroad now deducts locationPenaltyPercent (default 3%
  of ARV) from buy price; surfaced in riskFlags + valuation breakdown.

## Verified
- Engman: 6.9s, ARV $344k, eval pass. After no-shortcuts enrich: all 6 comps
  carry foundation+subdivision; foundation_match passed on all; subdivision_match
  fired -> nearest_comps fallback documented (comps genuinely outside subdivision).
- Bergstrom Bay: curbAppeal renovated@100% -> rehabLevel "Renovated", rehab $0.
- Both typechecks clean.

## Pipeline Order (as specified by product)
comps search -> enrich ALL (subdivision/foundation/style) -> appraisal rules
(subdivision+foundation are hammers; not_verified-safe) -> photo+vision ONLY on
selected/rule-passing comps (+subject) -> permits subject-only -> major items ->
valuation (renovated-skip, location penalty) -> report.

## Framework Update (committed)
- Rehab framework renamed to canonical: Lipstick / Light Cosmetic / Full
  Cosmetic / Heavy Rehab / FULL GUT (was "Down to Stud") — criteria updated
  to product definitions verbatim (subject classify -> store -> price rehab).
- ARV-worthy rule tightened: comp anchors ARV ONLY if vision-verified
  renovated/retail-ready (condition==='renovated' OR rehabLevelIndex===0).
  Price inference REMOVED as eligibility — "a high sale price alone does not
  make a property an ARV comp; similarity + condition checks come first."
  Unverifiable condition => cannot influence ARV. Dated/distressed verified
  => excluded. ARV recomputed on remaining >=3; thin-set fallback documented.
- Permit status fidelity: available/empty(unavailable w/ error preserved).
- Redfin discovery via Google site:search through Firecrawl (autocomplete 403).
- StreetView no-imagery -> static insignia via metadata endpoint.

## Production-prep QA (committed)
- Deleted 6 stale python-*.test.ts regression files (dead python engine modules).
- FIXED real bug: selectCredential returned a cooling-down key when ALL
  CoreLogic creds were rate-limited -> now fails fast with "retry window"
  error (test: second call makes no request).
- FIXED: insufficientComps restored to <REQUIRED_ARV_COMPS — thin sets
  (1-2 comps) now trigger geographic -> older-sales -> nearest fallbacks.
- locationPenalty parity added to shared package (dashboard recalc carries
  the server-computed amount through — was silently dropped).
- Reports list deduped by propertyAddress (legacy dupes collapse to newest).
- ?address= param on /dashboard/analyze (extension entry; suppresses restore).
- apps/extension: MV3 right-click -> analyze extension committed.
- npm run test: 15 regression files PASS; vitest src/: all pass;
  typechecks clean both apps; next build clean (all routes).

## Eval-result cache + grade semantics (committed)
- 21-day eval cache: KV key eval-result:{userId}:{normalizedAddr}:{paramsHash}
  -> jobId, written on DO save; route returns stored report with cached:true
  on hit. params hash = sha256(stableStringify(evalParams)) — ANY settings/
  buybox/threshold change = fresh run. skipCache/isRefresh bypass.
- Verified live: repeat call returns report in 24ms; arvThresholdPercent
  change -> fresh job queued.
- Permits gate now informational — always pass (caller params cover rehab
  scope); available/empty/unavailable recorded as detail, never warn/fail.
- upsert verified live: "Report overwritten" path fires on re-analysis.

## Deployment
- Migrations 0021 (analysis_runs) + 0022 (ui_prefs) applied to remote D1.
- API + dashboard deployed to production by product engineer 2026-09-11.

## Pending / Next
- Observability: extend evidence with photo/vision metrics if desired.
- foundation_match visible in Evaluation Settings UI (preset editor lists filters).
- Deploy: migration 0021 needs db:migrate:remote at deploy time.

## Last Handoff
Pipeline hardened per spec. Next likely: more comp-quality evidence or
foundation_match toggle in preset UI if user wants it configurable.

## Apples-to-apples comps + AVM (branch: feat/cotality-flood-zone, pushed, NOT deployed)

Product spec implemented 2026-09-12:

### Comp qualification (hard rules, provider building data)
- New filter types: neighborhood_match, construction_material_match,
  pool_match, garage_match, stories_match (soft), roof_material_match
  (soft), condition_match. Defaults now 17 filters.
- Assessor buildingCondition drives condition_match via tier ordering
  (Excellent > Very Good > Good > Average > Fair > Poor > Very Poor);
  comp must be >= subject tier.
- Missing evidence = status 'not_verified' — records, never disqualifies;
  selectArvComps ranks verified pass > not_verified > then price.
- Soft priority on stories/roof: mismatch recorded, never disables.
- LLM comp selection can NO LONGER re-enable hard-failed comps
  (passedFilters === false stays disabled in both DO override paths).

### Location + expansion order (flipped vs old behavior)
- Subdivision preferred; neighborhood is the location level when no
  subdivision/HOA. Equal weight (40/40) in shared scoring.
- Expansion now: strict -> older_sales (2x age, 2x yearBuilt tolerance,
  15% older-sale discount) -> subdivision_expansion (drop subdivision,
  keep neighborhood) -> neighborhood/geographic -> nearest fallback.
  Previously geography expanded FIRST; now last before nearest.

### Condition gate
- services/evaluation uses assessor buildingCondition for the ARV gate;
  comp vision calls skipped when provider condition exists. Vision /
  Firecrawl code retained as fallback only.

### Normalization + response
- Subject: additionSquareFeet (buildingAdditionsAreaSquareFeet),
  roofCover, buildingCondition/Grade, improvementValue, neighborhoodName,
  avm {value, confidence, valueRangeLow/High, model, asOfDate}.
- Comps: parcelId, neighborhoodName, buildingCondition/Grade, stories,
  heating/cooling/fireplacesCount — all from existing per-comp
  property-detail calls (no new provider calls).

### Dashboard
- DealSummaryHero: AVM cell with +/- delta vs ARV (tooltip: excluded
  from math). actions.ts types extended (subject + comp).
- SubjectGridCard: neighborhood pill, Construction, Roof, Stories,
  Heat/AC, Assessor Cond (+grade), Addition rows.
- CompGridCard: Construction, Roof, Stories, Assessor Cond, Heat/AC rows
  (all conditional on presence).

### Verified
- vitest src/: 78 appraisal tests pass (35 evaluator + 43 rules incl.
  new older-sales-before-geography ordering test).
- npm test: 15/15 regression files pass.
- tsc --noEmit clean: api + dashboard.

### Remaining
- AVM entitlement: thvMarketingStandard model valid but Order Manager
  returns "no response" — needs Cotality account scope add. subject.avm
  is null until then; UI cell hidden.
- Comp cards: could add neighborhood pill when subdivision absent.
- Deploy requires user approval (deploy-on-request rule).

### Follow-up (same branch): Zillow fallback fills + card tweaks
- mergeZillowDataIntoProperty extended: when provider data is missing,
  Zillow listing data (already fetched for photos) fills buildingStyle,
  stories/storiesType, roofCover, construction type, heating, cooling,
  parking -> garage/carport (regex /carport/i routes), pool (presence
  only). Provider always wins; fills only write into null slots.
  Nested construction/features objects now deep-copied to avoid
  aliasing the source bundle.
- performAnalysis restructured: appraisal pass 1 -> photo fetch ->
  merge fills -> appraisal re-run when fills landed (recorded as
  zillow_supplement report step). Insufficient-comps throw moved after
  the re-run so Zillow fills can rescue thin pools.
- Garage/carport evaluator already treated them as one covered-parking
  category — matches product rule. UI merged into a single "Parking"
  row on subject + comp cards.
- CompGridCard gains neighborhood pill (match-state colored vs subject).
- DealSummaryHero AVM cell now renders whenever subject.avm key is
  provided — shows '—' when provider returned no value.

### Hard-rule spec + audit-trail rework (2026-09-13, same branch, pushed)

Diagnosis for `5351 Oxford Crest Dr` (job_1789274746482_oh1tga5q):
report ended at `physical_relaxation` where location filters were
disabled — so subdivision/neighborhood rules were absent from every
comp's rule list and out-of-area comps could be rescued. Two more
causes: user's saved preset had `sqft_diff=20` (±20 sqft, ~1% — failed
13/15 comps incl. all in-subdivision sales), and raw assessor codes
leaked (`Roof 111` = Aluminum; exteriorWalls `ALV`/`FST`/`SDS`).

Product engineer's authoritative rule spec:
- HARD (deal-breakers): sale_age ≤180d, same subdivision, ±250 sqft,
  same property type, no major-road crossing, ±10yr build.
- SOFT (confidence/ranking, never disqualify): neighborhood (when
  subject HAS a subdivision), building style, foundation, construction
  material, pool, garage/carport, assessor condition, stories, roof,
  lot size.
- LLM comp selection removed — rule-based selection authoritative;
  LLM annotates rankings/reasoning/scores only (cannot touch
  isEnabled/compGroup; "disable-all-when-LLM-pending" removed).

Implementation:
- DEFAULT_FILTERS: all physical matches + lot_size + neighborhood now
  priority 'soft'. Neighborhood is a datapoint ONLY — recorded and
  displayed on cards, never a selection gate (product engineer:
  "remove neighborhood, use it as a datapoint" 2026-09-13).
- subdivisionsMatch(): strips unit/phase/section/plat/#NN designators
  (UN/UT/U1/PH/SEC/LOT/PLAT/ADDN... incl. "TURTLE CREEK VILLAGE #01")
  then word-boundary prefix match — "SWEETWATER CREEK S UT 2E" matches
  subject "SWEETWATER CREEK"; "OAK" does NOT match "OAKWOOD".
  Mirrored in shared/filters.ts.
- evaluateWithFallback rewritten: no tier disables filters anymore.
  Every tier evaluates the full rule set; expansion tiers rescue comps
  whose hard failures ⊆ allowed set: older_sales →
  subdivision_expansion (radius ×geographicDistanceMultiplier, rescue
  {subdivision_match}) → geographic_expansion (strict radius filters,
  rescue {subdivision_match,distance}) → most-recent fallback.
  Full audit trail in every tier — fixes the missing location rules
  in reports. physical_relaxation tier removed (no hard physical
  rules remain).
- HARD-RULE ISOLATION (post-Canoe-Creek fix): the relaxed thresholds
  apply ONLY to the in-area time-travel tier. Leaving the subdivision
  reverts all six hard rules to strict values — relaxations never
  compound. year_built_diff is NEVER relaxed (±10yr absolute at every
  tier). The final nearest_comps fallback only picks sales whose hard
  failures are location-only — a comp breaching sale_age/sqft/type/
  year_built/road_barrier is never enabled; INSUFFICIENT_COMPS is the
  honest dead end.
  Root cause of the Canoe Creek breach (15827, job_1789278874955):
  relaxed ±20yr/360d thresholds persisted into geographic tiers AND
  the nearest-comps fallback had no hard-rule check — a 2025-built
  out-of-subdivision comp (17yr off the 2008 subject) was rescued.
- performAnalysis: required-match merge now always takes default
  priority (presets can't express soft).
- corelogic-codes: EXTERIOR_WALLS expanded (ALV/BRI/FST/SDS/LPS/BLO/
  STV/CLP/FRM/MAS/CND...), ROOF_COVER numeric RFCO set added earlier.

### Provider building-detail supplement (2026-09-13, same branch)

Duval county property-detail lacks buildingImprovementConditionCode —
condition/style/foundation were null everywhere. The dedicated
GET /property/{fips:upi}/building endpoint returns literal-text
values; now wired as a provider supplement:

- types.ts: NormalizedBuildingDetail + BuildingDetailResponse +
  optional provider getBuildingDetail(parcelId).
- corelogic.ts getBuildingDetail: defensive nesting search
  (building / buildings[0] / data.buildings[0] / root), alias lookup
  per field (condition, style, foundation, constructionType,
  exteriorWalls, roofCover, stories, heatType, airConditioning,
  parkingType, garage sqft, pool, yearBuilt). Requires composite
  fips:upi parcel ID; errors via evidenceError (non-fatal).
- index.ts: cached PropertyAPI.getBuildingDetail wrapper
  (provider-scoped key, flood-zone TTL); enrichComparables calls it
  when a comp's detail lacks condition/style/foundation and merges
  into construction+features (provider wins over Zillow fills);
  getPropertyBundle fetches it for the subject in the same
  Promise.all and merges onto property before analysis.
- analysis-job.ts DO: same subject supplement in the parallel batch
  (5th element of Promise.all → merged before performAnalysis).
- provider-evidence.test.ts: building-detail fixture coverage
  (both nestings, aliases, malformed parcel short-circuit).
- shared package: AppraisalFilter.priority added; shared evaluator
  honors soft (no disableReasons) — matches API semantics.
- D1: user's Default preset sqft_diff corrected 20 → 250 (report user's
  preset e251da86, user 5c3f729f).

Verified: 139 vitest + 15/15 regression + tsc clean api + dashboard.

### Confidence gating (2026-09-13, same branch)

Product spec: HIGH = 3+ excellent comps (recent, tight size/year/style,
verified condition) → ARV normal; MEDIUM = 3 comps w/ weaker dims →
ARV + human-review flag; LOW = <3 strong comps / rescued hard-failure
comps / nearest-comps or insufficient fallback / stale sales → do not
pretend precision exists.

- report.ts assessConfidence rewritten as a gate on the SELECTED ARV
  comps (not just pool size): per-comp grading excellent (all hard
  rules verified-pass + style/condition verified) / adequate (no hard
  failure) / weak (hard failure rescued by expansion). Staleness:
  >365d = low, >180d noted. Subject condition verified via
  classification or assessor buildingCondition.
- EvaluationReport.requiresHumanReview added; at LOW the report +
  response.valuation recommendation is overridden to 'manual-review'
  (formula rec preserved in the reason string); MEDIUM appends a
  review flag to the reason.
- response.valuation gains confidence/confidenceReasons/
  requiresHumanReview; dashboard ValuationData extended; DealSummaryHero
  renders a confidence badge (emerald/amber/red) with reasons tooltip.
- report.test.ts: fixture now carries selectedCompIds/arvStatus; new
  tests pin HIGH (3 verified), MEDIUM (unverified dims), LOW (gated
  recommendation) paths.

### Rule rework — sale age absolute, year-built ladder (2026-09-13, same branch)

Product spec change (user): sale_age ≤180d is ABSOLUTE — never relaxed
at any tier; always prefer most-recent sales. The sanctioned concession
is build-era: year_built_diff widens progressively (configured ±10 →
+2 → +4 ⇒ ±12, ±14) INSIDE each location scope before geography expands.

- ExpansionPolicy: removed allowOlderSales/olderSaleAgeMultiplier/
  olderYearBuiltMultiplier/olderSaleDiscountPercent; added
  allowYearBuiltExpansion + yearBuiltExpansionSteps (default [2,4]).
- Ladder: strict → in-subdivision year widening → leave subdivision
  (radius ×mult, year ladder restarts) → drop radius (year ladder
  restarts) → nearest_comps. Year-widened comps PASS legitimately at the
  tier's threshold (audit shows threshold:12) — no rescue needed; rescue
  still used for location failures (subdivision/distance).
- fallbackUsed union: older_sales → year_built_expansion;
  expansionApplied entries: 'year_built' | 'subdivision' | 'geographic'.
- nearest_comps last resort uses year tolerance at widest sanctioned
  step (±14 default); sale_age strict, only location failures carried.
- selectArvComps ordering: verified-passes → recency (newest sale) →
  adjusted price.
- old_comp_discount: thresholdDays field added (default 90; stored in
  preset amount column for that type, surfaced in Evaluation Settings as
  a days input + percent input). Shared package calculator + dashboard
  recalc path honor thresholdDays.
- Tests: 'time-travels to older in-area sales' replaced with
  year-widening test; 'uses older sales' replaced with sale-age-is-
  absolute test; Canoe Creek test updated (17yr comp dead at every tier
  incl. ±14 max). 139 vitest + 15/15 regression + tsc clean api + dash
  + shared.

NOT deployed — deploy-on-request rule stands.

### Per-filter Required/Preferred (priority) — user-configurable (2026-09-13, same branch)

User request: every filter needs Active toggle + Required/Preferred
control + a real threshold (the value:1 on match filters was
meaningless). Changes must flow preset → analysis.

- DB: migration 0028 adds `appraisal_rule_filter.priority TEXT`
  (NULL = system default for that type — preserves existing semantics).
  Applied LOCAL only; `db:migrate:remote` REQUIRED before API deploy.
- appraisal-rules.ts: FilterInput.priority accepted; serializeFilter
  resolves NULL → defaultFilterPriority(type) on all GET responses;
  POST/PATCH/mine/location inserts persist it. location-settings.ts
  FilterInput + upsert/resolver updated likewise.
- user-settings loader maps row priority → AppraisalFilter at both
  preset + location-override sites.
- performAnalysis merge changed: previously force-enabled match
  filters AND force-set default priority — now only injects filter
  types MISSING from the preset (system defaults); user-set
  enabled/priority is authoritative. appliedSettings.filters now
  serializes resolved priority.
- analyze.ts appraisalOverrides.filters + comp-selection.ts
  settings.filters accept priority (public API parity).
- Dashboard: AppraisalFilter/AppraisalDefaults/input types +
  widened FilterType unions (api.ts, client-api.ts);
  LocationAppraisalFilter.priority. evaluation-settings page:
  FilterRow redesigned — 4 cols (Rule | Threshold | Mode | Active);
  boolean match filters show "must match" instead of value:1;
  Mode column is a Required/Preferred pill toggle. Same Req/Pref
  pill added to analyze-page AppraisalFilterEditor + report
  SettingsPanel (updateFilter carries priority into recalc).
- RecalcFilter.priority; recalc passes it to shared evaluator and
  hasFilterChanges compares it; use-report-settings DEFAULT_FILTERS
  synced to API defaults (was stale: sqft_diff 20, 5 filters).
- rules.test.ts: +4 tests (soft sqft_diff doesn't disqualify, hard
  style-match does, soft style-match doesn't, disabled filter
  produces no result).

Verified: 143 vitest + 15/15 regression + tsc clean api + dashboard
+ shared.

Known divergence to revisit: shared sqft_diff evaluator is %-based
while API uses absolute sqft — recalc only re-evaluates when the user
edits settings, so impact is limited to client-side scoring.
