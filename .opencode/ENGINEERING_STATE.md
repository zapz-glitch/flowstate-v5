# Flowstate v5 engineering state

## Current objective

Sept 10: owner requested a Devin.ai-style visual redesign of the dashboard.
Implemented on new branch feat/devin-theme (off v4-python HEAD): monochrome
design tokens in globals.css (near-black surfaces, hairline borders, inverted
white-on-black primary actions, neutral ring/selection, radius 0.375rem),
mono font stack + .mono-label utility, numbered-index feature grid, and a full
sweep removing all purple/violet utility classes across landing, auth, admin,
and analysis UI. Dashboard typecheck passes. layout.tsx themeColor change is
left uncommitted because that file carries the paused font-vendoring work.
Earlier pause state below still applies; staging untouched.

Follow-ups on feat/devin-theme (all committed, dashboard+api typecheck clean):
- Navbar shows icon only; wordmark reads "flowstate"; hero terminal reworked
  to rolling-buffer + stable line ids (flicker fix).
- Brand mark is the house-with-flowing-wave glyph (owner-selected at 9e7016a,
  reverted back to it at 44afe8c after trying lemniscate/infinity variants).
  All favicons/PWA/maskable/touch icons regenerated from it.
- "API Playground" renamed to "Property Search" (sidebar + heading).
- Property Search now restores the last searched property on mount via
  localStorage jobId + GET /user/reports/:jobId.
- New GET /user/reports/map-points (session auth) extracting subject lat/lng
  from fullResponseJson via json_extract — no schema change.
- New /dashboard/atlas page (nav "Atlas"): MapLibre GL v5 globe projection
  over Esri World Imagery satellite tiles, saved reports as white markers,
  click popup → report page. maplibre-gl@^5.24 added.
- apps/dashboard/public/logo-preview.html is committed dev tooling for owner
  logo review — remove before shipping this branch.
Next: owner visual review of Atlas + Property Search persistence; decide
whether semantic status colors (emerald/amber/blue/red) stay or go fully mono.

Owner requested saving and pausing work; fix the remaining errors in a later
session. Do not merge, deploy, or continue remediation during this pause.
Implementation through e6879d2 is committed and pushed on v4-python. Staging
remains running; no services or paid resources were stopped by this handoff.
Owner mentioned a few errors but has not provided their specific symptoms here.
Resume by collecting those symptoms and checking candidate CI run34414562541
(last observed in progress), then address durable state hydration/restart recovery
and the remaining failure/restore/rollback gates. Keep owner acceptance open.
Generated dashboard next-env.d.ts, tsconfig.tsbuildinfo, AGENTS.md and CLAUDE.md
remain preserved locally and unstaged. Credentials remain ignored, not in Git.

Staging app connection and initial browser acceptance pass COMPLETE (agent tests,
not owner approval). Login persists after reload; production API not called.
Heritage job_1788994136273_ef2zqvpq:374k ARV/247k buy,1comp,9permits/6assets.
Piedmont job_1788994233197_armyzrcs:317k/198k,2comps,2permits/3assets;
browser manual selection314k then reset restores exact original ARV,revision2.
Magnolia job_1788994366613_45jvwspt:384k/246k,1comp,9permits/6assets.
All saved reports explicitly python-v4/upper_half_v2, REVIEW_REQUIRED/preliminary.
Heritage/Piedmont PDF downloads pass; owner image200/unauth401, edit unauth401,
wrong origin403, stale revision409.21 API/4 dashboard regressions/API types pass
after Cloudflare manual-redirect fix; redirect301/302/303/307/308 never followed.
Three temporary staging tail processes stopped; no runtime services stopped.
Next: owner app approval and remaining durable job-state hydration/restart,
failure/restore/rollback checks. Main and production unchanged. Credentials only
in ignored0600 staging-login.json; do not copy them into state or Git.

First real-address staging run exposed Cloudflare Fetch rejecting redirect:error
in hosted adapter. Changed to manual; all redirect301/302/303/307/308 responses
are rejected without another request. Hosted tests/typecheck pass. Staging API
redeployed06165426-6113-4523-81c8-77c50dcf2e17; Heritage retry running.
Initial failed job job_1788989033751_pam30prw loaded correct provider subject/comps
but never saved. Sanitized tail confirmed redirect option error, not appraisal
rule failure. Old-job SSE reconnect after isolate loss returned no history:
AnalysisJobDO.handleGetState reads memory only despite persisted jobState. Record
durable state hydration/restart recovery as a remaining readiness task, not proven.
TLS/account mapping gates are resolved. No production/main changes.

Staging TLS recovered without bypass or production DNS changes. Real signup/login
passed for userV7yMtWoR4tAHQo1b9D71Nb9KEb90bdXP; browser login persists on reload,
staging cookie domain/prefix verified and no production API calls observed.
Dashboard deployedab63b044-ec93-4b9b-8186-3b849633bed8 at staging.flowstate.homes;
clean Next/OpenNext build passes (staging origin baked in), gzip1278KiB.
Render API/worker redeployed9ba02f3 with real user mapping; canary credential removed,
worker switched to that user (no extra paid worker). Deploys dep-dagsrv142hec73euqs10
and dep-dagsrv9t0dsc73flbqi0 both live. Cloudflare per-user transport secret installed.
Secrets/login/browser session files remain ignored0600 in .data/local-candidate.
Browser real-address Heritage evaluation underway using staging-eval.mjs helper.
Old certificate-blocked notes below are resolved; app acceptance still pending.

Cloudflare staging app execution active: created D1 flowstate-v4-staging-app
13de78d5-6d02-452a-9101-82cfff4299ed, KV1846bfcab8444b198a38a5fd068f8550,
private R2 flowstate-v4-staging-report-assets. All23 D1 migrations applied remotely
to this new staging DB only. API deployed3482cabb-1310-4c71-a8a3-af1b2430a140.
Free plan required new_sqlite_classes; adjusted new staging namespaces only.
Fresh auth/internal/snapshot secrets stored ignored0600; provider test credentials
copied to staging without rotating source keys. Dashboard secrets configured.
API custom domain attached with cert827feed1-f1fa-423d-bf92-d8945e68e3ba, but TLS
handshake currently fails; no HTTPS bypass. Certificate-pack read denied by OAuth.
Staging signup/user mapping/browser evaluation still pending TLS readiness.
Clean build /tmp/flowstate-staging-build.qmMcuV uses9ba02f3 without tracked env files,
explicit NEXT_PUBLIC_API_URL=https://api.staging.flowstate.homes. npm ci audit0,
Next production build passes; OpenNext artifact build running. Localdev unchanged.
Helper /tmp/flowstate-staging-app.mjs manages protected secrets/login initialization.

Latest milestone: Render API and worker LIVE at9ba02f3. Worker ID
srv-dagsn3uk1f9s73dpllfg, deploy dep-dagsn46k1f9s73dplp20. API deploy
dep-dagslrhclf7s73f0b97g live; HTTPS readiness database/schema ok.
Full final local Python353pass;21 API/4 dashboard regressions, types/lint passed.
Hosted synthetic HTTPS canary passed exact local ARV parity and same tenant/user:
automatic550000 comps3/2 (cc4799fc-4ff4-4487-abfa-a2830c49dba0),
manual450000 comps3/0 (c81aaa55-dc95-4c5b-8f55-69ff3c075aa6),
reset550000 (9fe4f520-ce79-4944-bb54-a51545f5b619),
insufficient null (07bf29b7-c0fd-4f2c-80c5-6354e133ec67).
All replay IDs reused; unauthenticated401 and nonexistent evaluation404 verified.
Initial canary422 corrected required Idempotency-Key header in test helper only.
No live provider calls. Cloudflare staging resources/login/browser/real addresses
remain pending. Production/main unchanged (remote main16f879a verified).
CI3932229 and exact deployed9ba02f3 run34405245843 both succeeded.

Hosted staging milestone: candidate changes committed/pushed to v4-python only.
Latest candidate9ba02f3; main remote still16f879a. Render API srv-dagsi5uk1f9s73dp1s40
created, autoDeploy off, URL https://flowstate-v4-staging-python.onrender.com.
Database available and migration completed. Found bare PostgreSQL URL selecting
psycopg2 in Alembic and health probes; both now normalize through existing psycopg3
helper.19 migration/health tests pass including both URL forms; full suite rerunning.
Deploy dep-dagslrhclf7s73f0b97g queued for9ba02f3; superseded unhealthy deployment
dep-dagsjabl550s73e9sok0 canceled explicitly to unblock it. Worker not yet created.
Canary credentials stored Git-ignored0600; synthetic identity only, not app login.
Initial GitHub CI failed because Next standalone output was missing;3932229 adds
output:standalone. Its CI passed the Cloudflare artifact step and is running Python.
Runtime helpers /tmp/flowstate-render-stage.mjs and /tmp/flowstate-render-canary.py
retain safe provisioning/status and exact parity smoke checks for continuation.
Generated dashboard next-env.d.ts/tsbuildinfo/AGENTS.md/CLAUDE.md left unstaged.

Staging backend deployment active: PostgreSQL is available; public allowlist remains
empty. Full current Python suite351pass (27 warnings), typechecks/lint pass.
API regression retry uses the verified Python virtualenv after the default
interpreter invocation failed. Preparing candidate-only commit/push for Render;
production workflow is main-only and remote main remains16f879a.
Initial hosted smoke uses isolated staging-infrastructure-canary user credentials,
not an application user or a default-user fallback. Replace/add explicit real D1
staging-user mapping before claiming app evaluation or login is wired.

Latest provisioning retry succeeded (HTTP201); billing blocker resolved.
Created flowstate-v4-staging-postgres, ID dpg-dagsfppt0dsc73fjgbo0-a.
Follow-up GET verifies status creating, PostgreSQL17, Virginia,0.1c-256mb,
5GB disk and empty public IP allowlist. Do not create another database.
Owner approved approximately $22/month staging base plus usage. API/worker and
Cloudflare provisioning remain pending; database readiness/migrations not yet
verified. Main, production, and provider credentials remain unchanged.
This result supersedes older billing/budget-blocked notes below.

Staging provisioning preflight: Render services and Postgres lists are empty for
verified workspace tea-dagodvek1f9s73dp4it0. Cloudflare OAuth works; R2 bucket list
and D1 list succeeded. Proposed staging D1/bucket names do not yet exist; existing
production resources were only listed, not read for content or modified. Current
Render published baseline is7USD API +7USD worker +6USD PG compute, plus5GB storage
(approximately22USD/month before variable usage). Request concrete billing approval
before creation. All preflight operations read-only; no resources deployed.

Local Compose follow-up: missing API Dockerfile and shared port repaired, both
dev images pinned to Node22 matching CI, complete workspaces included for npm ci.
First image inspection caught nested .dev.vars inclusion under old root-only
Docker ignore rules. Removed only both just-created images (5f2909d9...,4ceeee36...)
and seven associated source/COPY/npm cache IDs; verified targeted cache absence.
No push or runtime restart. Recursive exclusions and pre-install credential guards
added. Both clean builds pass with npm audit0; network-disabled API image check
confirms non-root execution, credential absence, Wrangler version and real /health
startup. All21 API regression files/4 dashboard files pass; secret scan/diff check
pass. PostgreSQL harness now pinned17 like Compose/CI/Render;350 full-suite tests
pass, plus the added real server-major-version assertion passes separately.
Do not claim full Compose login/evaluation is wired yet.

Sequential readiness execution: step1 hosted transport implemented and locally
verified; step2 staging configuration prepared, remote provisioning pending budget.
350 Python tests pass including real local HTTP TS->durable API->Postgres->worker,
manual selection/reset and upper-half weighted ARV. Returned API result now includes
requested_by_user_id; TS verifies user/tenant/batch/evaluation before accepting it.
Hosted transport is staging-only, per-user token map, deterministic idempotency,
20second total polling and no legacy fallback. Production remains disabled.
19 API suites/4 dashboard suites passed; added staging-auth and deployment-config
checks pass separately, typechecks/lint/diff-check pass. Updated Docker image builds.
Separate staging API example and dashboard config, cookie prefix/domain and explicit
R2 staging enable flag prepared; no live DNS or auth browser verification yet.
Render access IS verified, correcting older notes below. Workspace ID local config
fixed, actual API name My Workspace. No billable resources, remote writes or main
changes. Monthly staging budget question sent; wait for approval before provisioning.

Latest staging integration milestone: durable API now accepts and persists
selected_comp_ids and both execution paths restore it. Omitted/null selections
preserve the historical stored payload shape for idempotent replay; no schema
migration or appraisal rule change. API selection/reset and invalid-input tests
pass in full347-test suite; two additional supervised-worker selection/reset tests
pass separately. Main/production unchanged. Render workspace is Flowstate,
tea-dagodvek1f9s73dp4it0; owner uses Starter build pipeline, no Pro upgrade planned.
No Render credentials/connection available; plugin-management search tools are
not available in this session. Hosted transport/storage integration remains open.

September 9 staging execution: owner chose PostgreSQL for Python only; retain D1
for application data. Prepare isolated Cloudflare + Render staging on v4-python.
Docker integration now works with sandbox escalation. Full PostgreSQL-backed
suite passes: 342 tests, 27 deprecation warnings. Corrected one stale API test to
assert REVIEW_REQUIRED, preliminary ARV and exact590000 for its incomplete legacy
fixture; evaluation policy unchanged. Standalone pinned Python image builds.
Added render.staging.yaml and docs/eval-v4/STAGING_SETUP.md; YAML/isolation checks
pass, remote Render validation/provisioning pending. No paid services created.
Remaining: hosted durable adapter, staging Cloudflare/storage bindings, owner-scope
worker integration, remote account/billing access and end-to-end staging approval.
Older compose.dev.yaml API-worker has missing Dockerfile/shared-port defects;
do not claim full Compose startup is verified. Main remains16f879a, no deploy.

Owner authorized remediation of the readiness review. Active packages: isolate
local deployment config; fix null-reset/canonical-date; bound Python request
bodies; version snapshot keys; wire CI/lint/dependency checks. Keep main and
production untouched. Staging infrastructure/credentials, Docker access and
remote release actions remain gates, not assumed completed by local changes.

Local remediation now implemented and verified: deployment isolation, stale-null
reset, canonical sale date,2MiB authenticated body boundary, independent versioned
snapshot signing with legacy support, scoped share-asset access/deletion, CI/lint
and dependency fixes. See docs/eval-v4/REMEDIATION_STATUS_2026-09-09.md. Staging
target/access and unavailable Docker block production/DB completion; no deploy.

Final remediation verification:18 API files/4 dashboard files pass;196 clean-lock
Python tests pass; npm audit0 and Python advisory audit0 after pinned pip26.2
bootstrap. Next/OpenNext builds and API production dry-run pass; lint/typechecks
pass. Browser reset ends in correct nullvaluation revision4. No PR/deployment yet.

Read-only PR/security/main-compatibility/production-readiness review completed.
Verdict: request changes; do not merge or deploy the current candidate. Full findings
and verification: docs/eval-v4/PR_READINESS_REVIEW_2026-09-09.md. No implementation
fixes or remote writes were made. Next implementation requires owner direction.

Completed for owner app review: show provider permit records on the subject property card,
or Permits - NA with an honest empty/unavailable explanation. Remove valuation
display decimals without changing exact Python math. Provider endpoint live-tested
on Magnolia: nine records returned. Adapter/card changes, regression tests, both
typechecks and fresh localhost saved-report browser checks pass.

Latest owner addition: when existing stages produce zero eligible ARV comps,
extend sale history and then allow 1-mile and 1.5-mile search fallbacks without
weakening physical matching. Maximum historical age is pending owner choice
(24 or 36 months asked). Version the new policy so saved V2 reports replay unchanged.

Implement the owner-approved provider-authoritative V4 policy on v4-python.
New reports freeze provider characteristics, ignore listing asking prices, refresh
completed sales through Zillow, Redfin, then Realtor.com, and preserve private
photo/screenshot assets. Python selects the upper half plus ties, excludes only
clear sale-relevant distress, and weights every surviving reference by rule match
and recency. Expand only at zero usable ARV references: 180 days / +/-10 years,
365 days / +/-10 years, then 365 days / +/-15 years, retaining other physical gates.
These decisions supersede the historical pending-policy notes below. No 50 RPM
target is in scope. Owner app approval remains required; main stays untouched.

V4-N09/N10 ready for owner app test: simplified comparable diagnostics and
top-right manual ARV selection with authoritative Python recalculation/persistence.
Exact evidence remains unchanged; manual selections are preliminary. No owner
approval assumed from agent verification.

V4-N06 rounding is ready for owner app test. Bounded provider correctness fixes
for V4-N07/N08 are verified; full evidence integration remains pending. Preserve current work and
the next implementation tasks V4-N01 through V4-N08 in docs/EVALUATION_V4.md.
Tasks cannot close on automated verification alone: the owner must test them in
the app and explicitly approve before they move to Owner approved. Preserve
the checklist and approval evidence. Main, production and provider keys unchanged.

## Baselines

- Repository: zapz-glitch/flowstate-v5
- Main: 16f879a (must remain unchanged).
- V4 candidate: ab317a5, tracking origin/v4-python.
- Existing separate API V4 checkout has a user-modified package-lock.json;
  leave that checkout untouched.
- Owner removed the antislop instruction requirement; do not ask about it again.

## Active

- V4-P01: Python versioned staged selection, condition labels, historical replay tests.
- V4-P02: listing fallback, provider-only characteristic authority, condition-only vision.
- V4-P03: private report assets and insufficient-evidence report persistence.
- V4-P04: effective provider search/cache parameters, integration, five-address QA.
- Five-address V2 browser verification is complete. New historical/distance
  expansion is queued pending the sale-age cap. Python PID186411 / session66386,
  API session46536, dashboard3004 remain running.
- Source failures must preserve provider-only math with explicit evidence limitations.
- V2 implementation and focused QA complete; final real-provider/browser checks
  remain active. Historical fallback is now approved only at zero usable ARV
  references. Existing signed reports retain their original policy.
- V4-N09/N10: ready for owner app approval, not closed. Inspect report
  job_1788906780962_obnjsk2b; add/remove top-right checkbox, Reset, reload and PDF.
- V4-N06: Ready for owner app test; not Owner approved. Python/API/dashboard/PDF
  formatting integrated, exact values retained. No further rounding implementation
  required before owner test; local500 setting not exposed, synthetic coverage only.
- V4-N07/N08: corrected permits endpoint/shape and provider failure/cache semantics
  verified. Five real subject permits retrieved. System-age mapping and broader
  subject/comp hazards remain pending; no false claim of completed integration.
- N01..N05 policy resolved for this candidate by the approved V2 sequence.
  App approval remains pending; do not broaden the fixed stages to force results.

## Queued

- V4-N01..N08: subdivision-first historical search; joint subdivision/year/sqft
  comparability; upper ARV/lower inferred as-is cohorts; multiple-comp weighting;
  bounded retrieval expansion; headline rounding; permit evidence; subject/comp
  flood and hazards. Full requirements, acceptance checks and unresolved choices
  are in docs/EVALUATION_V4.md. All owner app approvals are pending.
- V5-04: repair replacement blockers, then verify the backend integration.
- V5-06: independent QA and SOL review; candidate branch handoff.

## Completed

- September9 PR readiness review: live main16f879a matches localmain and is an
  ancestor of HEAD9a3c778; remoteV4ab317a5, no openPRs. Reviewed dirty/untracked
  implementation too. Three independent read-only reviews covered security,
  workflow/deployment and evaluation compatibility. Full report in docs/eval-v4.
- Review verification: workspace typechecks,16 API suites,4 dashboard regression
  files, isolated Next production-mode webpack build and limited secret scan pass.
  FullPython221passed/1skipped/107setup errors: Docker unavailable in WSL blocks
  DB/migration/worker verification. Lint fails inherited next lint command.
  Audit: production1critical MapLibre baseline dependency; all dependencies9
  affected package entries (1critical/4high/4moderate). No application MapLibre
  reachability proven. Main's latestDeploy failed; no branch protection/rulesets.
- Review blockers recorded, not fixed: production config contains development/
  localhost and localbucket; Python/asset integration is development-only; Reset
  can retain stale ARV after null server result; report date can disagree with
  canonical fallback date; durable API body buffering lacks pre-auth bound;
  bridge-token rotation invalidates historical signatures; CI omits app tests.
- Permit card and whole-number valuation verified on fresh Magnolia report
  job_1788967256552_z1q9ikuo. Live building-permits endpoint returned nine records;
  all nine persist in subject/root permit evidence and render on the property card.
  Empty, unavailable, historical and loading states covered by render regressions.
  Raw provider payload omitted from display records; status history remains retained.
  Monetary/percentage displays no longer show decimals; exact math unchanged.
  Provider/response/manual tests, display tests, API/dashboard typechecks, diff check,
  saved-report browser and 390px overflow checks pass. Main unchanged; no deployment.
- Final five-address V2 QA passed: Heritage374000/247000, Piedmont317000/198000,
  Magnolia384000/246000, Sparling332000/201000 (ARV/buy). Northlake saved explicit
  INSUFFICIENT_COMPS with valuation:null. Saved reports, math, PDFs, mobile and
  sampled image ownership checks passed. Stored image totals5/2/7/4/5. Magnolia
  and Sparling reused cached listing evidence. This baseline predates the new
  owner-requested historical/distance expansion.
- Final identity review regressions fixed and independently verified: valid
  provider-ID-only requests work; Court-plus-ZIP does not become Connecticut.
  Both identity suites and API typecheck pass, bounded SOL review clear.
- Magnolia 422 isolated to a 133-character listing evidence reference exceeding
  the Python contract's 128-character limit. Compact references retain full URLs
  in the listing audit. Long-URL adapter/contract regression and all 11 bridge
  tests pass; bridge errors now identify invalid fields without exposing inputs.
- V4 subject identity now checks exact normalized street/unit/locality and selected
  provider ID before evaluation. Selected IDs use direct provider lookup. Identity
  tests and API typecheck pass; Connecticut query parsing no longer discards CT.
- Final dual-pool Heritage job_1788964833459_rinzyhwi and Piedmont
  job_1788964889443_f7674o43 passed saved-report, math, private images, PDF and
  mobile checks. Magnolia retry, Northlake and Sparling remain active.
- Provider-authoritative V2 implementation: fixed three-stage policy, upper-half
  cutoff plus ties, recency weighting, A/B labels only on selected references,
  no vision/garage supplementation. 176 focused Python tests pass. Six API
  adapter/replay/cache suites, asset security, listing fallback, condition parser,
  provider-rate tests, typechecks and dashboard regressions pass.
- Live Sparling job_1788963766029_ix4h4dy2: exactARV331820.6388206388,
  displayed332000, buy201000, one312000sale fromJune29. Zillow subject refresh,
  Redfin fallback for comp after unsubstantiated Zillow evidence. Five private
  assets, owner200/anonymous401, real card image and two embedded PDF images pass.
- Live Northlake job_1788963682281_6brnwz2u: no qualified references across all
  three stages. Saved valuation:null report and PDF verified; no fabricated price.
- Found and repaired Workerd redirect:error incompatibility in listing and
  CoreLogic calls. Requests now use manual redirect with status checks; no key
  rotation needed. Typeahead failures return502 and a visible retry message.
- Actual Magnolia query probes found default nearby44 includes16142, expanded50
  with or without size bounds omitsit. Combined pool72 restoresrecentreference;
  no proof that sqft arithmetic caused omission. Bounded union<=100 now used,
  same-dateprice conflicts quarantined, original query variants saved to report.
  Finalfreshfive-addressverification active; initial493000Magnolia is historical,
  not accepted evidence of improvedrecencyselection.
- Upper-half experiment September8 local: new snapshots select ceil(n/2) plus
  cutoff ties from physically qualified sales, with rule-match times
  180/(180+ageDays) normalized weights. Recent upper-half sales rank first.
  Old signed snapshots retain legacy policy/hash. Known property-type mismatch
  excluded; unknown style/type preliminary. Garage preference and constrained
  vision observations exposed. PricePPSF>3xmedian with>=4 qualified quarantined.
- Zillow/Firecrawl refresh now corroborates exact property identity and literal
  sold-date/price history row before overrides. Same-date conflicts retain
  originals; asking never enters ARV; audit preserved, PDF resolved values only.
  Bounded scraping90s and vision45s; failures preserve numerical evaluation.
  Reused existingFirecrawl/OpenAI credentials locally via enable-evidence;
  no provider account rotation. RestartedAPI to load local credentials.
- Heritage: job_1788912759663_5rvfjt3p returned INSUFFICIENT_COMPS,15 candidates,
  zero qualified. Same-subdivision7 Hitching Post Ln sale236days old; another
  same-subdivision comp too large. No fabricated valuation or savedPDF success.
- Piedmont: normalized duplicateCt input to4648 PIEDMONT CT ORLANDO32811 through
  exact typeahead. job_1788912849879_0m36c2vk,2qualified tied275000 sales; selected
  both,weights0.540412044374/0.459587955626. ARV317357.901614,display317000,
  Buy198000,Wholesale188000. Browser/PDF/mobile pass. This run preceded credential
  reload; Zillow unavailable and no refresh success claimed.
- FinalMagnolia: job_1788913320994_25fyexz6,1qualified/selected16142 Magnolia Hill
  St at380000, weight1, ARV383694.905552,display384000,Buy246000,Wholesale236000.
  Firecrawl2calls; real sourcecorroboration confirms subject50300 sold2026-05-21
  andcomp380000 sold2026-04-23. Subjectfactor3change warning requires transaction
  scope review; price is not proven market value. PDF50,300 present andold345,000
  absent. Independentmath, desktop/mobile390pxnooverflow,PDF amounts pass.
- Found and repaired vision response-format bug: provider200 returned fencedJSON;
  compatibleprovider now requests json_object when asked. Final vision runs and
  reports both front exteriors unverified, rather than claiming visualmatch.
- Verification:132 focusedPython core/contract/experimental tests plus11bridge
  tests pass; request/response/manual/snapshot/evidence-integration/Zillow/physical
  TS tests pass; API/dashboard typechecks anddiffcheck pass. IndependentSOL
  verified boundedexperiment only. Final call-accounting addition tested with
  mocks/typecheck but landed after final liveartifact. All approval gates open.
  Evidence ignored .data/local-candidate/upper50-{heritage,piedmont,magnolia}*.
- Tam Dr diagnostic 2026-09-08: authenticated browser typeahead, fresh Python V4
  evaluation and saved report job_1788907741939_wmjwg7f8 verified. Fifteen comps,
  one selected: 4728 Okeefe St, 83% (5/6); subject style unknown. Exact ARV
  278615.4411764706, displayed279000; rehab51205, Buy160000, Wholesale150000.
  Four permits returned; system-age mapping absent, flood unknown, as-is absent.
  N03 remains incomplete: closest physical reference is not verified renovated
  upper-cohort ARV. Candidate 4875 Red Willow Ave has provider sale18178000;
  passed transaction evidence checks but ranked11 and did not affect ARV.
  Investigate transaction scope/price plausibility before higher-sale selection;
  do not assume the anomalous amount is a valid individual-home sale.
  Evidence: ignored tam-report.json, tam-trace.sse and tam-report.png under
  .data/local-candidate. Trace recorded19 uncached external calls and6155ms.
  Main remains16f879adcd6b93a7daad815ea6efdde56c874b91; no code/key changes.
- Comparable readability2026-09-08: shared formatter for cards/details/PDF removes
  fractional match scores and raw size/lot ratios. Example83%,8% size difference,
  15% lot difference, Same year built; unknown subject style remains explicit.
  Partial match capped99%, tiny nonzero difference shown less than1%; backend
  data/calculations untouched. Six formatter/render tests pass. Owner approval pending.
- Manual selection2026-09-08: Python optional selected_comp_ids retains hard
  sale/date/area/transaction/dedupe gates; multiple refs use arithmetic mean of
  adjusted PPSF. Every manual result REVIEW_REQUIRED; weighted policy unchanged.
  New reports persist HMAC-signed input/settings snapshot bound to jobID. Older
  unsigned reports require New Analysis; do not reconstruct missing evidence.
- POST /user/reports/:jobId/comps accepts only IDs/reset and expected revision,
  owner session, exact dashboard Origin and bounded JSON. Atomic D1 history+CAS
  prevents competing writes. Client cannot create Python snapshots via legacyPUT
  or reserve python_ audit actions. Python full reanalysis creates a new report
  instead of overwriting prior manual revision. No DB migration required.
- Display update is atomic, pending locks double-clicks, failures retain previous
  values, last-comp removal prevented. Reload retains manual/reset state; current
  PDF/JSON/risk flags use server result. Existing style/features survive remapping.
- Verification:137 Python tests pass,1 skipped; signature/manual/response adapter
  tests, dashboard authority/manual hook tests,6 readability tests, workspace
  typechecks pass. Live button add2: exactARV612807.6064664954, displayed613000,
  Buy434000; reload/reset/finaladd pass, savedrevision4. PDF download and390px
  mobile overflow check pass. Empty400,unknown422,stale409,extra money400,
  badOrigin403,anonymous401; concurrentrequests200/409 create exactly1history.
  Evidence .data/local-candidate/manual-comp-verification.json and manual-comp.pdf.
- Final independent SOL verified signed snapshot/ownership/CAS/history and
  presentation preservation after fixes. Signature/manual/response tests rerun pass.
  Top-right checkbox keeps20px visual with44px touch target; live mobile target
  measurement44x44, keyboard focus and no horizontal overflow pass. Screenshot
  .data/local-candidate/comp-control-mobile.png. Final typechecks/diff check pass;
  main remains16f879adcd6b93a7daad815ea6efdde56c874b91. No commit or push.
- Resumed bounded implementation2026-09-08 (engineering verification only):
  authoritative rounded ARV/Buy/Wholesale fields mapped through API to cards/PDF.
  Python exact values and rounding deltas preserved; investor Buy distinct from
  seller Wholesale.128 Python tests pass,1 skipped,1 deprecation;13 dashboard
  tests, TS request/response/provider tests, API/dashboard typechecks and diff
  check pass. Independent rounding QA/SOL found no scoped blocker.
- Live new report job_1788905670125_a2ufpf92: ARV686000, Buy500000,
  Wholesale490000. Exact ARV685890.5165767155/Buy499701.46491904394 unchanged.
  Real browser login,10 typeahead suggestions,new evaluation,saved report reopen
  verified. PDF downloads25892 bytes;390px browser content width390, no pageerrors.
  Provider now returns5 subject permits; flood:null with explicit unknown warning.
  PDF callsite formatting tested; extracted PDF text not separately compared.
- Antislop during: scoped formatting PASS, existing design/styles unchanged;
  no added visual assets or claims, exact output tests and mobile overflow check
  provide evidence. Broader theme/whole-app design audit not claimed.
- V5-09 (supersedes earlier strict-style/all-filter selection milestones below):
  rank subdivision, year built, relative sqft, relative lot size, physical style;
  select one best usable verified reference. Enabled-rule match percentage is
  independent of priority rank and is not a probability of valuation accuracy.
  Missing/mismatched evidence is visible; partial/single-comp results preliminary.
- Separate inferred as-is/investor summary now visible alongside ARV. Non-ARV
  comps are not automatically as-is; absent cohort returns no invented value.
  Report cards, details and PDF source include ranking/match information.
- Live autocomplete, evaluation and saved-report browser checks passed:
  job_1788851117174_z9l6g75e, Python V4, one of15 selected, ARV685890.5165767155,
  REVIEW_REQUIRED. Rank1 Palmira comp5498427419 scores83.3% (5/6); Ranch mismatch
  is explicit, selected because year/sqft outrank style under latest owner order.
  As-is: INSUFFICIENT_INVESTOR_DATA, zero eligible/cohort comps, no value.
  Saved values match Python; report tampering409, legacy selection409, anonymous
  bridge401. Browser artifacts in ignored .data/local-candidate.
- Latest verification:121 Python tests pass,1 skipped; request/response adapter
  tests, API/dashboard typechecks pass. Independent final QA/SOL:75 Python tests,
  response tests and5 presentation tests pass; no scoped blockers. Diff check clean.
  Downloaded PDF and mobile visual QA not exercised in this milestone.
- Building-style correction2026-09-08: prior adapter omission fixed. Subject and
  comp evidence carry building_style; required Python filter compares casefolded,
  whitespace-normalized labels exactly. Unknown placeholders reject. Local adapter
  injects missing rule and rejects explicit disabling. No Ranch/Conventional alias.
- Live browser rerun of4207 W EMPEDRADO: zero of15 satisfy all current filters.
  SSE decisions explicitly reject5498427419 and8962852494 with Ranch != Conventional.
  No valuation or legacy fallback returned. Full decision evidence preserved in
  error SSE; ignored artifact .data/local-candidate/style-check.sse, assertions pass.
- Style verification:106 Python tests pass,1 skipped,1 deprecation warning;
  TS evidence/response adapter tests and API typecheck pass. Independent read-only
  style QA/SOL passes. One qualifying verified style-matched comp still allowed.
- V5-07/08: actual evaluate_v4 connected via authenticated loopback-only bridge;
  EVALUATION_ENGINE=python-v4 in ignored local .dev.vars. Both DO evaluation paths
  and GHL dispatch use configured evaluator; no fallback if Python fails. GHL
  external writes were not exercised. Python bridge needs no production DB.
- Preserved raw CoreLogic sale-detail evidence through enrichment. Adapter rejects
  PPSF-derived prices and date-mismatched sale records; no fabricated system ages.
  Canonical settings snapshots retain cost settings and explicit legacy-policy
  provenance. Custom unsupported settings fail rather than silently convert.
- Manual roof/foundation costs pass through Python additional items exactly once;
  duplicate conflicts reject. Test: duplicate12000 roof +18000 foundation =30000.
- Owner clarification2026-09-08: minimum one qualifying verified comp is allowed.
  One/two yield preliminary REVIEW_REQUIRED; zero yields INSUFFICIENT_COMPS.
  Existing matching filters and deterministic sale-price order unchanged.
- Browser guards preserve Python values and comp selection. Report setting and
  manual selection controls explain rerun requirement. Stored Python report PUT
  and legacy/LLM comp selection reject409. No layout/component redesign.
- Live browser test: 4207 W EMPEDRADO ST, TAMPA, FL33629,15 candidates,2 selected,
  Python ARV612807.6064664954, REVIEW_REQUIRED. Saved report reopened and exact
  Python result matched display: job_1788849772406_ki4cgsxh. Investor proposal and
  missing system-age limitations retained. Old saved reports remain legacy.
- Verification:92 Python tests passed,1 skipped (DB harness),1 warning;56 of these
  cover rule/bridge tests. Dashboard authority3 tests, TS request and response
  adapters, both workspace typechecks pass. Bridge anonymous401; report and
  legacy selection mutation409 verified against live local services.
- Independent SOL VERIFIED bounded bridge milestone after manual-cost correction.
  Antislop core/code/copy applied during comments and messages: no new decorative
  comments or unsupported claims. Visual design gate not applicable to this change.
- Located existing origin/v4-python and checked it out locally.
- Read previous global engineering state and V4 review policy.
- Merged production main into candidate at 2b7a1e6; main remains 16f879a.
- Reviewed Python methodology, provider gaps, app routes, browser recalculation,
  and settings compatibility. Detailed findings: docs/eval-v4/V5_REPLACEMENT_REVIEW.md.
- Existing Python suite: 207 passed, 27 warnings on isolated PostgreSQL 16.15.
- Added worker startup guard for live mode without a provider; 3 tests pass.
- Enabled V4 candidate CI branch filters and API path coverage.
- Updated compatible npm dependencies and targeted vulnerable Vite/esbuild
  instances. Final production audit: zero findings. Full development audit:
  four moderate findings remain in old Drizzle/esbuild tooling.
- Final workspace typechecks and dashboard production build passed with the
  updated dependencies. Generated dashboard files restored; no dashboard source
  changes in this package. Python pip check passed.
- Independent QA at code revision 77a6e9a498c511381de40206fa32134c36e4fe35:
  210 passed, 27 warnings, 58.86 seconds. SOL VERIFIED this preparatory package
  only. Final API Wrangler dry-run bundle and existing secret scan passed.
- Verified main remains 16f879a and dashboard diff from merged baseline is empty.
- Removed the owned disposable PostgreSQL test container and its test volume
  after QA. Recreate isolated test storage for the next suite run.
- Local candidate API at localhost:8787 and dashboard at localhost:3004, native
  npm development processes. Applied all 23 D1 migrations locally only.
- Fresh local BETTER_AUTH_SECRET and DASHBOARD_INTERNAL_SECRET; isolated account
  local@flowstate.test. Password: ignored .data/local-candidate/login.json (0600).
  Provider credentials reused locally from existing API production checkout;
  provider account credentials and production auth were not rotated or changed.
- Added scripts/local-candidate.mjs for branch-gated local setup and account
  verification. Both dashboard .env.local and .dev.vars are required for Next
  and OpenNext server bindings respectively; all runtime secrets remain ignored.
- Fixed auth-library D1 introspection incompatibility and configured-origin CORS.
  API typecheck passed. Real signup/signin/session and browser login passed.
  Configured CORS accepted localhost:3004 and rejected localhost:3000, an
  untrusted sibling domain, and a suffix-spoofed origin. Anonymous typeahead 401.
- Real browser autocomplete returned 10 suggestions. Selected 4207 W EMPEDRADO
  ST, TAMPA, FL 33629 (CLIP 7707767647); analysis completed with 15 comparables,
  one selected, displayed ARV 761665, rehab 57600, buy 567898.5. This exercises
  the existing TS evaluator, not the pending Python replacement. Saved report
  appears in the report list: job_1788848420984_0q16vwvc.
- Saved report reopened successfully through the visible browser link; address,
  ARV and comparables persisted. User then requested a local password reset;
  changed the test account password, revoked other sessions, verified old password
  rejection and new API login/session success. Fresh browser login and reload
  passed with the rotated password. Updated ignored login.json.
- Removed only Next-generated agent instruction files and restored generated
  next-env.d.ts; no dashboard/UI changes remain. Main still 16f879a. Runtime
  changes remain uncommitted on v4-python for handoff.
- SOL review found no remaining blocker for bounded local runtime changes after
  configured CORS/trusted origins were restricted to exact equality.

## Findings and blockers

- Earlier policy questions are superseded by provider_authoritative_upper_half_v2.
  Current listing imagery has no verified sale-date association, so it cannot
  establish renovation at sale or exclude a high-price comp. Price-inferred B is
  explicit. This is not a pending permission to invent image dates.
- Provider endpoint/mapping and swallowed error/cache issues corrected and tested.
  Subject permits now return5 actual records; Python major-item evidence remains
  empty until scope/completion mapping is implemented. Comp hazards still absent.
- Existing spatial flood endpoint is unsupported by local official schema and
  live report remains unavailable; resolve documented endpoint/entitlements next.
  Unrecognized or failed flood responses now remain unknown, never false safety.
- Durable production Python worker live-provider integration remains missing;
  local synchronous evidence bridge is connected and verified instead.
- User authorized connecting Python V4 locally; nonvisual browser authority
  guards now prevent TS recalculation for marked Python reports. QA passed.
- Saved 501000 tiers conflict with V4 500000 boundaries; migration must not
  silently alter operator settings. Investor policy approval remains a gate.
- Provider administration access remains pending for actual production key
  rotation. Only local auth secrets were refreshed; bounded CoreLogic calls pass.
- Google Maps renders BillingNotEnabledMapError with the configured public key.
  Billing/key administration is required; no billing or external key changes made.
- Full Compose has missing API-worker Dockerfile, port variable collision,
  container-loopback URL, and project isolation issues. Native npm local runtime
  bypasses these; Compose remains unverified.
- SOL verified local bridge; full production replacement remains unapproved.
  Python investor output is now visible in a separate inferred as-is summary.
  Permit-to-system-age evidence mapping and in-report Python recalculation remain
  future work. Change supported Evaluation Settings globally and run New Analysis.
- Comparable cache now includes all search parameters. September9 candidate
  requests50 over12months with actual documented size/distance query parameters;
  Heritage returned49, Piedmont50, NorthLake1. Returned coverage is recorded and
  may remain incomplete; no nationwide live valuation accuracy claim is made.

## Definition of done

- Each N01..N08 entry remains unchecked until the owner explicitly approves it
  working in the app. Record report/address, code revision, test evidence, approval
  date and owner response; retain history. Automated tests cannot close tasks.
- Actual Python rules run behind authenticated local application routes.
- Existing page layout preserved; browser does not override Python results.
- One-comp policy and evidence/mapping regressions pass.
- Local browser and saved-report checks have evidence; limitations disclosed.
- Independent QA and SOL review complete for bounded local testing.
- Main remains at its baseline; all changes reside on the V4 candidate.

## Last handoff

PAUSED at owner request. All implementation is saved on v4-python through
e6879d2; this handoff records the deferred work. Next session should first ask
which app errors the owner observed, check the latest CI outcome, and resume
the recorded readiness tasks. Do not infer approval to merge from this pause.
No new tests were run during the save-only turn; previous evidence remains above.
Main/production untouched; staging left running. Local generated files preserved.

Candidate connection/fix committed and pushed as e6879d2. New CI run34414562541
is in progress; do not claim it passed yet. Remote main verified unchanged at
16f879adcd6b93a7daad815ea6efdde56c874b91. Latest code/config matches the staging
deployment tested above; Render Python source remains9ba02f3 (unchanged backend).

Staging app is live and agent-tested at https://staging.flowstate.homes. Login
credentials in ignored0600 .data/local-candidate/staging-login.json. Browser
Heritage/Piedmont/Magnolia reports pass; IDs/values in latest objective and
docs/eval-v4/STAGING_SETUP.md. Manual/reset, PDFs, permit records and private
photos verified; maps deferred. All reports remain preliminary/review-required.
Cloudflare redirect incompatibility fixed with manual/no-follow regression tests.
Real D1 user now maps to Render API/worker; canary credential removed. No main
merge, production write or production-key rotation. Owner approval is not implied.
Resume with durable job-state hydration/restart recovery, remaining failure/restore
checks and owner testing. Preserve generated dashboard files left unstaged.

Previous handoff:

Staging backend provisioned and verified: private PostgreSQL17, Python API and
owner-scoped worker are live at9ba02f3. Hosted synthetic canary passes exact math,
upper-half multiple comps, manual/reset, insufficient, replay and auth rejection.
Fixes committed/pushed on v4-python only: migration/health URL normalization and
Next standalone CI output.353 local Python tests and exact candidate CI
run34405245843 pass. Continue isolated Cloudflare D1/KV/R2/dashboard/API provisioning
and genuine staging-user mapping before real-address/browser acceptance.
Canary identity is NOT an application login. Do not mark owner approval complete.
Helpers and resource IDs are in docs/eval-v4/STAGING_SETUP.md. Generated dashboard
files remain unstaged; preserve them. No main merge or production change.

Previous handoff:

Retry succeeded: staging PostgreSQL dpg-dagsfppt0dsc73fjgbo0-a now exists,
status creating on follow-up GET. Version17/5GB/Virginia/private allowlist verified.
Billing is no longer blocking. Resume with readiness check, candidate-branch
deployment preparation, API/worker and isolated Cloudflare app verification.
No API/worker deployed yet; main and production untouched.

Previous handoff:

Owner approved staging costs. Attempted private staging PostgreSQL creation;
Render returned HTTP402 because no payment method is attached. No resource was
created. Wait for owner to add a card, then recheck inventory and resume database,
candidate-branch deployment, API/worker, and isolated Cloudflare app verification.
Do not repeat local suites merely to fill this external billing blocker.

Previous handoff:

Latest provisioning handoff: Render/Cloudflare account access verified with read-only
resource inventories. No staging resources exist yet. Need explicit approval of
approximately22USD/month Render baseline plus usage; no Pro workspace upgrade.
Then create only separately named staging resources, prepare credentials and deploy
the tested candidate after its code is available remotely. Do not reuse production
D1/R2, merge main, or claim preflight equals a working deployment.

Previous handoff:

Latest Docker handoff: Compose API build/port and Node version defects fixed.
Both corrected dev images built with npm audit0; API container health smoke passed
without network or published ports, and no credentials present. Old insecure
images from this pass plus7 associated cache records removed and absence checked;
no existing containers/volumes touched.21 API/4 dashboard regression files pass.
PostgreSQL harness aligned to pinned17;350 full-suite tests pass plus1 added
server-major-version assertion separately. Deprecation warnings remain27.
Full Compose D1 initialization/login, container-to-container API routing and Python
connection remain distinct from passing build/health checks. No cloud provisioning,
main changes, commit/push or production actions. Billing approval still pending.

Previous handoff:

Latest sequential handoff: step1 locally complete;350 Python tests pass,19 API/4
dashboard regression suites plus new auth/config tests pass, lint/typechecks and
image rebuild pass. Step2 templates prepared for staging.flowstate.homes and
api.staging.flowstate.homes; do not deploy placeholder D1/KV IDs. Need staged build
API URL, isolated secrets/resources, per-user Python credential/worker mapping and
real cloud/browser tests. Render key verified/private, no longer an access blocker.
Pending owner monthly cost cap before billable resources. No main change, commit,
push, merge, production deploy or key rotation. See STAGING_SETUP.md for current
integration details; older localhost-only notes are superseded for staging only.

Previous handoff:

Latest handoff: queued manual-comparable compatibility fixed in API schema,
durable payload, application processor and supervised worker.347 full-suite passes
plus2 new supervised-worker tests separately; git diff --check clean. No deployment,
commit, push, billable resource creation or credentials change. Continue hosted
Cloudflare-to-Python transport and staging asset isolation; obtain authenticated
Render access and pricing approval before remote provisioning. Plugin-management
skill inspected but its discovery tools are unavailable; no plugin was connected.

Previous handoff:

Latest staging handoff: full Python suite342pass after Docker access recovered;
container flowstate-v4-staging-check:local built successfully. Added manual-only
Render foundation and staging runbook; no live deployment or provider/key changes.
Next resume hosted adapter/storage integration and Compose defects documented in
docs/eval-v4/STAGING_SETUP.md. Obtain Render workspace access and paid-resource
approval before provisioning. Blueprint is a foundation, not a working hosted
app; current app remains on its development-only bridge. Owner app checks open.

Previous handoff:

Latest remediation handoff: local fixes pass tests/typechecks/lint; clean npm ci,
hash-locked Python install,196 Python tests, Next/OpenNext production builds and
API production dry-run pass. npm audit0. Browser legacy Northlake manual->reset->
reload->edit->reset passes, finalrevision4 valuationnull. API nowuses separate
wrangler.local.toml, session9996; signing dotenvmigrationfixed withouttokenrotation.
Read docs/eval-v4/REMEDIATION_STATUS_2026-09-09.md for remaining gates. Await staging
hosting/PostgreSQL/storage choice and DockerWSL access before rollout/DBtests.
Main unchanged; no commit/push/PR/deploy, no liveassetdeletion, ownerapprovalopen.

Previous handoff:
Latest handoff: read docs/eval-v4/PR_READINESS_REVIEW_2026-09-09.md first. Review
complete with request-changes verdict. No PR exists and most tested integration
changes are not committed/pushed. Do not merge/deploy. Owner can authorize a
remediation pass starting with isolated deployment configuration and stale-null
reset. Database tests need working Docker WSL integration; no productionDB used.
Next production-mode build passed in /tmp/flowstate-pr-review.vWQRwh, live runtime
untouched. Main remains16f879a. No owner approval boxes closed.

Previous handoff:
Latest handoff: permit display and decimal cleanup ready for owner review at
http://localhost:3004/dashboard/reports/job_1788967256552_z1q9ikuo.
Nine actual Magnolia permit records render, including repeated permit numbers
returned by the provider; these are records, not a claim of nine unique projects.
Old reports without saved permit details show NA with a new-evaluation explanation.
No automatic permit-to-system-age inference added. All approval boxes stay open.
Older-sale/radius expansion remains separate, awaiting the requested sale-age cap.
Antislop requirement was removed by owner. Do not ask about it again.

Previous handoff:
2026-09-09 latest: V2 implementation and five-address local QA completed; see
.opencode/V4_PROVIDER_AUTHORITY_QA.md. Owner then requested older sales plus
1-mile/1.5-mile fallbacks at zero eligible comps. Await maximum sale-age choice
(24 or 36 months), then implement a new versioned policy, expanded provider
retrieval and explicit stage trace, retaining all physical gates and old snapshots.
Retest Northlake first. All owner approval checkboxes remain open. Local runtime
PythonPID186411/session66386, API8787, dashboard3004; main unchanged, no deployment.

Previous milestone:
2026-09-09 current milestone: provider-authoritative V2 policy is implemented.
Heritage and Piedmont final dual-pool reports passed. Browser QA is now retrying
Magnolia after the compact evidence-reference repair, then Northlake and Sparling.
Runtime is frozen during these evaluations: API8787 session46536, Python8788
PID186411/session66386, dashboard3004. Record final report IDs and results in
.opencode/V4_PROVIDER_AUTHORITY_QA.md before owner handoff. Keep all MD approval
boxes open. Main remains 16f879adcd6b93a7daad815ea6efdde56c874b91; no commit,
push, deployment or credential rotation. Historical handoffs below are superseded.

Previous handoff:
2026-09-08 upper-half experiment handoff: review local reports
http://localhost:3004/dashboard/reports/job_1788912849879_0m36c2vk and
http://localhost:3004/dashboard/reports/job_1788913320994_25fyexz6.
Resume Heritage only after owner decides historicalfallback (proposed12months
when fewerthan3 physically qualified recent sales). Do not widen size/subdivision
to force output. Lot remains observed, not gated/weighted; explicit tolerance
still needed. As-is investor valuation remains separate/incomplete; lower-half
classification alone is not verified condition. Visualfront/garage evidence
remains unknown on finalMagnolia. Userappapproval, providerretrievalexpansion,
permit-system ages and hazards stillpending. LocalAPI session30015 port8787,
Python session75457 PID99395 port8788, dashboard3004 left running. No commit/push
or main/production changes. Antislop applied during comments/copy; officialOpenAI
vision docs informed image integration. Reported values are experimental.

2026-09-08 Tam Dr walkthrough complete. Open
http://localhost:3004/dashboard/reports/job_1788907741939_wmjwg7f8.
Next resolve the pending ARV/as-is cohort policy, missing style evidence and
anomalous transaction validation; retain all owner-approval gates. This run
verified execution and arithmetic, not valuation accuracy or production readiness.

2026-09-08 latest: N09 readable diagnostics and N10 manual ARV selection ready
for owner test at http://localhost:3004/dashboard/reports/job_1788906780962_obnjsk2b.
Report has2 manually selected comps andrevision4 from verified test. All tasks
remain unchecked pending owner approval. Existing user reports without signed
snapshot need New Analysis before manual toggles. Leave local services running;
Python bridge session9087 PID81105, API8787, dashboard3004. No commit/push/main
change or production rollout. Resume remaining N01..N08 policy/evidence work only
after resolving pending product decisions; do not call weighted averaging done.

Previous handoff:
2026-09-08 latest handoff: resumed and finished bounded rounding/provider fixes.
Owner should test http://localhost:3004/dashboard/reports/job_1788905670125_a2ufpf92
and approve V4-N06 explicitly. N07/N08 are partial, not ready for closure.
Next implement verified permit scope/completion-to-system evidence; resolve
documented flood/hazard API access for subject and comps. N01..N05 candidate
policy question was sent (24month same-subdivision search; joint physical gates;
top3 sales plus ties weighted by match score), but no owner response received.
Do not silently apply those proposed choices. Keep all checklist items pending
until owner app approval. No commits, pushes, deployments or key changes.
Runtime API/dashboard remain running; Python bridge session78723 PID72483 on8788.
Artifacts .data/local-candidate/rounding-verification.json,rounding-report.pdf,
rounding-report-desktop.png,rounding-report-mobile.png; ignored local-only.

Previous verified baseline before this clarification:
Open http://localhost:3004/dashboard/reports/job_1788851117174_z9l6g75e for the
current saved Python report, or run New Analysis. Prior strict-style zero-result
and two-comp reports are historical. Current policy selects one Ranch reference
because subdivision/year/sqft/lot precede style; mismatch remains visible.
Separate inferred as-is result reports insufficient data rather than a value.
Next: owner tests more addresses; PDF download/mobile visual checks remain.
Leave three processes running. Start API: npm run dev -w @flowstate-api/api --
--ip 127.0.0.1 --port 8787 --local. Dashboard:
npm run dev -w @flowstate-api/dashboard -- --hostname 127.0.0.1 --port 3004.
Python: node scripts/local-candidate.mjs python
/home/lucke/src/flowstate-acquisition-integration/.venv/bin/python.
Local login/artifacts: ignored .data/local-candidate; scripts in
/tmp/flowstate-v5-browser.xRhny7. Tests and runtime changes remain uncommitted;
tsconfig.tsbuildinfo is a generated typecheck artifact, not an intended source edit.
Main unchanged, no push/deployment. Maps/Firecrawl credentials deferred by user.

## Localhost verification 2026-09-10 (agent session, not owner approval)

- API (wrangler dev --local, :8787): /health 200, /health/db 200 (local D1),
  /health/keys 200 configured:true. CoreLogic live token check: HTTP 200,
  access token issued (1 auth-only call, no data retrieval).
- Dashboard (next dev --webpack -p 3004, :3004): homepage HTTP 200 (~26KB).
  Turbopack mode fails in sandboxed shells (cannot spawn worker processes);
  use --webpack there. Normal terminals can use plain `next dev`.
- Login: `node scripts/local-candidate.mjs account` passed (signup/login/
  session) for email in ignored0600 .data/local-candidate/login.json.
- Sandbox caveats (agent shell only): os.networkInterfaces() blocked (used a
  /tmp loopback shim for wrangler), no docker access (compose.dev.yaml not
  runnable here), each shell call is its own net namespace (servers must be
  started and probed within one process lifetime).
- Remaining gap: Python V4 bridge (:8788, EVALUATION_ENGINE=python-v4) has no
  venv here (system python lacks uvicorn; requirements.txt is 972 lines), so
  end-to-end analysis runs still need `enable-python` + a provisioned venv.
  API auth/health and dashboard rendering do not need it.

## Localhost offline fix 2026-09-10 (agent session, not owner approval)

- Root cause of user's "localhost offline": dashboard used next/font/google
  (Inter + Source Serif 4), which fatally fetches fonts.googleapis.com at
  startup; user's terminal had no external DNS (EAI_AGAIN). A stale
  .next/dev/lock from a dead dev server also blocked restarts on :3004.
- Fix (uncommitted): vendored 3 variable woff2 files
  (apps/dashboard/src/app/fonts/) and switched layout.tsx to next/font/local
  with identical --font-inter/--font-serif variables. No visual change.
- Verified in egress-blocked sandbox with fresh log: homepage HTTP 200
  (~27KB), zero fonts.googleapis.com fetches, dashboard typecheck clean.
  Removed the stale .next/dev/lock afterward.

## Eval-engine milestone 2026-09-10 (agent session)

Commits on feat/devin-theme: b11966a (engine port), 4639eab (photo fallback +
Redfin-first + secret sync + recommendation fields), NA-condition change,
nearest-comps fallback, foundation map + subject.permits + curb appeal.

- Appraisal: any passing comp now drives ARV (1-comp floor); INSUFFICIENT_COMPS
  only when zero comps inside the sale-age window — otherwise relaxes to the
  most recent sales (fallback 'nearest_comps', confidence low, audit preserved).
- Known data issue: pre-merge appraisal preset stores sqft_diff=20 under old
  percent semantics — engine reads it as absolute sqft. Fix = update preset in
  Evaluation Settings (sqft_diff 250, distance 1.0) or add a semantics shim.
- subject.permits {status,items[]} populated; dashboard PropertyPermits is now
  a compact collapsible strip. Foundation code map covers the full CoreLogic
  codeset (CNF → Continuous Footing). Comp curb-appeal vision runs on
  ARV-selected comps only (renovated/dated/distressed/unknown).
- Photo chain: Redfin discovery is upstream-blocked at every layer (CloudFront
  403, slug 404s, search-scrape empty). Zillow regex fallback rescues the run
  when Firecrawl JSON + LLM extraction both fail — verified live (6 photos).
- Local: API :8787 (wrangler, detached), dashboard :3004 (next --webpack,
  detached). Login admin@flowstate.homes/admin123 in api.flowstate local DB;
  v5 DB has its own accounts. Dashboard↔API secrets synced.
- Verified live on 1141 Engman St: ARV $344,403 via nearest_comps, 12 permits,
  curb appeal renovated@90/85% on selected comps, foundation labeled.

## Google Maps key + card ratio fix 2026-09-10

- The key in apps/dashboard/.env.local was billing-disabled (Street View +
  Maps JS both REQUEST_DENIED) — that is why property cards showed no photos
  when Zillow had none. Replaced with the working key family found in
  flowstate-api-production/.env.local (verified: Street View returns a real
  JPEG, Maps JS bootstrap loads). .dev.vars has no GOOGLE key.
- Subject card stats grid now 3-col (ratio closer to comp cards).
- Note: dashboard restart required to pick up NEXT_PUBLIC_ env changes — done.
