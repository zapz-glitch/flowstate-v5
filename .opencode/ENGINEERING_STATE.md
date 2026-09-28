# Engineering State — flowstate-v5

### 2026-09-28 — Analytics feed fixes (PR #54, live)

User saw only 200 events → root cause was the client row cap (200), not
missing data. Prod D1 verified complete: 897 events / 159 leads, all 7
engine kinds (outbound_msg 287, msg_activity 256, inbound_msg 204,
convo 96, stage_move 40, hot_lead 7, human_attention 7). Engine has no
more data — typed stage kinds only exist from push-go-live forward;
history lives in stage_move.value ("From->To", e.g. Contacting->
Underwriting) + meta.reason/note. stat_* values = intake bookkeeping.

Changes live on prod (cd4ea29):
- 'All' window button; row caps raised (client 1000 / server 2000).
- Feed = "Latest activity by property": per-lead last step, address
  resolved propertyAddress→meta.addr→queue item; stage targets render
  "→ Stage"; reason/note inline. msg_activity hidden (dup of inbound).
- Tile drill-downs additionally match stage_move rows by target stage,
  so e.g. 'To underwriting' shows historical transitions too.

### 2026-09-28 — SHIPPED + LIVE: PR #53 merged (69be42a)

Prod verification:
- POST /v1/activity live: bad key→401, good key→200+row; CI_INGEST_KEY
  set via wrangler secret put (wrangler login OAuth approved by user).
- Migration 0033 applied remote. NOTE: prod d1_migrations missed 0032
  (comp_tier_overrides applied out-of-band) — recorded manually, then
  0033 applied cleanly. Future remote migrations now flow normally.
- Backfill: GET /engine/activity (architect renamed — /engine/events
  collides with idempotency routes; limit≤200, cursor=numeric offset)
  → POST /v1/activity: 897/897 events, 0 errors. ~2d campaign history
  now in activity_events.
- Push LIVE: architect set FLOWSTATE_ACTIVITY_URL + CI_INGEST_KEY as
  worker secrets — no engine redeploy needed. Canary 'push_verify'
  landed in prod D1 minutes later; live inbound_msg/outbound_msg/
  msg_activity rows arriving continuously.
- msg_activity = raw per-message timestamp feed (contact-local hour)
  powering best-contact-time analytics — expected kind.
- prod-only note: CF edge blocks Python-urllib UA on POST (403) — use
  curl or set a browser UA for scripted ingests.
- Sidebar drag-to-reorder shipped in same PR: rows live-shuffle on
  hover-drag, persist via ui-prefs.navOrder (same store as Settings
  arrows — they stay in sync). Hidden items keep slots; custom links
  append last.
- Backfill artifacts cleaned: deleted verify + push_verify test rows.

Remaining/none-blocking:
- SSE push-to-UI not built — client polls rows 10s / metrics 60s.
- Reach-outs tile counts engine's newReachouts (deduped first-touches);
  drill-down shows raw outbound_msg+reachout rows (superset by design).

### 2026-09-28 — Offers rename + Analytics dashboard + CI activity ingest (feat/offers-analytics)

Architect session (…507f1b) contract confirmed:
- Worker pushes {kind,value,leadId,propertyAddress,ts,meta} → POST
  /v1/activity (Bearer CI_INGEST_KEY). Needs URL + key from us.
- Kind list: inbound/outbound_msg, reachout, response, stage_move,
  contacting, sent_to_underwriting, offer_prepped, offer_sent,
  terms_prep, under_contract, assigned, closed, offer_declined,
  no_motivation, no_margin, offer_held, offer_followup, delivery_check,
  eval_completed/failed, owner_relay_*, *_followup, intake_sent,
  hot_lead, reactivation, opt_out, human_attention, convo.
- Backfill: GET /engine/events?since&until&cursor&limit (2000/page) —
  deployed but 404ing at check time; architect fixing route wiring.
  ~2 days depth = entire campaign history.

Built (commit 1609aac):
- activity_events D1 table (migration 0033, applied locally).
- POST /v1/activity — own Bearer CI_INGEST_KEY auth mounted BEFORE the
  v1 group so authMiddleware doesn't intercept; verified locally:
  bad key→401, good→200+id, missing kind→400.
- GET /v1/activity?kind&since&until&limit (rows, ≤500) + GET
  /v1/activity/summary (per-kind counts) inside v1 dashboard auth.
- /v1/pipeline/metrics now forwards ?since (per-window KV cache keys).
- Sidebar: 'Give Offer'→'Offers'; new 'Analytics' item (BarChart3).
- give-offer landing: loads queue, router.replace into top-priority
  item (sortedQueue + saved wait filter + decidedIds); empty/failed
  states. Queue list removed. Item back-tile relabeled Offers.
- /dashboard/analytics: Today/24h/7d/30d buttons (Today default),
  10 clickable tiles + derived conv-rate tile; drill-down rows show
  ts/kind/address/meta.stage + Close link (app.close.com/lead/<leadId>)
  + Offer link via leadId→queue jobId map. Counts prefer D1 summary
  (self-consistent w/ rows), engine metrics fallback; polls rows 10s,
  metrics+queue 60s.

Verified: local E2E (ingest→summary→rows), 401s, 26/26 API regression
files, tsc clean both apps.

DEPLOY PREREQS (need Cloudflare auth — token lacked secrets scope):
- wrangler secret put CI_INGEST_KEY (value in apps/api/.dev.vars)
- npm run db:migrate:remote (migration 0033) — deploy.yml does NOT run
  migrations
- then merge PR → backfill /engine/events → send architect the URL+key
- NOTE: local DASHBOARD_INTERNAL_SECRET in api/.dev.vars was aligned to
  dashboard's value (was mismatched — local internal auth never worked)

### 2026-09-28 — realtor/seller-condition notes → Give Offer + rehab model

The conversation-intelligence engine (Cloud session) already ships
`conditionNotes: string[]` per `/engine/queue` item — verified live
(Moselle: 3 entries incl. "move-in ready, no known issues"). Our
pipeline proxy passes items through untouched, so the planned
`/internal/leads/:leadId/notes` route was NOT needed.

What was built instead (`feat/realtor-notes`):
- `services/seller-notes/` — `fetchSellerNotes` (Close `activity/note/`
  by leadId, `FLOWSTATE CONVERSATION LOG`/`[flowstate-conversation-log:v1]`
  marker filter, dated-entry split, never throws) + `classifyRehabIntel`
  (OpenRouter: notes × enabled major items → additions + advisories).
- Eval pipeline: `EvaluationParams.leadId` → notes fetch starts in
  parallel; after `deriveBuybox`, additions are PUSHED INTO
  `derivedBuybox.majorItems` so they flow through `calculateValuation`,
  `rehabLevelEstimates`, and `report.rehab.ledger` (new `seller_note`
  source tag) — true auto-add, not a display patch. Removal signals are
  advisory-only (`rehabAdvisories`) — notes never shrink the ledger.
- Response carries `sellerNotes`, `rehabAdditions`, `rehabAdvisories`;
  persisted in `full_response_json` → Refresh/Rerun re-fetches (analyze
  route recovers `leadId` from the stored report when caller omits it).
- Dashboard: `PipelineItem.conditionNotes`, `AnalyzeData.sellerNotes/
  rehabAdditions/rehabAdvisories`, `RealtorNotesCard` (notes list +
  emerald addition lines + amber consider_removing callouts), threaded
  queue.notes → reports page → `notesSlot` on AnalysisPageLayout →
  rendered under the deal hero. `queueAnalysis` passes `leadId` on
  refresh (server also recovers it).
- Live-verified: real Close fetch (Moselle 5 entries, Felch 9) + real
  OpenRouter classify — Felch produced 3 correct consider_removing
  advisories (roof 2009/no leaks, AC 2012, WH 2004); Dunn Creek's
  "needs roof" produced a roof +$10,000 addition. `tests/seller-notes.test.ts`
  7/7; full API suite 26 files pass; tsc clean both apps.
- `CLOSE_API_KEY` is already a prod secret (Update CRM + offer lead
  lookup use it) — no new secret needed.

### 2026-09-28 — census block-group signal in comp selection

New lateral market-area metric beside the tract proxy. Free Census
Geocoder API (geographies/coordinates, no key) → block GEOID → block
group = first 12 digits, tract = first 11. Runs post-enrichment on the
top-10 set: subject once + comps in parallel, KV-cached ~6mo, every
failure resolves null (unverified, no penalty — same pattern as tract).
Score effect: sameBlockGroup === true can substitute for a subdivision
noul miss toward the premium tier (still blocked by crossesMajorRoad);
mismatch is neutral — BG splits inside neighborhoods are common. Same
response also backfills crossesMajorRoad's coverage: provider-vs-provider
tract compare preferred, census-vs-census fallback when the provider
omitted one side (formats never mixed). Audit panel + entry/comp types
carry sameBlockGroup. Injectable `geo` seam keeps tests deterministic
(harness stubs it; two new tests cover both paths). 33/33 comp-hybrid
tests pass; tsc clean both apps.

### 2026-09-28 — comp Street View thumbnails: radius fix

Some comps showed blank insignia while others had imagery. Verified
live against Moselle report's comps (Saint Johns FL): Street View
Static API default 50m radius → ZERO_RESULTS for half the comps —
newer subdivision streets lack coverage near the pin. radius=500
resolves all 10 (nearest covered street a block or two over is still
representative). True no-coverage keeps the insignia fallback.
Maps Static (satellite) is NOT enabled on the project — no aerial
fallback available without enabling it in Cloud Console.

### 2026-09-28 — listPrice rerun recovery + valuation-box placement

Root cause of "rerun doesn't bring list price": `listing-scraper.ts`
served KV entries with `listPrice:null` as cache hits (only required
`photos.length>0`), so once a scrape missed the ask it stayed null for
the whole TTL — reruns could never retry. Verified live: scraping
Moselle's Redfin URL today extracts `offers.price=$559,999` via the
existing JSON-LD path (listingStatus=active). Fix: cache hit now
requires `listPrice != null`; stale entry kept as photo fallback on
re-scrape failure/empty. Refresh uses `existingJobId` so the same
saved_reports row updates → queue enrichment picks up the new price
within 30s. Dashboard: `List` removed from the give-offer header
cluster (per user — belongs in the valuation box); hero `List` stat
now always renders with `—`/"No ask recorded" fallback instead of
disappearing. Landing rows keep `List` for queue triage.

### 2026-09-27 — ROOT CAUSE of "couldn't load": React #482 suspend loop (PR #37) + SESSION HANDOFF

The user's Edge console captured it: `Uncaught Minified React error
#482` thrown inside `use()`. #482 = >100 suspensions in one render pass.
`give-offer/[jobId]` passed `params={Promise.resolve({jobId})}` — a new
promise identity every render; when any child suspends (dynamic()
imports), React replays → fresh thenable → suspends again → crash.
Race-dependent: explains "was working, now it's not" across deploys.
Fixed with useMemo on jobId. Verified only occurrence of the pattern.

### 2026-09-27 — listPrice leadId fallback (root-cause traced)

User: List shows on Property Search + Reports but not Give Offer.
Full trace: 15/24 queue items enrich via evalReportUrl jobId; of the
9 nulls, Close leads/props carry no ask either — EXCEPT Moon Lake,
whose Close lead has List Price Realism=medium. Its queue jobId
(job_1790464132326) never persisted a saved_report, but a sibling
report under the SAME leadId exists with lp=$220,000. Reports store
leadId inside full_response_json → exact-join fallback when the jobId
lookup yields nothing. Remaining 7 nulls genuinely have no ask
anywhere (verified: report JSON, lead custom fields, opp value=0).

### 2026-09-27 — One-click offers + VersionGuard (stale-bundle root cause)

User kept reporting shipped fixes as "not working" — verified the
deployed prod chunks DO contain the new code (Prep-offer tooltip, no
inputMode, List rendering). The tab runs a stale bundle — the day's
recurring failure mode.

- DealSummaryHero: removed the confirm phase entirely — Prep offer and
  No margin both dispatch in one click at the computed price.
- New VersionGuard (root layout): polls the current page's HTML every
  120s + on tab regain, compares <script src> chunk URLs against loaded
  scripts (content-hashed names rotate per deploy). Unknown chunk →
  reload once (sessionStorage-throttled, deferred while an input is
  focused). This ends the stale-tab problem — every deploy now reaches
  open tabs within ~2 min.
- listPrice path fully traced: analyzeData.valuation spreads into
  displayValuation, hero renders List when non-null — identical on all
  three views. The remaining "can't see it" was the stale bundle.

### 2026-09-27 — Offer price locked to computed value; List always visible

User: "remove the ability to change offer number — we're going to
practice discipline in giving offers." And list price still not
visible in give-offer.

- DealSummaryHero: Prep offer → confirm shows the computed offer as
  read-only text (Offer $X + Send/Cancel); the editable Offer-$ input
  is gone. Prep disabled when no positive computed price.
- QueueFallback: same — no manual price entry; dispatches at the
  queue's wholesalePrice, disabled when null/negative.
- List now ALWAYS renders on give-offer surfaces (landing rows, item
  card cluster, fallback card) — `List —` when the property has no
  asking price, so the field's presence is unmistakable. Verified the
  9 nulls have no ask anywhere (report JSON AND the Close lead — e.g.
  Moselle: off-market, ARV/MAO/wholesale only).

### 2026-09-27 — Transparent menus root cause: `popover` missing from Tailwind colors

User report: left sidebar's dropdown menus show page content THROUGH
the menu; the Longest-waiting <select> dropdown doesn't match theme.

Root cause: tailwind.config colors map never defined `popover` — so
bg-popover/text-popover-foreground generated NO CSS and every Radix
DropdownMenuContent was transparent + unthemed. (The #32 opaque sweep
checked bg-* class usage but not whether the color token existed.)

Fix:
- tailwind.config: popover { DEFAULT: hsl(var(--popover)), foreground }
  → menus now render the solid themed popover surface.
- globals.css: color-scheme light/dark per mode → native select popups
  follow the theme; select option pinned to popover tokens.

List price: confirmed live — deployed chunks render `List $X`, prod KV
queue carries it on 15/24 items; the 9 nulls genuinely have no asking
price in their reports (off-market/unlisted — report hero shows none
either). If it still looks absent → stale bundle, hard refresh.

### 2026-09-27 — Queue controls folded INTO the header card (round 2)

User's real complaint persisted: the standalone queue strip (Give Offer
| position | timer | Longest waiting | prev/next) was itself the
problem — as a separate bar it's either clipped or off the logo
baseline no matter where it sits. "Find a new place for that item."

Fix: queue controls now render INSIDE the header card (queue.inline)
— same 64px band, same card row as the address/actions. Back tile on
give-offer items now correctly points to /dashboard/give-offer (was
/dashboard/reports — real bug). Card row gained flex-wrap for mobile.
The standalone strip (queue.node) now only serves QueueFallback +
loading states, which use -mx bleed (no clip possible). List $X stays
in the cluster.

### 2026-09-27 — Give Offer queue bar clipped + baseline rule (fix/give-offer-baseline)

Root cause of "can't access it": the page's -m-8 intentionally pulls
the top band up ~16px past the viewport so its bottom border lands at
64px — exactly the sidebar logo divider (h-16). That IS the baseline
the user means by "nothing should surpass the logo". A THIN strip
rendered above the band gets its top half clipped → give-offer/[jobId]
queue bar (wait timer + prev/next) was unreachable and the band's
border landed at ~94px, breaking symmetry.

Fix:
- queue.node now renders BELOW the header band in the report page —
  band keeps the shared 64px baseline on all three views, strip is
  fully visible (64–94px).
- QueueFallback + loading branches: -mx (horizontal bleed) instead of
  -m — no vertical overshoot, strip never clipped there either.
- List $X added to the queue strip next to the wait timer (same fmtK
  display as report hero + landing rows).
- Cards gain overflow-hidden — analyze's card clips corner-accent
  diamonds to notches; unclipped cards rendered full diamonds.

Verified: tsc + eslint clean; routes 200 local.

### 2026-09-27 — Give Offer rows gain List price (feat/give-offer-list-price)

User ask: show the asking/list price on give-offer views the same way
the property report view does (hero shows `List $X` via
formatMoneyThousands).

- Engine /engine/queue has no listPrice field — items only carry
  wholesalePrice. Enrichment added inside the /v1/pipeline/queue proxy:
  on each KV refresh (30s SWR, not per request) it extracts jobIds from
  evalReportUrl, batch-queries saved_reports.full_response_json, and
  attaches item.listPrice = subject.listPrice ?? valuation.listPrice.
  Hot path unchanged (~7ms cache reads).
- PipelineItem.listPrice?: number | null; landing rows show
  `List $X` (fmtK, matches report display) beside Wholesale; fallback
  card shows `List $X` too.
- Verified: tsc both apps; local D1 join resolves lp for local jobIds
  (queue items are prod jobIds → null locally; prod D1 has them).
- PROD VERIFIED (PR #39 deployed 05:47Z): refreshed engine-proxy queue
  cache carries listPrice on 15/24 items (9102 6th Ave $79,250, Acorn
  Cir $205,000, S Washington $639,000, 651 69th Ave S $379,000…).
  Nulls = reports with no asking price (off-market) or missing rows —
  correct, matches what the report view itself shows.

### 2026-09-27 — Unify report + give-offer chrome with Property Search

User direction: Property Search is the reference layout — map its
dimensions onto the report view and give offer view, top to bottom;
page-specific buttons/functionality stay.

Branch feat/unify-report-offer-chrome:
- reports/[jobId]: outer wrapper gains playground-bg + same -m cancel;
  no-map branch now matches analyze's single-column wrapper
  (p-4 sm:p-6 lg:p-8 space-y-6). Toolbar rebuilt as the Property
  Search header band — lg:h-20 border-b band (px-4 sm:px-6 lg:px-4)
  containing a corner-accents card row (icon-tile back button,
  address, autosave, History/Share/CRM/Download/Refresh actions).
  Sticky kept on mobile under the top bar. Removed the forced sidebar
  collapse — sidebar state now consistent with Property Search.
  QueueFallback card gets the same chrome.
- give-offer/[jobId]: queue bar gutters aligned to the same px
  (px-4 sm:px-6 lg:px-4).
- give-offer landing: full chrome — playground-bg full-bleed wrapper,
  h-20 band + corner-accents header card (icon tile, title, queue
  count, wait filter, Start offers), metrics strip + queue list in
  matching bordered containers at the same content gutters.

Verified: tsc --noEmit clean; eslint clean on the three files; all
four routes (analyze, reports/[jobId], give-offer, give-offer/[jobId])
return 200 on local dev with authed cookies.

### 2026-09-27 — Prod verification: #482 fix confirmed live; Prep click not yet fired

Verification results (main @ 86f3576):
- #482 fix LIVE on prod. flowstate-dashboard deployed 05:25:36Z
  (post-merge of #37 @ 05:22Z + docs @ 05:23Z). Deep link
  /dashboard/give-offer/job_1790462773802 -> 200, and the deployed
  client chunk (1g3sfybz_piiq.js) contains the memoized params:
  `useMemo(()=>Promise.resolve({jobId:f}),[f])`. Confirmed at the
  bundle level, not just HTTP.
- Prep click: NOT fired yet on prod. Listener transcript
  (devin-fbfcfad371534372bff22b123657c41f) ends at 02:29:29Z — the
  Dunn Creek HUMAN_OFFER move. Zero `offer-dispatch:*` keys in prod
  API_CACHE (30-day TTL — none ever written). Dispatch path:
  dashboard server action dispatchOfferPrep -> POST /v1/offers/prep
  -> offers.ts posts "PREP OFFER: ..." to the Devin session + KV
  record + engine offer-draft fire-and-forget. If a click had
  succeeded, both artifacts would exist — neither does.
- wrangler tail flowstate-api running to catch the click live.

## LAST HANDOFF — resume here

Session state: main @ 86f3576, all 9 PRs (#29–#37) merged + deployed,
working tree clean, no open branches. Local dev running: api=wrangler
dev :8787, dashboard=next dev :3000 (if :3000 stalls, kill next-server
and `cd apps/dashboard && npm run dev`).

VERIFIED THIS SESSION:
- #482 fix live on prod — deployment 05:25:36Z, deep link 200,
  memoized-params confirmed inside the deployed client chunk.
- Prep click not yet fired on prod (zero offer-dispatch KV keys,
  listener transcript ends 02:29Z). Prod API tail running.

DONE this session:
- CLOSE_API_KEY rotated (new key in .dev.vars + `wrangler secret put`)
  AND the real bug fixed: resolveLeadId used Bearer auth — Close requires
  Basic (`btoa(key+':')`). It never worked; dispatches always fell back
  to address resolution. Now resolves — verified live.
- Offers are price-locked: Prep offer + No margin dispatch in one
  click at the computed price — the editable Offer-$ input was
  removed (PRs #43, #44).
  with wholesale, editable, Enter/Send dispatches at that price. Works
  on report page + QueueFallback (unblocks null/negative-wholesale items
  like Dunn Creek INSUFFICIENT_COMPS).
- Queue proxy KV-cached SWR (30s): /engine/queue is 3.5-4.9s (engine does
  serial Close getLead per opp!) → our cache serves 7ms warm.
- Fallback dispatch: negative wholesalePrice no longer enables Prep;
  opportunityId now passed through.
- Opaque chrome: all menus/bars solid bg-background (theme-matched);
  landing header + floating button included.
- "Report Not Found" flash: queue.loaded flag keeps skeleton until the
  queue poll resolves.
- Chunk-load self-heal: StaleActionGuard now also reloads on
  ChunkLoadError/dynamic-import failures (server-action.test.mjs).
- Give Offer is a LANDING page now (metrics strip + queue list + Start
  offers button), not an auto-redirect. Rows link to give-offer/[jobId].
- React #482 params-promise fix (above).

KEY CONTEXT FOR NEXT SESSION:
- Engine repo (zapz-glitch/conversation-intelligence, gh-accessible):
  /engine/queue does SERIAL close.getLead per queued opp (~L1041 in
  apps/conversation-intelligence/src/index.ts) — parallelize when
  convenient; our SWR cache hides it for now.
- Listener session devin-fbfcfad371534372bff22b123657c41f ("Conversation
  Engine") is healthy, org org-6c0122ecb67544ccb259ae9b1e9cc4dc. Its
  secrets are write-only — CLOSE_API_KEY exists as org secret
  secret-a7058ea65e1c4644af6e39ffd5c49415. Messages via Devin API
  paginate with `?after=<end_cursor>`.
- Queue items: 24 queued. Dunn Creek (12717 Dunn Creek Rd) + Moon Lake
  have NO saved report (INSUFFICIENT_COMPS / failed eval) → QueueFallback
  card + manual price entry — by design.
- 2 queue items have NEGATIVE wholesalePrice (1775 E 23rd -29,101;
  481 Golfair -8,220) — engine-side data quality, flagged.
- No headless browser locally (libnspr4/nss3 missing) — e2e via authed
  curl + real Next-Action POSTs works (session: sign in at
  /auth/sign-in/email with .data/local-candidate/login.json creds).

PENDING / NEXT:
1. USER's live Prep click on prod — landing page → pick item → review/
   edit report → Prep offer → confirm/edit price → Send. Then verify in
   the listener transcript: PREP OFFER received → child session →
   engine offer-draft pending → REVIEW email. THIS WAS THE WHOLE POINT.
   As of 05:30Z no dispatch has landed — if the user believes they
   clicked, the failure is client-side / before /v1/offers/prep.
2. ~~Confirm the #482 fix loads deep links on prod for the user.~~
   DONE — verified at the bundle level 05:30Z (see entry above).

Git rules reminder: feature branch + PR + tsc --noEmit per change;
never push directly to main; ENGINEERING_STATE.md rides with work.

## ARCHIVE — older entries compressed (full text in git history)

### 2026-09-27 — Give Offer is now a landing page, not an auto-redirect (PR #36)
> User hit "This page couldn't load" on /dashboard/give-offer/job_1790…
### 2026-09-27 — Landing chrome opaque too (PR #35)
> Completes the translucency sweep: landing SiteHeader scrolled state +
### 2026-09-27 — "Page couldn't load" = deploy-window staleness; chunk-load self-heal added (PR #34)
> User report: /dashboard/give-offer showed the browser's "This page
### 2026-09-27 — Queue latency + not-found flash fixed (PR #33)
> User report: Give Offer queue loads slowly; "page couldn't load" flashes
### 2026-09-27 — Opaque chrome sweep (PR #32)
> User report: menu bar translucent — items unreadable over page content,
### 2026-09-27 — Editable offer amount on Prep dispatch (PR #31)
> User requirement: review + edit the report before firing Prep; the
### 2026-09-27 — CLOSE_API_KEY rotated + Bearer→Basic fix (PR #30)
> - Root cause was TWO stacked bugs: every stored key was dead AND
### 2026-09-27 — Session handoff pick-up: listener transcript audit + fallback dispatch fix (PR #29)
> Verified live state (local dev, main @ 2891fc6):
### 2026-09-27 — Give Offer queue UX: report-first flow (#25-#28 merged)
> - Sidebar 'Give Offer' → /dashboard/give-offer redirects into the FIRST
### 2026-09-27 — Give Offer pipeline, engine-canonical (#24 merged)
> Conversation-intelligence engine owns the funnel (queue + metrics,
### 2026-09-26 — UI batch merged to main: theme, list price, rerun UX, offer buttons, map fixes
> Merged (all to main, deployed via auto-deploy):
### 2026-09-25 — Vision rehab level was being overridden by curb appeal: `8bfd16d` on `fix/vision-renovated-gate`
> User report: "subject condition isn't getting assigned." Verified the
### 2026-09-24 (later 2) — Stale Server Action auto-reload: `c734949`, deployed
> Recurring prod issue: every deploy rotates Server Action IDs; open tabs
### 2026-09-24 (later) — Subject condition fetch made required: `5bc5c08` on `feat/subject-condition-required`
> Product requirement: every eval (dashboard session + API-key) must run a
### 2026-09-24 — Price-class merge REVERTED; main reset to `88879cb`
> `feat/jev-price-class` was merged (`af9587d`) then force-push reverted
### 2026-09-23 (later 2) — Enrichment deferral: `c5df7ac`
> Provider detail calls moved inside the Jev funnel. The DO no longer
### 2026-09-23 (later) — Runtime pass on feat/jev-experiments: `d47736f`
> Subject-only scraping + vision, permits default-on, live Jev progress
### 2026-09-23 — Two-test Jev pipeline merged to main; tiered composite card score on feat/jev-experiments
> State of the repo: the two-test pipeline (test-1 raw-field nouls → enrich
### 2026-09-22 — Jev-only evaluation shipped on new-classification (comp_exam_v3 + comp_screen_v1)
> User directive (approved spec): Jev is the ONLY evaluation logic visible in
### 2026-09-16 — CDARV deployed to staging, full e2e verified
> Merge/deploy (staging-only per user; main NOT pushed — deploy.yml would
### 2026-09-16 — Retrieval hardening committed + staging verification
> - Committed `89bef4a` on feat/cdarv-ml-foundation: candidate-pool
### 2026-09-16 — Integration verification pass (feat/cdarv-ml-foundation, uncommitted retrieval changes preserved)
> Full runtime verification of the suspended candidate-retrieval hardening +
## Current Objective
> Branch `swe-2-eval`: the refined Jev evaluation funnel — pure-proximity
### 2026-09-22 — Three valuation tracks with independent Jev assessments
> Implemented locally on `new-classification` (uncommitted, not deployed):
### 2026-09-22 — V4 hybrid evaluation track (implemented, shadow-verified)
> User spec (confirmed in-thread): V4 runs entirely on this branch and is meant
### 2026-09-19 — Jev-authoritative comp selection + per-comp truth scores
> User directive: "made JEV in charge of total comp selection … ask JEV out
### 2026-09-19 — Dual truth: ARV vs investment comp buckets
> User concern: "separating ARV priced and condition comps from
### 2026-09-19 — Bucket-by-higher-truth eval model (current spec)
> User spec (d506841): the higher truth score assigns each comp's
### 2026-09-19 — Stale-price reconciliation + flip classification (verified)
> User spec: reconcile stale provider sale prices against Zillow for ALL
### 2026-09-19 — Configurable sale-age fallback tiers (a135400)
> User directive: on INSUFFICIENT_COMPS, retry at 365d then 18 months —
### 2026-09-19 — Vintage-subject year cap (pre-1970 fallback)
> User rule: "If the property is pre 1970 and there are no comps that
### 2026-09-19 — Jev outcome API durability (primitive-agnostic contract)
> Requirement: the service is primarily an API tool — a property submitted
### 2026-09-19 — API polling endpoint + burst-throttle hardening
> User is about to send properties via the API in bursts up to ~100
### 2026-09-18 — Reset from feat/jev-rules-evaluation
> - Prior branch (Python/GIS bridge + Jev atomic signals + Python-owned
### 2026-09-16 — CDARV independent audit + live hardening pass (uncommitted fixes below)
> Ran the real system end-to-end against local services + real
### 2026-09-16 — CDARV full loop built (feat/cdarv-ml-foundation, NOT merged/deployed)
> Stage 2–4 implemented on top of the c4fc09c foundation (v1 scaffold fully
### Prior: eval-engine canonical ARV audit (suspended)
> Evaluations hardening: establish the canonical Flowstate ARV contract,
### 2026-09-?? — Canonical ARV contract audit of V4 (this session)
> Owner-supplied canonical contract (top-3 by verified sale price DESC,
### 2026-09-?? — Comparable candidate-retrieval hardening (uncommitted)
> Audited + hardened CoreLogic/Cotality pool retrieval. Provider facts
## Prior Objective (completed)
> Landing page v2 for `apps/dashboard` — credibility landing page for
## Merge & Deploy Status (2026-09-12)
> - `landing-page-v2` pushed to origin; fast-forward merged into `main`
## Google Cloud / Maps (2026-09-13 — RESOLVED, key rotated)
> - Prod Maps key rotated to AIzaSyCQVFWXbhBwmp6mskH8ngBOLNbRds2LVDc on
## Report dedup + fixes (2026-09-13, deployed, run 34730181169 green)
> - Shared services/report-upsert.ts: matches by provider clip OR
## Cotality endpoints + Atlas removal (2026-09-13, deployed 34734669544)
> - Atlas globe REMOVED: atlas page, GlobeInner, /user/reports/map-points
## Parcel flood-zone + site-location integration (2026-09-13, branch feat/cotality-flood-zone, NOT yet merged/deployed)
> - Parcel flood-zone VERIFIED on existing host+token: GET
## Subject AVM + building-detail enrichment (2026-09-13, same branch, commit 608a21b)
> - AVM endpoint DISCOVERED + GATED: GET
## Completed (landing-v2)
> - Rewrote `/` (`src/app/page.tsx`) as a company credibility landing page:
## Verification (landing-v2)
> - `npx tsc --noEmit` in apps/dashboard: clean.
## Polish pass 1 (product engineer feedback, 2026-09-11)
> - Speed feel: `active:scale-[0.98]` press feedback + duration-150 on all
## Polish pass 2 (product engineer feedback, 2026-09-11)
> - Footer minimalized: logo + hello@flowstate.homes + disclaimer + copyright
## Polish pass 3 (product engineer feedback, 2026-09-11)
> - Menu rework: right-side Sheet drawer removed. Burger now toggles a
## Polish pass 4 (product engineer feedback, 2026-09-11)
> - Response-time copy unified to 24 hours everywhere (Process heading/steps,
## Polish pass 5 (product engineer feedback, 2026-09-11)
> - Form field surface: new `--input-fill` token per preset (night black
## Polish pass 6 (product engineer feedback, 2026-09-11)
> - Menu overlay right-aligned under burger (prior commit), now PERSISTENT:
## Polish pass 7 (product engineer feedback, 2026-09-11)
> - Burger menu + overlay REMOVED. Header is now a standard top nav: logo
## Branch / Baseline (updated 2026-09-11)
> - `landing-page-v2` — reset to `origin/feat/devin-theme` HEAD (7afe144).
## Dev Environment (updated 2026-09-11)
> - Dev server: `apps/dashboard` on **localhost:3100** (PORT=3100 npm run dev).
## Prior Objective
> End-to-end hands-off fix-&-flip evaluation: accurate, fast, scalable, with evidence.
## Completed (this session arc)
> - Vision/photo latency: merged subject renovation+curb-appeal into ONE LLM call;
## Verified
> - Engman: 6.9s, ARV $344k, eval pass. After no-shortcuts enrich: all 6 comps
## Pipeline Order (as specified by product)
> comps search -> enrich ALL (subdivision/foundation/style) -> appraisal rules
## Framework Update (committed)
> - Rehab framework renamed to canonical: Lipstick / Light Cosmetic / Full
## Production-prep QA (committed)
> - Deleted 6 stale python-*.test.ts regression files (dead python engine modules).
## Eval-result cache + grade semantics (committed)
> - 21-day eval cache: KV key eval-result:{userId}:{normalizedAddr}:{paramsHash}
## Deployment
> - Migrations 0021 (analysis_runs) + 0022 (ui_prefs) applied to remote D1.
## Pending / Next
> - Observability: extend evidence with photo/vision metrics if desired.
## Last Handoff
> Pipeline hardened per spec. Next likely: more comp-quality evidence or
## Apples-to-apples comps + AVM (branch: feat/cotality-flood-zone, pushed, NOT deployed)
> Product spec implemented 2026-09-12:
### Comp qualification (hard rules, provider building data)
> - New filter types: neighborhood_match, construction_material_match,
### Location + expansion order (flipped vs old behavior)
> - Subdivision preferred; neighborhood is the location level when no
### Condition gate
> - services/evaluation uses assessor buildingCondition for the ARV gate;
### Normalization + response
> - Subject: additionSquareFeet (buildingAdditionsAreaSquareFeet),
### Dashboard
> - DealSummaryHero: AVM cell with +/- delta vs ARV (tooltip: excluded
### Verified
> - vitest src/: 78 appraisal tests pass (35 evaluator + 43 rules incl.
### Remaining
> - AVM entitlement: thvMarketingStandard model valid but Order Manager
### Follow-up (same branch): Zillow fallback fills + card tweaks
> - mergeZillowDataIntoProperty extended: when provider data is missing,
### Hard-rule spec + audit-trail rework (2026-09-13, same branch, pushed)
> Diagnosis for `5351 Oxford Crest Dr` (job_1789274746482_oh1tga5q):
### Provider building-detail supplement (2026-09-13, same branch)
> Duval county property-detail lacks buildingImprovementConditionCode —
### Confidence gating (2026-09-13, same branch)
> Product spec: HIGH = 3+ excellent comps (recent, tight size/year/style,
### Rule rework — sale age absolute, year-built ladder (2026-09-13, same branch)
> Product spec change (user): sale_age ≤180d is ABSOLUTE — never relaxed
### Per-filter Required/Preferred (priority) — user-configurable (2026-09-13, same branch)
> User request: every filter needs Active toggle + Required/Preferred
### Comp-card lot/garage + stories hard rule (2026-09-13, same branch)
> - CompGridCard: new "Lot" row — comp acres + sqft delta vs subject,
### No-human-review + half-story tolerance (2026-09-13, same branch)
> Product clarification: there is NO analyst/human-review step — the
### DEPLOYED + golden-eval harness (2026-09-13)
> - Migration 0028 applied to REMOTE D1 (d1_migrations row inserted
### WIP: condition evidence + neighborhood fallback (2026-09-13, feat/condition-and-neighborhood)
> Implemented per product spec (vision/permits for subject, provider-first
### Style-match required + rate-limit tracker (2026-09-13, feat/condition-and-neighborhood)
> - building_style_match default priority → 'hard'. Verified style
### DEPLOYED: feat/condition-and-neighborhood → main (33c2e62)
> - Deploy run 34781263673: API + Dashboard both green.
### Notify feedback loop (9d769cc, merged to main)
> - ComparablesSection: Notify button in manual-selection banner →
### Card density + UI cleanup (860c8e6, merged to main)
> - Notify button moved to comparables header — always visible (was
### Stacked comp sort + neighborhood filter (9720a10, on main)
> - ComparablesSection sort stack: selected comps pinned contiguous →
### Batch review workflow (e92ce60, feat/batch-review-workflow)
> - api migration 0029: saved_reports + feedback_status / notes /
### DEPLOYED: feat/batch-review-workflow → main (044640a)
> - Deploy run 34785478384: API (38s) + Dashboard (1m29s) green.
### Batch FIFO queue + provider-call tracking (f7b9640 → main 907e551, DEPLOYED run 34787573784)
> - Address cap 50 → 1000 per list (route + CSV validation).
### 164-address production batch (IN PROGRESS 2026-09-13)
> - Source: redfin_2026-09-13-15-30-26.csv → 164 San Antonio addresses.
### Batch resume-from-row (feat/batch-resume-from-row → main 697d599, DEPLOYED run 34789984225)
> - POST /batch/:id/resume {fromIndex}: session-auth; 409 while a live run
### List-1 run stopped by user (2026-09-13 ~23:10Z)
> - batch_c3711744 stopped at 8 completed / 10 failed / 146 cancelled
### Batch stop/cancel + stuck-flag fix (feat/batch-stop-cancel → main 7a6f827, DEPLOYED run 34790356619)
> - POST /batch/:id/stop — pauses after current address; rows stay pending
### 2026-09-13 — Confidence decoupled from comp volume + report timing (merged `3e00dc6`, deployed)
> - ✅ **Confidence = match quality, not count.** `report.ts`: `selected.length < 3`
### 2026-09-14 — Batch watchdog + force-complete removal (merged `4e8f8d7`, deployed `34793494581`)
> - ✅ **Per-address watchdog** in `BatchJobDO.processOneAddress`: every child-DO
### 2026-09-14 — Batch self-heal alarm + settings-save retry + UX fixes (merged `210775a`, deployed `34794556662`)
> - ✅ **DO alarm watchdog (permanent auto-resume).** `BatchJobDO.alarm()`:
### 2026-09-14 — Evaluation-settings save 500 + batch alarm silent-death fix
> - ✅ **`appraisal-rules.ts` fully wrapped in `withDbRetry`** (was the only
### 2026-09-14 — Feedback submit 403 "Untrusted origin" (merged `79b3c0a`, deployed `34798338081`)
> - Root cause: `submitReportFeedback` is a Next.js server action → the API
### 2026-09-14 — Real-time stopwatch for in-flight batch row (merged `3e534c8`, deployed `34800425701`)
> - `BatchResult.startedAt` (epoch ms) stamped in BatchJobDO when an address
### 2026-09-14 — Batch review triage filters (deployed `34801584274`)
> - "Hide reviewed" checkbox (default on) — stamped rows (validated/improve)
### 2026-09-14 — Stopwatch staleness fix (deployed `34802230275`)
> - Alarm auto-resume resets now clear `startedAt` AND write progress to D1
### 2026-09-14 — Headshot-photo fix + copy buttons (deployed `34804498166`)
> - Root cause of "girl's face" cover photo on 20810 WOODLAND CV comp:
### 2026-09-14 — Proximity comp ranking + card photo ratios (deployed `34804950103`)
> Ticket summary — 4 flagged-for-improvement reports (feedback_status='improve'):
### 2026-09-14 — 24/7 batch sweeper + list-switch UX (deployed `34862156165`)
> - Overnight batch batch_c3711744 DID complete (~04:55Z): 97 done / 67
### 2026-09-14 — List-detail 500 root cause (deployed `34866433602`)
> - GET /batch/:id 500'd for the 164-row list since the feedback-stamp join
### 2026-09-14 — iPhone PWA native feel (deployed `34904235419`)
> - viewport-fit=cover + userScalable=false in layout.tsx → safe-area
### 2026-09-15 — Provider-call efficiency pass (merged `5fa2673`, deployed `34927651033`)
> Real batch stats (120 completed runs): 11.8 paid calls/report avg
### 2026-09-15 — Opt-in permits + listing-derived flood (uncommitted, main)
> Product direction: motivated-seller vetting (~25 evals/day → 750/mo).
### 2026-09-15 — Closest-first comp selection (uncommitted, feat/iphone-pwa)
> Product rule: nearby comps are scrutinized first and only skipped when
### 2026-09-15 — Deployed (34931916528) + appraisal/UI improvement package
> **Deployed**: `bba0a64` (permits on demand + listing flood) and
### 2026-09-15 — CDARV ML foundation (feat/cdarv-ml-foundation, c4fc09c, NOT merged/deployed)
> Foundation for ML that consumes ideal reports and learns comp
### 2026-09-20 — Jev comp price classifier Candidate B (feat/jev-outcome-classification, uncommitted→commit pending)
> Structured-choice comp classification beside Baseline A dual-noul argmax.
### 2026-09-20 (b) — Abstention analysis + Stage-1 verification (still feat/jev-outcome-classification)
> Shadow-only abstention instrumentation added; no routing change, no threshold
### 2026-09-20 (c) — Candidate B PROMOTED to production + merge prep
> User directive: ship B as the evaluation path ("materially more accurate…
### 2026-09-20 (d) — Post-merge repo audit (main @ 17bcf51)
> Systematic sweep of apps/api (122 ts files, 41k LOC) + dashboard lib.
### 2026-09-20 (e) — Post-merge hardening shipped + PRODUCTION DEPLOYED
> Branch chore/post-merge-hardening → main → pushed origin/main (f103ea2).
## 2026-09-20 — Classifier reverted to Baseline A (shadow B), TYPESAFE key provisioned
> - Found TYPESAFE_API_KEY absent from prod secrets (had only ever existed in
## 2026-09-20 — Landing page v2 + deal-form email delivery fixed
> Branch feat/landing-admin-footer (not merged): 8333a4a + d78bb45 + 0d8a862
## 2026-09-20 — Password-reset emails ported to Fastmail JMAP
> Branch feat/landing-admin-footer (not merged).
## 2026-09-20 — SHIPPED: landing v2 + Fastmail email (main 0c541fc)
> feat/landing-admin-footer fast-forwarded to main (ad810ba..0c541fc, 8
## 2026-09-20 — SHIPPED: "New Analysis" force-fresh + B shadow valuation UI (main 1a3c23f)
> - User reported B shadow not visible in UI: root cause — JevShadowValuationCard
## 2026-09-21 — V4 hybrid redesigned: classification-free, score-ordered, 60% floor
> Worktree flowstate-v5-new-classification, uncommitted. Supersedes the
### Product decision (user-directed)
> - V4 no longer uses Jev price classification at all — "we haven't found a
### Implementation
> - apps/api/src/services/comp-hybrid/index.ts: scoreHybridPool() signature
### Verified
> - comp-hybrid.test.ts: 17/17 (rewritten: score-ordered selection, older-
### Open / watch
> - as-is pool under price ceiling was empty this run (qualified extras all
## 2026-09-21 (b) — INSUFFICIENT_COMPS fix: neighborhood_match treated as location rule
> User reported "invalid comps" for 2607 Smithtown Dr, Lakeland FL 33801 —
### Root cause
> - 44 comps fetched at 1mi, all gated → INSUFFICIENT_COMPS.
### Fix (apps/api/src/services/appraisal/index.ts)
> - Added neighborhood_match to the location-failure family:
### Verified
> - Offline: enriched pool + user preset → subdivision_expansion, ARV
## 2026-XX — V4 overhaul: pure-Jev cross-examination (comp_exam_v1)
> User directive: V4 is entirely Jev-driven — the deterministic weighted
### Implementation
> - services/jev/index.ts: crossExamineCompsWithJev + COMP_EXAM_* exports.
### Verified live — job_1790053429476_202c5cf15b0a47d7 (Sarasota, 34 comps)
> - jev-1.13.0, 58,989 input tokens. 34 examined → 1 passed the all-6 gate.
### Open tuning decisions (flagged to user)
> - All-6-at-50% gate is strict: 1/34 survived → single-comp ARV. utility
## 2026-09-22 — V4 gate split + best-available fallback (live-verified)
> **Decision (product):** split the six exam nouls — `market_area`, `sale_recency`, `size`, `transaction` gate (admissibility: is this sale even evidence); `physical_character`, `uti…
## 2026-09-22 — comp_exam_v2: preset-generated nouls + verifiability + confidence ranking (live-verified)
> **Improvements shipped (user's ordered list 1–4):**
## 2026-09-23 — comp_tests_v1: two-test Jev classification (live-verified)
> **Spec (user's fresh prompt, replaces all prior pipelines):** ~100 raw comps → Test 1 = one noul per raw field (bedrooms, bathrooms, squareFeet, lotSize, yearBuilt, propertyType, s…
## 2026-10-06 — fix: inverted vintage-cap clause in test-1 yearBuilt (live-verified on 4014 22nd Ave N)
> **Bug:** `buildTest1Defs` injected `vintageYearCap` into the yearBuilt
## 2026-10-06 — Jev sole-authority fill + subject condition fix (merged to main, deploying)
> - `4a1c3ac`: fill now ranks by composite score (highest score → closest
## 2026-10-06 — swe-2-eval funnel implemented + verified (branch swe-2-eval, commit db99f19)
> **Objective:** new evaluation funnel per the user's authoritative spec —
## 2026-10-06 (later) — refined swe-2-eval spec + manual tier overrides (commit 37efc58)
> **Spec changes after user review of db99f19:**
## 2026-10-06 (later 2) — CoreLogic code-table expansion (commit e684489)
> **Finding (user-reported):** enriched comp cards showed raw codes
## 2026-10-06 (later 3) — MERGED + DEPLOYED to prod
> `swe-2-eval` fast-forwarded onto `main` (`bbbc847..10eae9b`) and
## 2026-10-06 (later 4) — Front-end performance pass (6 steps, all committed)
> User asked for a full UI speed/efficiency audit, then approved a
## 2026-10-06 (later 5) — perf pass MERGED + DEPLOYED
> `swe-2-eval` fast-forwarded `10eae9b..d5881dc` onto main; deploy run
## 2026-10-06 (later 6) — comp photo verification idea recorded
> User flagged report job_1790233689475_049295ac3f1d47cd (3249 54th St N,
## Session — main-line UI fixes + Close CRM update (all on origin/main, deployed)
> Commits: ed39f9c, 758cf0b, 2fc9888, 2974264, 43499fd, 278f645, 83027d6

## 2026-09-28 — PR #56: map + sidebar UX polish (deployed)
- SubjectMap defaults to satellite aerial (was auto-opening Street View); Street View still available via button once panorama resolves
- Fixed satellite flicker: correctedMarkers memoized + marker click handler ref-stable — status/state re-renders no longer rebuild Google markers
- Sidebar collapse toggle moved to top logo row (right side, ChatGPT-style); bottom toggle removed; nav rows no longer force cursor-grab
- Census block-group comp signal confirmed merged earlier (PR #50)
- Deploy run 36363389577: API 45s + Dashboard 1m33s, success
