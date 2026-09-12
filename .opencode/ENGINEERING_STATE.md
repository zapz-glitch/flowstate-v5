# Engineering State — flowstate-v5

## Current Objective
Build a new landing page for Flowstate on `apps/dashboard`, fresh baseline.
Direction from product engineer (2026-09-11): credibility landing page for
realtors, wholesalers, and investors. Burger menu top-right with portal
access to the dashboard after auth.

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
