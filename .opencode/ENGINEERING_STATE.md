# Engineering State — flowstate-v5


### 2026-09-16 — CDARV deployed to staging, full e2e verified

Merge/deploy (staging-only per user; main NOT pushed — deploy.yml would
ship 89bef4a's retrieval changes to prod):
- Local main = origin/main + merge (3411afa) + CDARV commits through
  4acd531; pushed to origin/feat/cdarv-ml-foundation only.
- Merge conflict resolved in analysis-job.ts: kept absolute sqftDiff,
  ported origin/main's sub-1000sf bypass into provider request +
  isProvablyDeadComp. tsc clean.

Staging resources (Render, blueprint render.staging.yaml):
- Postgres `flowstate-cdarv-staging-postgres` dpg-dalclj2jnfac73944de0-a
  (virginia, 0.1c-256mb) — alembic upgrade head ran in pre-deploy.
- Web `flowstate-cdarv-staging` srv-dalclsijnfac73945ck0 →
  https://flowstate-cdarv-staging.onrender.com — LIVE on 4acd531.
- Worker `flowstate-cdarv-staging-worker` srv-dalcm365vjqs73etp6rg —
  LIVE on 4acd531. Model artifacts = blobs in Postgres, survive
  redeploys (verified: post-redeploy score worked).
- Secrets: CDARV_INTERNAL_API_TOKEN (hex, /tmp/cdarv-staging-token.txt
  0600) on web + wrangler secret on staging API; worker has
  CDARV_TS_API_URL=api.staging + CDARV_TS_INTERNAL_SECRET=same token.
- Staging API: CDARV_API_URL var in wrangler.staging.toml (committed
  9d779ca); deployed versions 139ba2ba (current).
- Staging dashboard: OpenNext deploy afdf2f5d with
  NEXT_PUBLIC_API_URL=https://api.staging.flowstate.homes inlined.

Staging e2e (session cookie via staging@flowstate.test):
- 5 submissions through /cdarv/submissions → 5 snapshots (1 real
  cotality report MISTY GLN + 4 synthetic fixtures inserted into
  staging D1 saved_reports, ids in /tmp/cdarv-synth/).
- Real report: 17 comps rendered, 5 labels, 1 preference, 1 external
  comp, decided needs_more_evidence — deliberately NOT approved
  (license constraint; build_dataset sweeps all approvals).
- 4 synthetic: labeled + approved → dataset staging-synthetic-v1
  (462ce816, 4 members) → train job → worker trained model
  staging-baseline 1e0bc9d8 (candidate) → explicit shadow activate →
  score → worker recalc callback → real recalculateReport →
  shadow_arv 343001 stored as prediction; real report correctly
  abstained insufficient_evidence.
- saved_reports rows byte-identical (arv unchanged) after scoring.
- Monitoring summary live: counts + shadow_agreement (jaccard 0.375,
  reviewer overlap 1.0, outcome_accuracy "insufficient outcome data").
- Dashboard SSR verified on staging.flowstate.homes: queue, models
  (staging-baseline + shadow state), performance (agreement card).
- Failure isolation: invalid/missing token 401s; bogus model 400;
  bogus dataset 404; unauth 401; dead CDARV_API_URL → bounded 530/503
  passthrough (0.35s) while API health+reports stayed 200; worker
  redeploy gap → job queued then processed (recovery observed).
- Prod isolation: api.flowstate.homes /cdarv/* → 404 (routes not
  deployed to prod at all); prod /health 200; zero prod changes.

Fixes shipped this phase: 25f4c10 (excluded-snapshot dataset leak via
stale v1 approval — new regression test), 4acd531 (worker recalc
callback UA — Cloudflare 1010 banned python-urllib signature).

Blockers: Render API returning bare 400s late in session (rate-limit
or WAF) — could not suspend worker for explicit worker-down test;
mitigated by observed queued→processed recovery across worker
redeploy. Cotality ML-training license still unconfirmed — real-data
reviews held at needs_more_evidence. Production hosting decision for
CDARV Postgres not made.

### 2026-09-16 — Retrieval hardening committed + staging verification

- Committed `89bef4a` on feat/cdarv-ml-foundation: candidate-pool
  retrieval hardening only (20 files; tsbuildinfo + devin/ excluded).
- Staging deploys: API `c9534568` (wrangler.staging.toml), dashboard
  `857ae3de` (OpenNext, NEXT_PUBLIC_API_URL=api.staging inlined; env var
  correctly beat .env.local at build).
- Staging D1 was 10 migrations behind (0020-0029) — applied; auth had been
  failing on missing login_failures table.
- Real staging E2E: staging@flowstate.test sign-in (staging cookie
  prefix `__Secure-flowstate-v4-staging`), API key, POST /v1/analyze
  5802 Misty Gln → job_1789576471189_3s6htr11 complete. Result identical
  to local: ARV 259679, comps 3182238834+9875187195, buy 112556.
- Retrieval meta on staging: candidateLimitEffective=100 (default
  resolution, no env var needed), expansion refetch fired (2 provider
  calls, pool 2→6), 4 dead pruned / 2 enriched, meta persisted to report.
- Staging save→load→recalc identical (rev 0→1, history row).
- Note: explicit caller maxComps overrides env (resolveCandidateLimit) —
  old dashboard builds sending maxComps=15/25 still cap the pool; fixed
  by the staging dashboard redeploy.

### 2026-09-16 — Integration verification pass (feat/cdarv-ml-foundation, uncommitted retrieval changes preserved)

Full runtime verification of the suspended candidate-retrieval hardening +
current architecture, on top of committed CDARV work.

Executed evidence:
- API regression: 18/18 files pass (incl. comparable-retrieval.test.ts, cdarv.test.ts).
- `tsc --noEmit` clean: apps/api AND apps/dashboard (stale .next already removed).
- eval-engine: 233 non-DB tests pass incl. 5/5 canonical-contract audit;
  6 Postgres-dependent test files BLOCKED — no Docker in this WSL distro
  (harness correctly refuses foreign PG; not a code failure).
- CDARV: 59/59 pytest pass; `/cdarv/*` proxy routes fail closed when
  CDARV_API_URL unset; production path never calls CDARV.
- Real local E2E: wrangler dev (127.0.0.1:8787) + next dev (:3000),
  better-auth sign-in as local@flowstate.test, API key via /user/api-keys,
  POST /v1/analyze for 5802 Misty Gln → job_1789538087877_nu8qr1el
  completed via AnalysisJobDO + SSE, saved_reports + analysis_runs rows
  persisted before completion.
- Retrieval hardening live: request URL shows maxComps=100 (default =
  provider max; no env override needed); retrieval meta in comps_found SSE
  + saved report (received=6, truncated=false, pages=2, calls=2).
- Expansion refetch fired for real: log "Expansion refetch: widening
  comparable search to 1mi", pool 2→6 merged, 0 extra enrichment.
- Enrichment pruning live: 6 received → 4 provably-dead pruned → 2 enriched.
- Settings→engine: PUT /deal-params closingCostsPercent 8→10 → next eval
  consumed it (closing 20774→25968, buy 112556→107362, ARV unchanged) →
  restored via DELETE. No redeploy needed.
- Deterministic recalc: POST /user/reports/:jobId/comps
  {selectedCompIds:null} → identical ARV/comps/valuation, revision 0→1,
  report_history row written.
- Dashboard auth paths: session cookie AND X-Dashboard-User-Id/Secret
  both verified live; /v1/analyze/defaults returns maxComps=100.

Blockers (environment, not code):
- No Docker → V4 persistence/API/worker test files can't run.
- No usable browser (missing libnspr4; no playwright pkg) → interactive
  dashboard checklist (login UI, submit, report render, recalc UI) not
  browser-verified. Dashboard serves + typechecks; data path proven via API.
- canonical_v1 policy NOT implemented in eval-engine (approved contract,
  queued work).
- Dashboard lib/recalc client-side path still diverges from server
  recalculateReport (known; methodology consolidation needs owner decision).
- V4 engine NOT connected to production (V4_* env vars dead code; by plan).

## Current Objective
Post-merge repo health audit on `main` (worktree `~/src/flowstate-v5-deploy`,
main = 17bcf51 = Candidate B production). Dead code + redundancy sweep,
high-volume readiness, evaluation speed/accuracy review. Findings below in
"### 2026-09-20 (d) — Post-merge repo audit". Removals NOT yet applied —
awaiting product-engineer pick-list.

NOTE: `git push origin main` NOT done — pushing main triggers deploy.yml
(prod deploy). Awaiting explicit user authorization to push.

### 2026-09-19 — Jev-authoritative comp selection + per-comp truth scores

User directive: "made JEV in charge of total comp selection … ask JEV out
of all the address which are closest to our source and truth … numerical
value of truth for each comparable in the property card."

Implemented:
- `services/jev/index.ts`: new `scoreCompTruthWithJev(subject, comps,
  rules, env)` — one Noul question per candidate ("is this comp a
  reliable source of truth for the subject's market value"), Jev sees
  the whole candidate pool per batch (byte-budgeted: 28KB state+question,
  56KB request, same budgets as the archived comp-selection work). Comp
  evidence = normalized fields + appraisal `ruleEvidence` (failedFilters,
  passed/total counts, adjustments, original/adjusted price) — labeled
  explicitly as evidence, not verdicts. Rejects: missing key, dup/empty
  ids, HTTP errors, missing/extra answers, non-noul types, model drift
  between batches.
- `services/evaluation/index.ts`: after the final appraisal evaluation
  (post Zillow-merge + flood), Jev scores every candidate; top-N by
  truth become `isEnabled`/`selectedCompIds`/`arvStatus='selected'`;
  ARV recomputed via `appraisalService.calculateARV` on Jev's set.
  `jevTruth` attached to each appraised comp. Failure → rules selection
  stands + `jev_selection` step `fallback`. Downstream (photo
  prioritization, condition gate/prune, Group A/B, best match,
  valuation) consumes Jev's set unchanged.
- `appraisal/types.ts`: `AppraisedComparable.jevTruth?: number | null`;
  `services/analysis/index.ts`: response item `jevTruth` + mapping.
- Dashboard: `CompItem.jevTruth` + tone-coded % badge on `CompGridCard`
  (photo overlay, next to index) and `CompCard` (header row), tooltip
  explains the score meaning.

Verified: `npx tsc --noEmit` clean (api + dashboard); `npm test` api =
20/20 regression files pass incl. extended `jev-outcome.test.ts` (truth
keying, per-comp noul questions, evidence projection without score
leak, missing-answer rejection, dup-id rejection, no-key path).

Semantics (document for product engineer): "truth" = Jev's Noul
probability the comp is reliable evidence of the subject's market
value — evidence-supported, not verified ground truth. Jev CAN select a
comp that failed an appraisal filter (rules are evidence in its state);
post-vision condition gating still prunes verified-bad comps from ARV.
User ARV-toggle overrides remain intact.

Live E2E verified (job_1789781023487_oe11zm8y, 2447 Crestview Ave):
all 67 candidates scored (truth 0.14–0.56); Jev selected top-3
(2384 McAfee Rd 0.56, 2355 Hillside Ave 0.52, 1990 McAfee Pl 0.52) →
group=arv, ARV 271167. Step: "Jev selected 3/67 comps by truth
(jev-1.13.0)". Note: selection count floors at the ARV standard of 3 —
Jev decides WHICH comps, not how many.

### 2026-09-19 — Dual truth: ARV vs investment comp buckets

User concern: "separating ARV priced and condition comps from
Investment priced and condition comps." Product decisions (user):
Jev picks the investment set (replaces ≤70%-of-ARV price threshold);
every card shows both scores.

Implemented:
- `scoreCompTruthWithJev` now asks TWO nouls per candidate:
  `comp_i_arv_truth` (after-renovation retail value evidence) and
  `comp_i_investment_truth` (as-is investor value evidence). Returns
  `scores[id] = {arvTruth, investmentTruth}`; batch offset tracked on
  TruthBatch for correct answer mapping.
- Pipeline: top-3 arvTruth → ARV set; top-3 investmentTruth among the
  rest → Group B (`summarizeGroupB` extracted, shared sqft-scaling
  math). Price-threshold Group B is the Jev-down fallback. Both sets
  marked isEnabled; bestMatch scoped to ARV set only.
- `AppraisedComparable.jevTruth` → `jevArvTruth`/`jevInvestmentTruth`
  (item type + mapping + dashboard CompItem + projectComp).
- Cards: A·/I· dual value-toned badges (CompGridCard overlay, CompCard
  header) with explanatory tooltips.

Live E2E (same job, refreshed): ARV set = 2384 McAfee (A.36/I.22),
545 Quillian (A.42/I.21), 1990 McAfee Pl (A.41/I.17); investment set =
1987 Merle Cir (I.26), 2355 Hillside (I.26), 500 Allendale (I.26) —
sets diverge correctly (2355 Hillside moved from ARV to investment
once buckets separated). ARV 301167, asIsValue 221917. Step: "Jev
selected 3 ARV + 3 investment comps from 67 candidates".

### 2026-09-19 — Bucket-by-higher-truth eval model (current spec)

User spec (d506841): the higher truth score assigns each comp's
market — A > I → ARV-eligible; I > A → investment-only, never ARV.
Appraisal rules gate each bucket (evaluation.shouldDisable must be
false). ARV = mean of adjusted prices over ALL A∩rules comps (no
top-3 cap); I∩rules comps average into the as-is AVG, shown in the
DealSummaryHero footer as insight only. Jev instructions now state
missing/null fields must NOT reduce scores. Verified live: 67
candidates → 2 ARV comps (A>I + rules-pass) → ARV = mean(225000,
285000) = 255000; 0 investment rule-matches → no as-is AVG.

Also this session: Jev outcome card chips reverted to tone-coded
colors per user; outcome projection decontaminated (see commit
930fd0b) — labels still honest-negative on this thin-evidence
property, which is Jev's real read.

Fix (post-spec): empty Jev ARV bucket no longer forces
INSUFFICIENT_COMPS — user clarified "its not jevs job to pass
insufficient comps its job is to classify." Empty A∩rules → rules
selection stands, truth scores still attach, step reports
'Jev found no ARV-eligible comps — appraisal-rules selection used'.
INSUFFICIENT_COMPS now only fires when the rules selection itself
found nothing (pre-existing behavior).

Update (83bdf83): geo-filter exemption removed — f.passed===false only
fires on evaluated failures ('not_verified' returns passed=true), so
verified subdivision/neighborhood mismatches on enriched comps gate
again while unenriched comps stay unpunished. Distance ≤0.5mi remains
the uniform location gate. Re-verified live: same property → 1 ARV comp
(545 Quillian, A 0.32/I 0.24) → ARV $269,800, no dead end; no verified
geo mismatch existed within 0.5mi, so outcome unchanged.

Update (d1c01e4): three fixes after user reported single-comp selection
on a subject whose nearest comps were being skipped. (1) Removed the
sub-1,000sf cap in evaluateSqftDiff (API evaluator + shared package) —
it silently replaced the configured ±250 band; configured filter value
now governs. (2) Jev gate uses shouldDisable (hard failures) instead of
passed===false — soft failures (construction_material_match) no longer
disqualify. (3) Distance priority: Jev scores candidates closest-first;
response orders enabled comps by distance (was subdivision-first).
Verified live (job_1789784553571, subject 864sf/1946): 3 enabled —
2426 Hillside d=0.06 investment (1052sf, now passes ±250), 2384 McAfee
d=0.34 ARV (was rejected on a soft fail), 545 Quillian d=0.47 ARV.
ARV $242,244; as-is AVG $127,300 under valuation.asIsMarketIntel
(1 investment comp, insight-only). All 20 regression tests pass.

Update (952b5df): user flagged that subdivision/neighborhood are only
enriched for rule-matched comps, so geo data is absent across most of
the pool — geo-identity filters (subdivision_match, neighborhood_match)
can no longer gate the Jev buckets. Location criterion is now
distanceMiles <= 0.5 (hard gate); other evaluated rule failures still
disqualify (missing data is already 'not_verified', non-disqualifying).
Truth questions tell Jev distanceMiles is the primary location signal
and absent geo fields are unknown, not negative. Verified live
(job_1789784553571): 67 candidates → 19 within 0.5mi → 12 A>I + 4 I>A;
the 11 A>I losers failed evaluated rules (sqft cap, year-built), not
geo — correct per spec. Result: 1 ARV comp → ARV $269,800, no dead end.
User expectation: manual report review fine-tunes location judgment.

Remaining: nothing blocking. Stack live: API :8792, dashboard :3012.

### 2026-09-19 — Stale-price reconciliation + flip classification (verified)

User spec: reconcile stale provider sale prices against Zillow for ALL
appraisal-rule-matching comps regardless of provider sale-date age;
editable `reconciliationSaleAgeDays` setting (default 365, supports 18
months+); deterministic flip = profitable resale 30-365 days after prior
sale; flip/reconciliation evidence flows to Jev; minimal code.

Shipped (3ba88f8, 78c12f1, 92b233b):
- `deal_params.reconciliation_sale_age_days` column (migration 0031) +
  deal-params route, user-settings resolution, analyze/batch plumbing,
  dashboard evaluation-settings editable field.
- Photo-fetch group = every rule-matching comp nearest-first
  (`shouldDisable` excluded), not the top-6 selected.
- `mergeZillowDataIntoProperty`: newest Zillow 'sold' event strictly
  newer than provider saleDate (and within maxSaleAgeDays) replaces
  price+date; prior values kept in `saleReconciled`. Two sold events
  30-365d apart with a gain → `flip {priorSalePrice, priorSaleDate,
  daysHeld, gainPct}`. Both fields on NormalizedComparable → response
  item + dashboard CompItem + card badges.
- Jev: `saleReconciled`/`flip` in compTruthFields; both truth questions
  explain semantics (flip resale = strong ARV evidence; priorSale = what
  an investor paid as-is).

Root causes fixed in 92b233b (the feature was silently dead):
- Firecrawl v2 JSON extraction returns data.json=null on ~3MB Zillow
  pages — "input exceeds the context window of this model" warning.
  OpenRouter fallback 404s (google/gemini-2.0-flash-001 has no
  endpoints — stale model name in .dev.vars OPENROUTER_MODEL, still
  unfixed, affects all LLM-fallback paths). Net: every extraction
  degraded to regex parsing.
- Fix: parseZillowHtml now parses the price-history table rows
  (label="Date: M/D/YYYY, Event: X, Price: $N") — deterministic, no
  LLM needed. parseJsonExtraction also fills priceHistory from HTML
  when the schema extraction omits it. Cache prefix → zillow-fc-v3.
- Comp chain bounds each provider attempt at 15s
  (COMP_ATTEMPT_TIMEOUT_MS); a stealth-proxy Zillow scrape takes
  40-90s, so Zillow loses every race and Redfin (no priceHistory) wins
  — while the timed-out Zillow fetch still completes in background and
  writes its KV entry. Fix: after fetchPhotoBundle, re-read Zillow for
  rule-matching comps lacking priceHistory (cache hit ≈ instant for
  the background-completed scrapes; real scrape only for true misses).

Verified live (job_1789793008122_aqrs8bmg, 8120 Golden Bear Loop):
- 7834 SEASONS LN: flip {priorSalePrice: 200000 @2025-12-02, daysHeld:
  189, gainPct: 62.5} + saleReconciled (date 06-06→06-09); enabled in
  ARV bucket, highest arvTruth 0.68 — Jev weighed the flip evidence.
- 8415 BRIARLEAF CT: date reconciled 06-24→06-25.
- 8741 ELM LEAF CT: price corrected 290000@03-23 → 250000@09-08
  (provider showed older, higher sale) — eligibility changed correctly.
- ARV $298,333 (3 enabled ARV comps). 20/20 regression files pass;
  tsc clean api+dashboard.

Known gaps / next: manual comp-card ARV override (option B) not built —
deferred as last-mile tool. OpenRouter model name in .dev.vars is stale
(404s) — local config fix, prod secret needs same update.

Follow-ups shipped (92eacbe, ded3864):
- As-is AVG promoted to a headline stat left of ARV in the valuation
  hero (5-col grid; was a footer chip). Shows $/sf subline or "—" +
  sales count; tooltip marks it insight-only.
- Verified flip acquisitions now fold into the as-is AVG: a flip's
  priorSale is what an investor paid as-is, so summarizeGroupB scans
  the full evaluated pool for comp.flip and adds priorSalePrice as an
  extra sqft-scaled data point (flip comps often sit in the ARV bucket
  on their resale — scan is not limited to as-is picks; lone-flip case
  still produces an AVG). flipSaleCount flows GroupBResult → response
  → dashboard tooltip/subline.
- Verified live (job_1789801587065_jt98aywt): SEASONS $200k acq →
  as-is AVG $202,667 (166.67/sf × 1216sf subject) where it was null.

Also verified: 228 Cobblestone thin-comp question answered — rules gate
(year_built ±12 after expansion + sale_age 180d) correctly eliminates
15/17 nearby comps on a 2007 subject amid 1973-93 stock; not a bug.
Levers discussed: wider tolerances, soft-priority filters, asymmetric
year rule, location overrides — none requested yet.

### 2026-09-19 — Configurable sale-age fallback tiers (a135400)

User directive: on INSUFFICIENT_COMPS, retry at 365d then 18 months —
"as customizable like the rest of the settings in the appraisal rules
filter rules section" and picked up on initial + fallback scenarios.
(An earlier asIsSaleAgeDays deal-param + as-is-only gate was built,
verified live, then reverted by user request — this replaces it with a
preset-level mechanism.)

Model: each fallback tier is a FILTER ROW — `sale_age_expansion` (365d)
and `sale_age_expansion_2` (548d) added to FilterType, DEFAULT_FILTERS
(enabled, priority soft), FILTER_LABELS. They render as rows in
AppraisalFilterEditor like every other rule, persist per-preset via the
existing filter table, and get default-injected for presets lacking
them. They have NO per-comp evaluator (FILTER_EVALUATORS is now
Partial) so they never disqualify a comp — they only parameterize the
last-resort ladder via `saleAgeExpansionSteps(filters, baseDays)`.

Engine:
- `evaluateWithFallback`: after the full existing ladder ends
  insufficient, retries the ENTIRE ladder with only the sale_age
  ceiling widened to each configured step ascending (recursion walks
  180→365→548). `fallbackUsed: 'sale_age_expansion'`,
  `expansionApplied: 'sale_age'`. ExpansionPolicy keeps only
  `allowSaleAgeExpansion` (master flag); steps come from the rows.
- Same `filters` drive all three call sites (initial eval, post-refetch
  re-eval, post-photo re-eval) — configured values picked up everywhere.
- performAnalysis: the ONE expansion refetch now also widens monthsBack
  to cover the deepest configured tier (ceil(days/30.44) — fetched
  6–12mo window provably lacks 18mo sales, same doctrine as radius).
  `expandComparablesPool(radius, monthsBack?)` seam; analysis-job
  passes monthsBack to getComparables and updates retrieval meta.
- Dead-comp enrichment prune: saleAgeDays now uses the DEEPEST
  configured tier (was strict sale_age on the now-false doctrine that
  sale_age is never relaxed) — comps a fallback tier could admit are
  no longer starved of enrichment. DO also merges missing
  DEFAULT_FILTERS into the preset list for parity with performAnalysis.
- Shared package + batch-job + GHL webhook untouched: shared evaluator
  passes unknown types; batch/GHL run the ladder on the existing pool
  (no refetch seam — same limitation as radius expansion today).

Verified: tsc clean api+dashboard; 20/20 regression files pass; live
38036 Central Ave Zephyrhills — ladder walked 180→365→548, ONE refetch
combined radius 1→2mi + monthsBack→18 (KV key confirmed), provider
returned the only comp in that market (609 W County Line Rd) → honest
INSUFFICIENT_COMPS (1 < 3 required). comp_count records pre-refetch
pool. Earlier hardcoded [365,548] version also verified the ladder
walk via error-message drift 180→548.

Open: ARV `sale_age` row remains the primary window — ladder tiers are
last-resort only. Disabling both rows = feature off.

### 2026-09-19 — Vintage-subject year cap (pre-1970 fallback)

User rule: "If the property is pre 1970 and there are no comps that
match year built (e.g. subject 1949, nothing within ±10yr), you can use
comps up to 1970 year built — only for pre-1970 properties when no
year-built comps are found."

Model: same pattern as the sale-age tiers — TWO new FilterTypes:
- `vintage_year_cap` (config row in DEFAULT_FILTERS, enabled, 1970,
  soft; NO evaluator → never a per-comp rule). Editable in the filter
  rules section like everything else; disable = feature off.
- `year_built_cap` (real evaluator: comp.yearBuilt <= value, one-sided;
  NOT in DEFAULT_FILTERS — injected by the ladder only at the vintage
  tier, replacing year_built_diff in the tier's filter set).

Engine (appraisal/index.ts): year steps are now `number | 'vintage'`.
When `vintageYearCap(filters, subject.yearBuilt)` returns a cap
(subject.yearBuilt < cap AND row enabled), `'vintage'` is appended to
both the strict-exit step list and the full year ladder — so the cap is
tried inside every geography scope (subdivision → neighborhood →
×radius → no-radius) after the numeric ± tolerances. At that step,
filtersAt swaps year_built_diff for `{type:'year_built_cap', hard,
value:cap}` — real audit-trail row ("Built after vintage cap: 1975
(cap: 1970)"). Success reports fallbackUsed='year_built_expansion',
expansionApplied=['year_built', ...scope]. Gated by
allowYearBuiltExpansion like the other year steps. Step-6 (nearest)
message/audit reflects the cap when vintage applies.

Prune (retrieval-policy.ts + analysis-job.ts): DeadCompThresholds
gains `vintageYearCap`; isProvablyDeadComp uses a ONE-SIDED check
(comp.yearBuilt <= cap) when the subject predates the cap — a 1920 comp
for a 1949 subject is no longer starved of enrichment. Post-cap
subjects keep the symmetric ±maxYearDiff bound.

Verified: tsc clean api+dashboard; 20/20 regression files pass with new
proofs (1949 subject: 1964/1968/1920 comps admitted via cap, 1975 comp
disqualified + audited; 1975 subject never reaches the tier; disabled
row disables it; one-sided pruning). Live: 275 Temple St Mulberry (1920)
— INSUFFICIENT_COMPS, market pool only has 2 comps (can't manufacture
comps that don't exist); 1420 Bolton Rd NW Atlanta (1945) — pool
resolved as RESIDENTIAL LOT, insufficient by type; 2447 Crestview Ave
Decatur (1946) — completed, fallbackUsed:'none' (strict pool filled,
vintage never needed — correct).

### 2026-09-19 — Jev outcome API durability (primitive-agnostic contract)

Requirement: the service is primarily an API tool — a property submitted
via `POST /v1/analyze` returns an evaluation through the same connection
(SSE `evaluation_complete` event + saved report + DO `/state`), and the
report must always carry the five Jev dimensions (evidence_sufficiency,
comp_set_quality, deal_outlook, recommendation_agreement, risk_flags)
EVEN IF the underlying TypeSafe question primitive changes (choice →
score → noul → future types).

Prior fragility: `parseResponse` validated every answer against the
registered question's type and threw the WHOLE outcome away if any
answer deviated — retyping one question nuked all five dimensions to
`{status:'unavailable'}`.

Change (apps/api/src/services/jev/index.ts):
- `JevAnswer` passthrough type: `{type:string, choice?, score?, noul?,
  confidence?, probabilities?, ...}` — verbatim record, any primitive.
- `ScoreQuestion` added to the internal `Question` union.
- `parseResponse` now iterates the answers Jev RETURNED (not the
  questions registered); malformed single entries are skipped, never
  fatal. Only an empty/invalid top-level payload still throws.
- `classifications` is now `Partial<Record<JevOutcomeDimension,
  JevAnswer>>` — the stable per-dimension contract: a dimension answered
  under ANY primitive lands under its canonical name.
- New `answers: Record<string, JevAnswer>` on completed outcomes —
  every raw answer keyed by question id, surviving added/renamed/retyped
  questions. `drivers` unchanged (noul driver extraction best-effort).

Dashboard: `JevOutcomeSignal` widened to the passthrough shape;
`JevOutcomeCard` renders `.choice` labels, falls back to `.score`/`.noul`
scalars so a retyped dimension still displays; confidence tooltip now
optional-guarded.

Flow-through verified: `evaluation_complete` SSE event, savedReports
`fullResponseJson`, eval-result cache hit, and DO `/state` all carry the
full AnalysisResponse → `jevOutcome` reaches API consumers unchanged.

Verified: tsc clean api+dashboard; 20/20 regression files pass. New
proofs in jev-outcome.test.ts: score-retyped dimension stays in
`classifications` under its stable name AND in `answers`; unanswered
dimension is absent (not fatal); unknown future answer types pass
through `answers`; driver nouls still extract.

### 2026-09-19 — API polling endpoint + burst-throttle hardening

User is about to send properties via the API in bursts up to ~100
concurrent. Two changes:

1. `GET /v1/analyze/jobs/:jobId` (analyze.ts) — the documented-but-
   missing polling endpoint. Reads the AnalysisJobDO `/state`; ownership
   check (`state.userId === auth.userId`, 404 on mismatch). Returns:
   - processing → {status:'processing', pending, lastEvent, elapsedMs}
   - complete → {status:'complete', result} — latest `updatedResult`
     event wins (llm_complete carries the post-annotation copy); falls
     back to savedReports.fullResponseJson when the DO state is gone.
   - errored → {status:'error', error}
   Serves both Bearer keys and dashboard internal auth (same router).

2. `acquireCotalitySlot` (corelogic.ts) — burst hardening. The global
   Cotality window is 50 req/min with a 5-min backlog cap (~250 slots);
   granted=false previously threw immediately, killing the whole job on
   critical-path calls (search/comparables). Now retries with 15–30s
   jitter for up to ACQUIRE_BUDGET_MS (20 min) — the window drains
   continuously so concurrent jobs wait their turn instead of dying.
   Enrichment per-comp calls were already failure-isolated.

Burst reality check: ~5–30 provider calls/job after dead-comp pruning →
a 100-property cold burst drains in roughly 10–60 min of provider time.
Jobs complete rather than fail; SSE clients will outlive the 5-min
stream cap under heavy bursts — polling is the right channel there.

Verified live (local :8792): processing status mid-flight (pending +
lastEvent), complete result with jevOutcome.classifications (all 5
dims) + answers (19 entries), 404 on unknown job, ownership enforced.
tsc clean; 20/20 regression files pass.

### 2026-09-18 — Reset from feat/jev-rules-evaluation
- Prior branch (Python/GIS bridge + Jev atomic signals + Python-owned
  qualification/ranking) deleted per user direction — it replaced v5
  evaluation and produced generic BAD_DEAL dead ends.
- Deleted branch tip preserved as tag `archive/jev-rules-evaluation`;
  uncommitted WIP + env files + local D1 state archived at
  `/home/lucke/backups/jev-rules-wip-20260918/`.
- Implemented `apps/api/src/services/jev/index.ts` (outcome classifier),
  wired post-`buildEvaluationReport` in `performAnalysis`. tsc clean;
  `tests/jev-outcome.test.ts` passes (skip/complete/error/malformed paths).
- Local stack: API 8792, dashboard 3012 (same ports as before; no Python
  service needed). Env + local D1 restored from archive; JEV_GEO_* vars
  removed from .dev.vars.
- Dashboard renders `jevOutcome` via `JevOutcomeCard` (five tone-coded
  chips + confidence on hover) in `AnalysisResultLayout`, plumbed through
  the evaluation atom on analyze + both report pages.
- Verified live: analysis `job_1789779869253_3qaug384` (2447 Crestview Ave)
  produced jevOutcome.completed — evidence limited (0.51), comp set weak
  (0.99), deal favorable (0.66), recommendation uncertain, risk material
  (1.0); model jev-1.13.0, 4177 input tokens, 317ms.
- Jev "reasoning" exposed via 14 Noul driver sub-checks (2–4 per headline
  dimension, same request, ~no added latency). Card shows them in an
  expandable scoring breakdown. Jev returns typed values only — no prose
  rationale exists in the SystemOne API (Choice/Score/Noul primitives).
- Note: first dev-server boot served a stale chunk importing
  @vis.gl/react-google-maps from the sibling flowstate-v5 worktree
  (createContext crash in PropertyMapInner). Fixed by wiping `.next` and
  restarting; module resolution itself is correct.

### 2026-09-16 — CDARV independent audit + live hardening pass (uncommitted fixes below)

Ran the real system end-to-end against local services + real
`saved_reports` data. Local stack used: pgserver Postgres 16.2 on
127.0.0.1:55432 (dbs cdarv_dev/cdarv_test/cdarv_clean), wrangler dev
:8787, next dev :3000, uvicorn cdarv.app :8005, worker process.
Headless Chromium via cached playwright build + locally extracted
libnspr4/libnss3/libasound debs (no system install possible).

Verified live (not just tests):
- Real PG migrations: clean db → 13 cdarv tables at head; downgrade→0;
  re-upgrade→13. Unique (report_id, content_hash) enforced — duplicate
  insert rejected. Full pytest suite green on Postgres AND sqlite: 60/60.
- Real e2e: 12 real reports submitted via POST /cdarv/submissions
  (jobIds, owner-scoped session) → 12 snapshots; resubmit idempotent;
  changed report → new immutable version. 63 labels + 1 preference +
  1 external comp + 8 comp_ranking approvals (1 gold, evidence required).
  Dataset baseline v1 frozen (8 members, feature_spec v2, code rev
  abbf3d7, grouped time-aware splits). Worker trained → model
  `baseline v1` (id ede2620e…). Explicit activate → shadow scoring via
  real /internal/cdarv/recalculate → production recalculateReport math.
  Scored ARV 246492 (comps 5779347055+3935211447); LA report correctly
  abstained `insufficient_evidence`. Production saved_reports rows
  byte-identical before/after.
- Browser-verified (Playwright): sign-in → queue → open review → set
  labels → save → approve (persisted); models page Disable shadow /
  Activate shadow round-trip; performance page renders; report detail
  flask button → "Queued for CDARV review"; unauthenticated /cdarv
  redirected to landing. Screenshots in /tmp/cdarv-shots/.
- Failure isolation: wrong token → 401 AUTH_INVALID; none → 401
  AUTH_MISSING; service down → proxy 503 cdarv_unreachable (was ~2.5min
  hang — now bounded 15s by new AbortSignal.timeout in serviceFetch);
  dashboard shows clean "service unavailable"; worker down → jobs stay
  queued, resume on restart; malformed job → HANDLER_ERROR ×3 → dead,
  worker survives; invalid model/dataset → 400/404; report page renders
  with CDARV down (no server-side CDARV dependency).
- Monitoring live: status/label/prediction counts, gold_standard count,
  market coverage, shadow_agreement (evaluator jaccard + reviewer
  overlap means), "insufficient outcome data" stated explicitly.

Fixes this pass:
- `reports.py`/`shadow.py`: NEW `CandidateComp.recalc_eligible` —
  mirrors recalculateReport's gate (passedFilters !== false AND positive
  adjustedPrice ?? salePrice). Real reports carry isEnabled=true +
  passedFilters=false (fallback tiers); shadow was ranking comps prod
  recalc rejects → 422s. Tests updated for both ineligible kinds.
- `apps/api/src/routes/cdarv.ts`: serviceFetch 15s AbortSignal.timeout.
- `monitoring.py` + performance page + cdarv-api.ts: gold_standard count
  + shadow_agreement metrics (per DESIGN §6 promise; was missing).
- tests/conftest.py: CDARV_TEST_DATABASE_URL opt-in Postgres backend.

Still scaffolded (intentional): guidance curation UI (storage+routes
only); external-comp evidence detail; outcome-accuracy monitoring
(awaiting real renovated-resale outcomes).
Blocked on product engineer: Cotality ML-training license; real secrets
(CDARV_INTERNAL_API_TOKEN, CDARV_TS_*); Postgres hosting decision;
deploy authorization. Nothing deployed; prod untouched.

### 2026-09-16 — CDARV full loop built (feat/cdarv-ml-foundation, NOT merged/deployed)

Stage 2–4 implemented on top of the c4fc09c foundation (v1 scaffold fully
replaced by the domain/persistence architecture):

- **Persistence** (`services/ml/src/cdarv/persistence/`): `cdarv_*`
  tables — snapshots (unique report_id+content_hash, versioned),
  reviews (immutable versions), comp_labels (strong_arv/
  usable_with_adjustment/unsuitable/not_reviewed + structured reasons),
  preferences, external_comps, approvals (comp_ranking /
  valuation_benchmark scopes, gold_standard w/ evidence), datasets +
  members (pinned versions, splits, feature/code versions, geo overlap),
  jobs (lease/claim), models (immutable, artifact_blob), shadow_state
  (singleton), predictions, guidance.
- **Domain** (`domain/`): submissions, reviews, labels, features v2
  (rule echoes + subject.avm + valuation outputs EXCLUDED; NaN+_known
  for unknowns), datasets (approved-only, report-grouped time-aware
  splits), training (sklearn CPU baseline), shadow (eligible-only
  ranking → top-k → production recalculateReport via internal callback),
  monitoring, registry (explicit activate/deactivate/rollback).
- **Service**: `cdarv/app.py` FastAPI, bearer-token (`CDARV_INTERNAL_API_TOKEN`,
  constant-time hash compare), all routes under /v1. `app.routes` shows
  a `_IncludedRouter` entry — normal for FastAPI 0.141; requests route
  fine (verified via TestClient).
- **Worker**: `python -m cdarv.worker.main` — lease/claim over
  cdarv_jobs; sleeps poll_seconds when idle (busy-loop fixed).
- **apps/api**: `routes/cdarv.ts` — `POST /cdarv/submissions`
  (reportIds OR jobIds, owner-scoped against saved_reports),
  `/cdarv/proxy/*` session→bearer passthrough,
  `POST /internal/cdarv/recalculate` (X-CDARV-Internal-Secret or Bearer
  == CDARV_INTERNAL_API_TOKEN → runs real recalculateReport). Fails
  closed 503 when CDARV_API_URL unset.
- **Dashboard**: `/dashboard/cdarv` (queue, snapshot review form,
  models/registry w/ activate-deactivate, performance), Send-to-CDARV
  button on report detail, sidebar entry "CDARV (Experimental)".
- **Deploy artifacts (staged, not deployed)**: services/ml/Dockerfile
  (hashed --require-hashes install, port 8005), bootstrap-requirements.txt,
  render.staging.yaml entries (web + worker + dedicated
  flowstate-cdarv-staging-postgres), hashed requirements.txt via
  pip-compile. Alembic chain `services/ml/alembic` (0001 generates DDL
  from ORM metadata — cannot drift; PG-only env guard).
- **CLI**: init-db / submit --d1 / queue / build-dataset / train /
  worker --once / shadow activate|deactivate|score|state / status.
  `python -m cdarv` entrypoint fixed (was missing __main__ block).

Verified:
- 59/59 pytest (synthetic fixtures only; idempotent submit, approval
  gating, not_reviewed-not-negative, grouped time-aware splits, AVM/rule
  exclusion, worker train+shadow e2e on sqlite).
- Live TestClient e2e: submit 201 created → resubmit 201 duplicate →
  changed payload → new_version v2; queue/models/shadow-state all 200;
  no-auth → 401.
- 18/18 api regression files incl. NEW tests/cdarv.test.ts (session 401s,
  token 401/400/404 on internal recalc).
- `npx tsc --noEmit` clean: apps/api AND apps/dashboard (fixed
  review-form import path; stale .next/types atlas error removed by
  deleting .next/types — pre-existing artifact, unrelated).

Not verified: Alembic against real Postgres (Docker unavailable —
create_all verified on sqlite only); real saved_reports payloads through
the full submit→review→train→shadow chain (needs deployed service +
secrets); dashboard pages not browser-verified.

Blockers for product engineer (all in DESIGN.md §7): Cotality ML-
training licensing, secrets provisioning (CDARV_INTERNAL_API_TOKEN,
CDARV_TS_*), Postgres home decision, no deploy authorized.

### Prior: eval-engine canonical ARV audit (suspended)
Evaluations hardening: establish the canonical Flowstate ARV contract,
audit Python V4 (`services/eval-engine`) against it, and define the
smallest migration repair sequence. No production behavior changes
authorized yet.

### 2026-09-?? — Canonical ARV contract audit of V4 (this session)

Owner-supplied canonical contract (top-3 by verified sale price DESC,
plain mean of adjusted PPSF x subject sqft, no weighting/bands/
proximity reorder/avg-price fallback; NOT_EXAMINED_FOR_ARV for unreached
candidates; identical inputs -> identical result across eval/save/load/
recalc; changed input -> new revision).

Audit artifact: `services/eval-engine/tests/test_canonical_contract_audit.py`
(5 fixtures, all passing on V4 engine — verified `62 passed` suite +
this file's `5 passed`).

Findings (full report in session):
- `legacy_physical_v1` = LEGACY: physical-similarity ordering, selects
  exactly ONE comp (arv_selection_rank==1). Conflicts (not top-3).
- `upper_half_rule_weighted_v1` / `provider_authoritative_upper_half_v2`
  = EXPERIMENTAL: upper-half cohort (ceil(n/2) priced above 2nd-ranked
  qualified), rule_match_fraction weighting, 180/(180+age) recency
  weighting, 3x-median PPSF quarantine, weighted-mean PPSF. All
  conflict with owner contract (hidden weighting; cohort not top-3).
- V4 has NO 90%-of-highest band (that's TS `ARV_PRICE_BAND_PCT`), NO
  mean-sale-price fallback (missing sqft -> MISSING_SQFT/FAILED) —
  conforms on those two points.
- `NOT_EXAMINED_FOR_ARV` declared in contracts but NEVER assigned —
  contract gap.
- Fixture A result: all three policies yield exact_value 375000 BUT
  with different accepted sets (legacy: c-high only; upper-half:
  c-high+c-mid with 0.5/0.5 weights).
- Save/load + recalc determinism verified via payload round-trip
  (read path returns stored versioned payload; no silent re-eval).
- Competing live paths (TS): selectArvComps 90% band + proximity-first;
  evaluateWithFallback expansion ladder; condition-gate recompute via
  calculateARV (plain mean price, different formula); saved-report
  recalculateReport (top-3 by adjusted price); dashboard lib/recalc
  (all enabled comps, no top-3, passesHardFilters always true);
  /comp-selection LLM route overrides isEnabled directly.

Smallest repair sequence proposed (NOT implemented):
1. Add `canonical_v1` selection policy in select_arv_comps (price-desc
   iterate, first 3 passers, rest NOT_EXAMINED_FOR_ARV).
2. Plain mean-of-PPSF formula; bypass weighting.
3. Keep arv_selection_policy snapshot versioning — old snapshots keep
   old policies.
4. Align/neutralize TS + client recalc + LLM-override paths.

No production code modified. Next: product engineer confirms canonical
policy name/scope, then implement step 1-2 behind the policy switch.

### 2026-09-?? — Comparable candidate-retrieval hardening (uncommitted)

Audited + hardened CoreLogic/Cotality pool retrieval. Provider facts
(bundled OpenAPI spec, providers/docs/corelogic-api-docs.json):
maxComps max=100 (default 10), monthsBack max=36, NO pagination, response
has no totalCount/hasMore/cursor (truncation inferred: received>=limit),
sortBy Distance|Sale_Date only, landUse defaults to subject's
(provider-imposed, not overridable). Enrichment = separate paid
property-detail calls.

Changed (uncommitted):
- New `services/property-api/retrieval-policy.ts`: resolveCandidateLimit
  (COMPARABLE_CANDIDATE_LIMIT env → default 100, clamped to provider
  max), ComparablesRetrievalMeta audit type, expansionRefetchRadius
  (radius-bound tiers only), isProvablyDeadComp (extracted from
  analysis-job — only sale_age/sqft/year-at-widest-tolerance prune).
- corelogic.ts: clamps maxComps to 100, absolute sqftDiff bounds
  (minBldgSqFt/maxBldgSqFt), returns retrieval meta.
- attom.ts: same clamp + meta + sqftDiff.
- comparable-pool.ts: removed silent 50-per-pool merge cap.
- appraisal/types.ts: filtersToApiParams now emits absolute `sqftDiff`
  (was percent-mismatched sqftVariance — provider received 250% = no-op).
- analysis-job.ts: candidateLimit resolution, retrieval meta in
  bundle.metadata + comps_found event + truncation evidenceLimitation,
  expandComparablesPool callback (ONE wider-radius refetch when ladder
  reaches subdivision_expansion/geographic/nearest_comps/insufficient;
  mergeComparablePools + enrich only new provably-live comps).
- evaluation/index.ts: EvaluationParams.expandComparablesPool; performs
  refetch + full re-evaluation; 'pool_expansion_refetch' fallback +
  comparables_fetch step recorded.
- analysis/index.ts: comps.retrieval in response (audit trail).
- Callers: analyze /defaults + batch-job + ghl + dashboard (3 sites) no
  longer hardcode maxComps 10/15/25 — system config wins.
- wrangler.toml: COMPARABLE_CANDIDATE_LIMIT=100,
  COMPARABLE_EXPANSION_RADIUS_MILES=2.

Prefilter classification: monthsBack SAFE; sqftDiff SAFE (never-relaxed,
absolute bounds now correct); year_built SAFE (post-fetch only);
distance REQUIRES_EXPANSION_REFETCH (implemented); landUse
provider-imposed bound (documented).

Verified: `npx tsc --noEmit` api clean; `npm run test` api 17 regression
files pass incl. new tests/comparable-retrieval.test.ts (6 proofs:
>25 pool, position-36 candidate selected, order invariance, truncation
audit, refetch-radius + merge, enrichment pruning). Dashboard tsc has a
pre-existing stale `.next/types` atlas/page error unrelated to this work.

Cost implication: enrichment calls scale with provably-live pool size
(up to ~100 property-detail calls vs ~25 before, minus dead-comp
prunes); one extra comparables call only when expansion tiers engage.
ARV formula + selection methodology unchanged. NOT DEPLOYED.

## Prior Objective (completed)
Landing page v2 for `apps/dashboard` — credibility landing page for
realtors, wholesalers, investors; burger menu w/ portal access post-auth.

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

## Parcel flood-zone + site-location integration (2026-09-13, branch feat/cotality-flood-zone, NOT yet merged/deployed)
- Parcel flood-zone VERIFIED on existing host+token: GET
  property.corelogicapi.com/property/{fipsCode}:{universalParcelId}/flood-zone
  (the api1.cotality.com URL the user gave also works, but only with an
  api1-realm token — the same call on property.corelogicapi.com accepts
  our current property token, so that host is used).
- {id} is NOT the clip — it is the composite parcel ID. Search items
  carry it as `v1PropertyId` (e.g. "48029:36205502") or reconstructable
  from `propertyAPN.fipsCode:universalParcelId`. property-detail does
  NOT contain it — it only exists in the search response.
- Implementation (corelogic.ts / property-api index/types):
  - NormalizedProperty gains parcelId, apnFormatted, neighborhoodName,
    neighborhoodCode, cbsaCode, censusTract, legalDescription — all
    normalized from the already-fetched property-detail siteLocation
    block (no extra HTTP call needed; property-detail embeds the full
    site-location payload incl. neighborhood/CBSA/census tract).
  - New provider method getFloodZoneByParcel + service wrapper with KV
    cache key floodZoneKey(`parcel:{id}`) sharing CACHE_TTL.FLOOD_ZONE.
  - getFloodZoneForProperty(property): parcel first when parcelId known,
    graceful fallback to coordinate spatial lookup (and spatial only when
    no parcelId — e.g. getPropertyById path where detail lacks it).
  - NormalizedFloodZone gains specialFloodHazardArea ('In'/'Out') and
    source ('parcel'|'spatial'); shared FLOOD_ZONE_PATTERN validation;
    isInFloodZone honors SFHA 'In' even for unlisted zone codes.
  - Both flood call sites covered: AnalysisJobDO enrichment and
    getPropertyBundle (GHL webhook path searches by address → gets
    parcelId → parcel flood).
- Analysis response/report: subject gains parcelId/apnFormatted/
  neighborhoodName/neighborhoodCode/cbsaCode/censusTract/
  legalDescription; floodZone gains specialFloodHazardArea/mapPanel/
  mapDate/communityName/source. SSE subject_found carries parcelId +
  neighborhoodName + cbsaCode. Market-context prompt now includes
  neighborhood line.
- Tests: provider-evidence.test.ts extended — parcel flood normalization
  (X/Out → not in zone, panel+date+community mapped), zone 'D' rejected,
  SFHA 'In' flags high risk, malformed ID (no colon) fails without a
  request, parcelId/site-location propagation through search→detail.
  15/15 regression files pass; api typecheck clean.
- TODO when merged: deploy, then verify a live analysis logs
  /property/{id}/flood-zone and report.floodZone.source==='parcel'.

## Subject AVM + building-detail enrichment (2026-09-13, same branch, commit 608a21b)
- AVM endpoint DISCOVERED + GATED: GET
  property.corelogicapi.com/property/{parcelId}/avm/thv/{model} — model
  `thvMarketingStandard` is the ONLY model the gateway validates (all
  other names → "No THV model"). Valid model dispatches to the Order
  Manager which returns 404 "no response" → THV ordering product is NOT
  entitled (same class as market analytics). Provider method getAvm()
  implemented + wired subject-only; fails graceful (subject.avm=null)
  until the account adds THV.
- Building info: no extra endpoint needed — property-detail's
  buildings.data.buildings[0] already carries condition
  (buildingImprovementConditionCode, e.g. AVE), grade (gradeTypeCode),
  improvementValue, plus all coded construction fields. Also confirmed
  /property/{parcelId}/building exists (literal text: condition AVERAGE,
  airConditioning CENTRAL, heatType FORCED AIR, parkingType, pool, style)
  — available if richer per-parcel pulls are wanted later.
- Normalized: subject+comp buildingCondition/buildingGrade/
  improvementValue; comps gain parcelId (own v1PropertyId),
  neighborhoodName, stories, features.heating/cooling/fireplacesCount
  via enrichComparables — usable by eval rules pre-selection.
- Analysis response: subject.buildingCondition/buildingGrade/
  improvementValue/avm{value,confidence,range,model,asOfDate}; comp
  items gain the enriched fields. enrichComparables also feeds them.
- 15/15 regressions pass; api typecheck clean.

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

Known divergence FIXED (2026-09-13): shared sqft_diff evaluator was
%-based while the API uses absolute sqft — recalc treated value 250
as "250%" so the rule effectively never failed client-side. Shared
filter now uses absolute sqft, matching the API; settings UI unit
labels corrected '%' → 'sf' (evaluation-settings page + report
SettingsPanel).

### Comp-card lot/garage + stories hard rule (2026-09-13, same branch)

- CompGridCard: new "Lot" row — comp acres + sqft delta vs subject,
  color-coded via lotMatchColor (±2.5k sf green / ±5k grey / red).
  "Parking" row renamed "Garage" — shows garage + garageSquareFeet,
  carport appended only when present; carport alone shows as value.
- CompCard (list view): Lot stat now shows `0.230 ac (+2,310 sf)` delta
  via new subjectLotAcres prop (passed from ComparablesSection).
- SubjectGridCard: Parking → Garage with same garage-sqft rendering.
- format-helpers: +lotMatchColor, +fmtLotDelta.
- DEFAULT_FILTERS stories_match: soft → HARD (product rule: 1-story
  only comps 1-story, 2-story only comps 2-story; verified numeric
  mismatch disqualifies, missing data still not_verified). Not rescuable
  in expansion tiers (rescue allowlist = subdivision/distance only).
- River Park Villas example (comp 15yr off subject): at default
  year_built_diff=10 it exceeds the ±14 ladder max — rejected at every
  tier, and the nearest_comps last resort rejects it too. Knob already
  exists: user can set year_built_diff threshold to 15 in Evaluation
  Settings → ladder becomes ±15/±17/±19 and it passes at strict tier.
  NOT run locally — CoreLogic keys dead in local env; no saved report.
- evaluator.test.ts updated (stories now hard, roof stays soft).

Verified: 85 appraisal vitest + tsc clean api + dashboard.

### No-human-review + half-story tolerance (2026-09-13, same branch)

Product clarification: there is NO analyst/human-review step — the
system must always return its best decision. Changes:
- stories_match now tolerates ±0.5 (1.5-story comps compatible with
  1 and 2) in API evaluator + shared/filters.ts. Full-story mismatch
  (1 vs 2) still fails and disqualifies when required.
- manual-review override REMOVED: report.outcome.recommendation and
  response.valuation.recommendation always carry the formula call.
  confidence + confidenceReasons + requiresHumanReview flag remain as
  the reliability signal; low/medium append a caveat to
  recommendationReason. 'manual-review' kept in the recommendation
  union types for stored-report compatibility.
- DealSummaryHero badge text updated (no "verify manually").
- report.test.ts updated: LOW keeps formula rec + 'LOW confidence'
  reason; MEDIUM asserts 'medium confidence' caveat; +2 stories
  tolerance/disqualify tests.

Verified: 145 vitest + 15/15 regression + tsc clean api + dashboard.

### DEPLOYED + golden-eval harness (2026-09-13)

- Migration 0028 applied to REMOTE D1 (d1_migrations row inserted
  manually — `migrations apply` hit a 7403 API error; direct
  `--file` execute worked).
- `feat/cotality-flood-zone` fast-forwarded to main (1edcfc6) → CI
  deploy run 34777219422 GREEN (2m0s). All appraisal work live.
- UI: AVM cell removed from DealSummaryHero; Market Research section
  removed from AnalysisResultLayout (Cotality AVM/analytics not
  entitled; data still flows in the API response).
- `apps/api/src/scripts/golden-eval.ts`: golden-dataset harness —
  POST /v1/analyze (streetAddress+city/state/zip, skipCache) → SSE
  `evaluation_complete` → per-run ARV/recommendation/confidence/
  rulesApplied/fallbacks/selected comps + speed stats + accuracy vs
  expected labels + "what would raise confidence" aggregation.
  Dataset: apps/api/golden-dataset.json (6 real addresses). Run:
  `FS_API_KEY=fs_... npx tsx src/scripts/golden-eval.ts golden-dataset.json --runs N`
- First prod run (6 addresses, all on new code): 6/6 ok;
  speed mean 36.2s p50 39.0s p95 47.4s (10.9s outlier = thin
  3-comp pool); confidence low×5 medium×1; decisions hold×3
  strong-buy×1 buy×2; Canoe Creek's 2025 comp correctly absent.
  Dominant confidence blockers: unverified subject condition (4×),
  thin in-subdivision pools (3× nearest_comps), missing permit
  evidence.
- Confirmed: comp selection is 100% rules — LLM annotates
  reasoning/scores only (cannot touch isEnabled/compGroup).
- Temp prod api_keys row `golden-eval-tmp` deleted after run.

### WIP: condition evidence + neighborhood fallback (2026-09-13, feat/condition-and-neighborhood)

Implemented per product spec (vision/permits for subject, provider-first
condition for comps, subdivision→neighborhood fallback):

- major-items.ts: ASSUME_REPLACE_WHEN_NO_PERMIT = {roof, hvac,
  water_heater, electric_panel}. No permits → item assumed original
  install at house age; charged when houseAge ≥ threshold; unknown
  build year → assumed due. replumb/foundation/rewire and all other
  items stay evidence-gated (never assumed).
- derivation.ts: passes effectiveYearBuilt ?? yearBuilt into
  assessMajorItems; unknown-count note only counts uncharged unknowns.
- appraisal/index.ts: NEW tier 3 'neighborhood_expansion' between
  in-subdivision year widening and geographic expansion — rescues
  subdivision_match failures only when neighborhoodsMatch(subject, c)
  is verified true; year ladder restarts; gated by
  allowNeighborhoodExpansion (default true). Drop-radius tier now runs
  under allowGeographicExpansion only.
- evaluator.ts: exported neighborhoodsMatch(subject, comp) — name OR
  code equality; null when no comparable pair exists. Used by both the
  soft filter and the fallback tier (works even if user disabled the
  neighborhood_match filter — it is geographic evidence).
- property-api: neighborhoodCode propagated onto NormalizedComparable
  via enrichment merge (subject already carried name+code).
- evaluation/index.ts ARV gate (prior session, now verified): provider
  Good/VeryGood/Excellent positive; Fair/Poor/VeryPoor negative; vision
  renovated positive / dated+distressed negative; unverifiable comps
  KEPT (rules are primary, condition = confidence boost); verified-
  negative pruned only when ≥3 remain else arv_condition_thin.
- report.ts: subject condition counts verified via vision
  (renovationAssessment.status==='ok' or vision curb-appeal);
  stale 'review recommended'/'verify value manually' strings replaced;
  requiresHumanReview kept for API compat (documented as advisory).

Verified: 154 vitest (incl. 4 new derivation tests for big-four
no-permit behavior, 4 new rules tests for the neighborhood tier, 2 new
evaluator code-match tests), 15/15 regression files, tsc clean on
api + shared + dashboard.

NOT yet done: production golden-eval re-run on this code (needs deploy
or a fresh prod run after merge); Firecrawl is already the photo source
for comp vision (photoBundle.comps via Zillow) — provider→photos→vision
ordering confirmed in evaluation/index.ts.

### Style-match required + rate-limit tracker (2026-09-13, feat/condition-and-neighborhood)

- building_style_match default priority → 'hard'. Verified style
  mismatch disqualifies at every tier (rescue allowlists only carry
  location failures). Missing style data stays not_verified.
- Rate-limit tracking: auth middleware now LOGS 429 quota rejections
  into api_usage_logs (previously invisible — the 429 return preceded
  the usage insert). /user/usage returns rateLimit {hits24h, hits7d,
  serverErrors24h, recent[]}. Overview page has a Rate Limits panel
  (counts + recent hits, Healthy/Attention badge).
- Verified: 154 vitest, tsc clean api+dashboard.

### DEPLOYED: feat/condition-and-neighborhood → main (33c2e62)

- Deploy run 34781263673: API + Dashboard both green.
- Live: big-four no-permit assumptions, neighborhood fallback tier,
  provider→photos→vision comp condition gate, style match required,
  rate-limit tracker on Overview.
- Next: user uploads batch-import list for prod eval; watch the
  Rate Limits panel (tracks our API 429s + 5xx — provider-side
  CoreLogic/Firecrawl throttling is NOT yet logged, only visible as
  failures/latency).

### Notify feedback loop (9d769cc, merged to main)

- ComparablesSection: Notify button in manual-selection banner →
  notes dialog (Enter or Send submits, blank OK) → generates
  paste-ready devin.ai ticket + copies to clipboard.
- New lib/comp-feedback.ts: diffs user selection vs engine ARV set
  (compGroup), per-comp rule audit (passed/failed/not_verified,
  actual vs threshold), why-added-comp-wasn't-selected, and minimal
  config/code change to select it. Missing-evidence comps flagged
  "data gap, not rule change".
- API: comp filter serialization now emits `status` field so
  not_verified is distinguishable from failed client-side.
- Atom plumbing: `feedbackContext` (appliedFilters, fallbackUsed,
  fallbackReason, jobId, subjectAddress) synced on all 3 surfaces
  (analyze page, public report, saved report); threaded through
  AnalysisResultLayout → ComparablesSection.
- Verified: tsc clean api+dashboard.

### Card density + UI cleanup (860c8e6, merged to main)

- Notify button moved to comparables header — always visible (was
  gated behind isManual banner; user couldn't find it on reports).
- CompGridCard collapsed → essentials only (bed/bath, sqft, year,
  lot, style). Full comparison data → CompComparisonDialog +
  CompCard expander: foundation, construction, ext walls, roof,
  stories, heat/AC, assessor cond, vision condition, pool,
  garage/carport, lot delta.
- formatLotSize(): sqft ≤0.5ac, acres above — cards, subject, dialog.
- Removed pre-1978 lead-paint badges + neighborhood badges from UI;
  subdivision name only (neighborhood name+code stays in backend
  matching via neighborhoodsMatch).
- SubjectGridCard: Style row always rendered.
- Verified AI is NOT doing comp selection: analysis-job.ts annotates
  only; /comp-selection/analyze (LLM-selects) is dead code —
  runCompSelection never called.
- Verified: tsc clean dashboard.

### Stacked comp sort + neighborhood filter (9720a10, on main)

- ComparablesSection sort stack: selected comps pinned contiguous →
  geo grouping (subdivision / neighborhood modes) → appraisal-rule
  closeness (constant, direction-invariant) → directional key.
- Subdivision & Neighborhood modes arrow-toggles asc/desc by PRICE;
  Distance arrows flip miles; Price & $/Sqft standalone.
- neighborhoodCode serialized to dashboard so client-side
  neighborhood filter can match by name OR code (same as backend
  neighborhoodsMatch).
- Default sort remains the engine's selection order.
- Verified: tsc clean dashboard.

### Batch review workflow (e92ce60, feat/batch-review-workflow)

- api migration 0029: saved_reports + feedback_status / notes /
  report / at. POST /user/reports/:jobId/feedback stamps
  'validated' | 'improve' + notes + generated ticket (validated
  origin/session/content-type). GET /user/reports/:jobId returns
  feedbackStatus/feedbackAt. GET /batch/:id joins feedbackStatus
  per result jobId (inArray over saved_reports). BatchJobDO results
  now carry confidence into resultsJson.
- dashboard batch page: list picker (All lists + per-list chips with
  progress), queue card with "N left in queue", confidence bucket
  cards (All/Low/Medium/High/Unrated — counts + reviewed + Review
  link to first unreviewed), table gains Confidence + Reviewed
  (Validated ✓ / Flagged ⚑) columns; row links carry ?batch&conf.
- report page batch-review mode: ?batch=<id>&conf=<bucket> loads the
  batch queue → fixed bottom bar (prev address left, next right,
  position + reviewed count + back-to-batch center). Notify submit
  auto-advances to next unreviewed (onFeedbackSubmitted callback
  through atom → AnalysisResultLayout → ComparablesSection).
- Notify dialog: two actions — Validate (stamp correct) /
  Flag for improvement (generate ticket). Blank notes OK.
- Verified: tsc clean api+dashboard; 154 vitest pass; 15/15
  regression files pass; migration 0029 applied to local D1.
- NOT deployed — remote migration 0029 must run on remote D1 before
  stamps persist in prod (deploy applies migrations? verify in
  deploy.yml before pushing to main).
- Next: user uploads batch list → reviews low-confidence bucket →
  Notify loop generates devin-ready tickets.

### DEPLOYED: feat/batch-review-workflow → main (044640a)

- Deploy run 34785478384: API (38s) + Dashboard (1m29s) green.
- Remote D1: 0029_report_feedback applied via dashboard console,
  d1_migrations row inserted manually — wrangler shows clean.
- wrangler OAuth re-authed locally (was user-read only scope → 7403).
- Live: batch list picker, queue counts, L/M/H confidence buckets,
  validated/flagged stamps, report-page prev/next review bar with
  auto-advance on Notify submit.
- Note: tsconfig.tsbuildinfo keeps dirtying the worktree on
  typecheck — consider gitignoring it.

### Batch FIFO queue + provider-call tracking (f7b9640 → main 907e551, DEPLOYED run 34787573784)

- Address cap 50 → 1000 per list (route + CSV validation).
- services/batch-queue.ts: FIFO across a user's lists — new batches
  insert as 'queued' when a list is active; the finishing batch
  atomically claims + starts the oldest queued list (kick on
  complete / fatal-error / retry / mark-completed / recover).
  Stale 'processing' (>10min no DB update) auto-fails so a dead
  DO can't wedge the queue; GET /batch/:id repairs a stranded
  queue while polled; kick is claim-guarded (no double-start).
- /user/usage: providerCalls {month, limit:5000} — sums
  analysis_runs.api_call_stats_json corelogic.total (real provider
  calls, cache hits excluded). Display-only, not enforced.
- Overview Rate Limits panel: 4th cell "Provider calls — this month"
  (amber ≥80%, red ≥100% of 5,000).
- Batch UI: queued lists show clock chip + "Queued — starts when
  the current list finishes"; polling flips to live on kick.
- Verified: tsc clean api + dashboard.
- Heads-up for user: ~10–30 CoreLogic calls per address means a
  300-property upload ≈ 3k–9k calls vs the 5k/mo plan — the monthly
  counter will show the burn.

### 164-address production batch (IN PROGRESS 2026-09-13)

- Source: redfin_2026-09-13-15-30-26.csv → 164 San Antonio addresses.
- Auth blocked every scripted path (prod BETTER_AUTH_SECRET and
  DASHBOARD_INTERNAL_SECRET differ from .dev.vars; wrangler dev --remote
  no longer supports Durable Objects). Resolution: generated fs_ API key
  + inserted its sha256 into prod api_keys (id batch-driver-temp key
  prefix fs_1d32fdcf) for hello@flowstate.homes — REVOKE when batch done.
- Inserted batch_jobs row batch_c3711744-a8d1-4a49-a51a-525af9e6de99
  (status=processing, 164 pending results) directly via remote D1.
- Driver /tmp/fs_batch_driver.mjs (log /tmp/fs_driver.log, state
  /tmp/fs_driver_state.json): sequential POST /v1/analyze → SSE watch for
  evaluation_complete → writes results_json + counts + heartbeat to
  batch_jobs (shape identical to BatchJobDO). D1 poll of analysis_runs as
  fallback when SSE drops. Stops batch if monthly CoreLogic calls ≥5000.
- Monthly provider calls at driver start: 235/5000.
- Cleanup pending: revoke fs_1d32fdcf key, delete temp session row
  inserted earlier in session table (token et5vUPzR6O-...), delete local
  temp files /tmp/fs_*.

### Batch resume-from-row (feat/batch-resume-from-row → main 697d599, DEPLOYED run 34789984225)

- POST /batch/:id/resume {fromIndex}: session-auth; 409 while a live run
  is processing (stale >3min resumable) or while queued; passes
  addresses+results+fromIndex to the DO.
- BatchJobDO /resume: reconstructs batchState for DO instances that never
  ran the batch (DB-seeded rows), resets non-completed results >=
  fromIndex, reuses retryFailed index runner (progress SSE, DB updates,
  kickNextQueuedBatch at end).
- Batch page: per-row Play button on unfinished rows (hidden while the
  list is processing); resumes that list and switches to it.
- Verified: tsc clean api + dashboard.

### List-1 run stopped by user (2026-09-13 ~23:10Z)

- batch_c3711744 stopped at 8 completed / 10 failed / 146 cancelled
  (cancelled rows marked failed w/ 'Cancelled — stopped by user').
- Orphan duplicate row af372339 (same 164 addrs, from the failed
  remote-dev POST) deleted.
- Failure pattern: INSUFFICIENT_COMPS — ~15 comps fetched, 0 enabled.
  Same-subdivision + 180d + ±250sf + ±10yr rules exhaust the pool on SA
  wholesale properties; successes only passed via nearest_comps fallback
  with 1-2 comps. Under-reporting gap: api_call_stats_json is NULL on
  error runs, so failed analyses' provider calls aren't counted.

### Batch stop/cancel + stuck-flag fix (feat/batch-stop-cancel → main 7a6f827, DEPLOYED run 34790356619)

- POST /batch/:id/stop — pauses after current address; rows stay pending
  (resumable via play); queued batches stop into 'cancelled'; dead-DO
  fallback pauses row directly + kicks queue.
- POST /batch/:id/cancel — remaining rows → 'Cancelled — stopped by
  user', batch completes; works on processing/queued/paused.
- BatchJobDO: stopRequested flag checked between addresses in
  processBatch + retryFailed; finishStopped finalizes + kicks queue.
  New batch status 'paused' (non-blocking for the FIFO queue).
- Stuck-flag fix: DO heartbeat now touches batch_jobs.updated_at every
  60s — a >3min single-address analysis no longer trips isStuck.
- UI: Stop + Cancel list buttons on the queue card (cancel confirms);
  'paused' shows 'Paused — click ▶ on any row to resume'; poll handles
  paused/cancelled terminal states.
- Verified: tsc clean api + dashboard.
- NOTE: batch_c3711744 was resumed via the deployed /resume path and is
  processing natively (13+ done at 23:39Z). fs_1d32fdcf temp key still
  needs revoking when all batch work settles.

### 2026-09-13 — Confidence decoupled from comp volume + report timing (merged `3e00dc6`, deployed)

- ✅ **Confidence = match quality, not count.** `report.ts`: `selected.length < 3`
  no longer forces LOW. A single fully-verified comp with no fallback +
  verified subject condition can be HIGH. LOW only on: zero selected comps,
  hard-rule-breaching selected comps, `nearest_comps`/`insufficient` fallback,
  or very stale selected sales (>365d). Test updated to new semantics.
- ✅ **Volume surfaced separately.** `BatchResult.compCount` (enabled comps
  matching rules) written in batch DO → new **Comps** column in batch table.
- ✅ **Per-address timing.** `BatchResult.durationMs` measured in
  `processOneAddress` → **Time** column.
- ✅ **Lifetime avg report time.** `/user/usage` returns
  `analysisTiming { avgMs, runs }` (avg over `analysis_runs.duration_ms`);
  Overview Rate Limits grid → 5th cell "Avg report time — lifetime".
- ✅ Verified: tsc clean api + dashboard; report.test.ts 7/7 green.
- ✅ Deployed to production (deploy run green after merge to main).
- ⚠️ Pre-existing batch rows (resultsJson written before this change) have no
  `compCount`/`durationMs` → columns show `—` for old rows; new rows populate.
- ⏳ Still open: provider-call undercount on error runs
  (`api_call_stats_json = NULL` on failures); temp key `fs_1d32fdcf` revoke;
  temp session row + /tmp/fs_* cleanup.

### 2026-09-14 — Batch watchdog + force-complete removal (merged `4e8f8d7`, deployed `34793494581`)

- ✅ **Per-address watchdog** in `BatchJobDO.processOneAddress`: every child-DO
  `stub.fetch` bounded by `AbortSignal.timeout(15s)`; 3 consecutive unreachable
  polls fail the address. Stall detection: after 60s elapsed, no new events or
  status change for 45s → address failed ("Analysis stalled") and the list
  continues. 180s hard cap retained. This was the wedge: a hung fetch meant the
  timeout check never ran and the whole list froze silently.
- ✅ **Fatal-path consistency**: retry + resume `.catch` handlers now mark the
  batch `failed` in D1 + kick the FIFO queue (previously left `processing`
  until the 10-min stale sweep).
- ✅ **Force-complete removed**: `/batch/:id/recover` route, DO
  `/mark-completed`, `recoverStuckBatch` action, stuck banner + button. The
  feature corrupted state — the still-running DO loop overwrote the recovery.
- ✅ Verified: tsc clean api + dashboard. Deployed.
- ⚠️ `batch_c3711744` died ~00:37:44Z when the deploy evicted the DO isolate
  (25 done / 20 failed / 164). Row flipped to `paused` — user resumes via
  the Resume button, which now runs under the watchdog.
- ⏳ Still open: provider-call undercount on error runs; temp key
  `fs_1d32fdcf` revoke; temp session row + /tmp/fs_* cleanup.

### 2026-09-14 — Batch self-heal alarm + settings-save retry + UX fixes (merged `210775a`, deployed `34794556662`)

- ✅ **DO alarm watchdog (permanent auto-resume).** `BatchJobDO.alarm()`:
  processing loops re-arm a 60s alarm each address; `loopRunning` flag
  distinguishes a live loop from an evicted isolate. On alarm with a dead
  loop + `lastProgressAt` older than 210s → resets the in-flight row to
  pending and calls `retryFailed` automatically. Deploys/evictions/crashes
  now self-recover with zero user action. Stale sweep (10min) remains as
  the last-resort safety net.
- ✅ **Settings-save 500 during batch**: new `lib/db-retry.ts`
  `withDbRetry` (backoff on SQLITE_BUSY / connection drops / D1_ERROR)
  applied to all settings write routes — deal-params, rehab-config,
  arv-threshold, major-item-costs, proximity-config, ui-prefs.
- ✅ **Batch import lands on lists view**: whenever batch_jobs exist the
  picker + confidence buckets show by default; upload form only on New
  Batch (with "← Back to lists"). Stale "Max 50" copy → 1,000.
- ✅ **Play button hover-only**: row resume button hidden until row hover
  (always visible while its resume is in-flight).
- ⚠️ batch_c3711744 is `paused` (25/20/164). It predates alarms — one
  manual Resume click restarts it; from then on the watchdog covers it.
- ⏳ Still open: provider-call undercount on error runs; temp key revoke;
  /tmp/fs_* cleanup.

### 2026-09-14 — Evaluation-settings save 500 + batch alarm silent-death fix

- ✅ **`appraisal-rules.ts` fully wrapped in `withDbRetry`** (was the only
  settings route left unwrapped — the reported 500 on toggling
  `old_comp_discount`). All GET/POST/PATCH/DELETE/set-default ops retry
  transient D1 errors (SQLITE_BUSY / dropped connections during batch writes).
- ✅ **Atomic delete+insert** via `db.batch()` for filter/adjustment replace-all
  in PATCH + hidden-preset upsert in `location-settings.ts` — a mid-sequence
  failure can no longer leave a preset with zero rules.
- ✅ **`location-settings.ts` wrapped** (20 sites) — same contention exposure.
- ✅ **Batch silent-death hole fixed**: `retryFailed`'s settings-load failure
  previously returned *before* `setAlarm` and without updating status → batch
  stuck `processing` forever, even consuming the watchdog alarm (the likely
  cause of the 01:02Z freeze). Now: `withDbRetry` on settings load, then on
  persistent failure marks batch `failed` in state+D1 and kicks the queue.
  `processBatch` gets the same treatment + missing queue kick added.
- ✅ **Error surfacing**: `fetchApi` (client-api.ts + api.ts) now appends the
  API's `message` field to thrown errors — the toast shows the real cause
  instead of bare "Internal server error".
- ✅ Prod: dead batch `batch_c3711744` (29 done / 114 left) flipped to `paused`
  — predates this fix, needs one manual Resume click.
- Verified: `tsc --noEmit` clean in api + dashboard.
- ✅ Deployed to production (merge `fdd62a8`, deploy run `34796998689` green).

### 2026-09-14 — Feedback submit 403 "Untrusted origin" (merged `79b3c0a`, deployed `34798338081`)

- Root cause: `submitReportFeedback` is a Next.js server action → the API
  request carries no `Origin` header → the strict origin check on
  `POST /user/reports/:jobId/feedback` (and `/:jobId/comps`) rejected it.
- Fix: allow Origin-less requests (browsers always send Origin on POST, so
  absent = server-side caller, still session-authed); wrong origins still 403.
- Verified: tsc clean; deploy green. Notify → Validate/Flag now persists.

### 2026-09-14 — Real-time stopwatch for in-flight batch row (merged `3e534c8`, deployed `34800425701`)

- `BatchResult.startedAt` (epoch ms) stamped in BatchJobDO when an address
  enters processing; `updateDbProgress()` now runs at address *start* too, so
  polls/reloads see the live row with its true start time (previously only
  SSE-connected clients saw 'processing'; a reload showed it as pending).
- SSE `address_started` carries `startedAt`; dashboard stopwatch prefers the
  server timestamp, falls back to first-sight. Timer freezes to `durationMs`
  on completion and resets to zero for the next row.
- Verified live: batch_c3711744 kept processing across the deploy
  (36 → 39 completed, heartbeat fresh) — alarm watchdog working as designed.

### 2026-09-14 — Batch review triage filters (deployed `34801584274`)

- "Hide reviewed" checkbox (default on) — stamped rows (validated/improve)
  drop out of All and every confidence bucket; chip counts show remaining
  vs reviewed. Fixes re-review churn on the low-confidence sweep.
- New filter chips: **Validated**, **Flagged**, **Insufficient comps**
  (failed runs with INSUFFICIENT_COMPS). Non-bucket filters pass conf=all
  into the report page so the in-report review queue isn't broken.
- Report page already auto-advances past stamped rows (nextUnreviewed) —
  confirmed, no change needed there.
- Also shipped: failed batch rows now record `durationMs` (Time column).

### 2026-09-14 — Stopwatch staleness fix (deployed `34802230275`)

- Alarm auto-resume resets now clear `startedAt` AND write progress to D1
  immediately — a poll landing in the reset→restart gap previously showed
  the dead run's old timestamp (user saw "7 min" when the row had actually
  restarted 51s ago).
- Manual resume/retry reset paths clear `startedAt` too.
- Client resets per-row start stamps on batch/view switch — stamps were
  keyed by index only, so a different list's row could inherit a stale
  elapsed time.

### 2026-09-14 — Headshot-photo fix + copy buttons (deployed `34804498166`)

- Root cause of "girl's face" cover photo on 20810 WOODLAND CV comp:
  Zillow serves agent headshots from the same photos.zillowstatic.com/fp/
  path as listing photos (-h_* suffixes). Gallery-branch extraction in
  parseZillowHtml applied ZERO suffix filtering; other paths only excluded
  5 hardcoded -h_ variants. Broad /-h_[a-z]+[.-]/ exclusion at all layers.
- persistReportAssets now parses image dimensions (JPEG/PNG/WebP) and
  rejects <300x200 — catches any small headshot/icon regardless of URL.
  Returns `rejected` URLs; evaluation drops them from photo lists instead
  of leaving hotlinked CDN URLs (previously a failed persist still showed
  the image). Verified against live report: 2 headshots + 1 floorplan
  were stored; headshots now blocked at both layers.
- CopyButton (components/ui/copy-button.tsx) added to: report header
  subject address, comparables tables, comp grid cards. CompCard/
  SubjectPropertyCard already had copy via AddressDisplay.
- NOTE: existing saved reports keep their old stored photos — the
  Woodland Cv report needs a Refresh to re-scrape with clean photos.

### 2026-09-14 — Proximity comp ranking + card photo ratios (deployed `34804950103`)

Ticket summary — 4 flagged-for-improvement reports (feedback_status='improve'):

1. 8686 RIDGE MILE DR — analyst added same-street comp (8770 RIDGE MILE,
   0.22mi) that failed sale_age (284d > 180d). Intent: distance takes
   precedence when rules match; knowingly overrode 180d for same street.
2. 311 RIVERDALE DR — analyst added 2 same-neighborhood comps matching
   foundation type (pier & beam vs slab = 10-15% value delta). Both failed
   subdivision; foundation data is missing on comps ("—" in audit) —
   DATA COVERAGE issue, not a rules issue.
3. 11235 PECAN CYN — analyst added CHASE CYN (passed all rules, lost
   ranking) + HICKORY CYN (sqft failed by 5sf — 255 vs 250 boundary).
4. 21210 FOREST WATERS — analyst added same-street 21660 (passed all
   rules, lost ranking) + WOODLAND CV (failed sale_age + sqft).

Corrections shipped:
- ARV selection ranking: verified passes → same street → distance →
  recency → price (proximity now beats recency among rule-equals).
- nearest_comps fallback orders by proximity, not pure recency.
- streetNameKey() same-street detection w/ suffix canonicalization.
- Comp grid cards h-28 → aspect-[3/2]; subject/comp images → aspect-video.
- 3 new vitest cases (96 pass).

Open product decisions for analyst:
- Ticket 1/4: allow a sale-age exception for same-street comps? (would
  breach the hard 180d rule — needs explicit policy, e.g. same-street
  sales up to 365d as a disclosed exception)
- Ticket 3: sqft boundary grace? (255 vs 250 — ±5sf tolerance or bump to 300)
- Ticket 2: foundation data coverage from provider — engine can't verify
  pier-vs-slab without data; when present it already counts as a soft rule.

### 2026-09-14 — 24/7 batch sweeper + list-switch UX (deployed `34862156165`)

- Overnight batch batch_c3711744 DID complete (~04:55Z): 97 done / 67
  failed / 164 total. 66 failures = INSUFFICIENT_COMPS (legit), 1 =
  transient CoreLogic 500. It self-healed through multiple deaths — the
  perceived failure was stale UI + no autonomous sweeper.
- NEW: Cloudflare Cron trigger (*/5min) + scheduled() handler →
  sweepStaleBatches(): nudges stale processing DOs (same resume path as
  the alarm), fails rows dead >15min to release the FIFO queue, starts
  stranded queued batches. Batch now recovers with no dashboard open —
  the last 24/7 gap closed. POST /nudge on BatchJobDO reuses alarm().
- TOML gotcha hit+fixed: [triggers] must sit at END of wrangler.toml —
  placed mid-file it swallowed compatibility_date/flags into its table.
- Dashboard: selectBatch fetches BEFORE committing selection (dead click
  fix — a failed fetch left a chip highlighted over the previous list's
  rows); per-chip spinner + upload-date label; table dims while loading;
  All-lists merge parallelized.

Architecture decision (answered for product engineer): no stack change
needed. DO + alarm + cron covers self-healing FIFO processing with SSE;
a Queue-based rewrite adds complexity for no reliability gain given the
sequential rate-limited processing requirement.

### 2026-09-14 — List-detail 500 root cause (deployed `34866433602`)

- GET /batch/:id 500'd for the 164-row list since the feedback-stamp join
  shipped: inArray(savedReports.jobId, jobIds) exceeded D1's 100 bound-
  parameter limit at the Worker binding. June lists (49-50) were under
  the cap — masked the bug. Mount path also silently swallowed it
  (empty table, no error) until the selectBatch error path surfaced it.
- Fix: chunked the stamp join at 90 ids/chunk in batch.ts.
- Note: raw `wrangler d1 execute` accepts >100 params — the cap is
  enforced by the D1 Worker binding, not the HTTP API. Keep joins ≤90.

### 2026-09-14 — iPhone PWA native feel (deployed `34904235419`)

- viewport-fit=cover + userScalable=false in layout.tsx → safe-area
  insets now resolve (env() was returning 0 without cover).
- --sat/--sab CSS vars in globals.css; mobile header, bottom tab bar,
  main content padding, report toolbar, valuation card, batch review
  bar, impersonation banner, landing header all safe-area aware.
- Translucent bg-background/80 + backdrop-blur-xl on mobile chrome.
- Inputs forced 16px below lg breakpoint — iOS focus auto-zoom gone.
- tap-highlight transparent, touch-action manipulation,
  overscroll-behavior-y none, html bg = --background (bounce fill).
- Bottom tab bar: explicit short labels (Home/Search/Batch/Reports/
  Settings) — 'Property'/'Property' dup fixed; 44px targets; active
  scale feedback. Batch results table: min-w-[680px] + overflow-auto.
- theme_color unified #161511 (manifest + viewport).

### 2026-09-15 — Provider-call efficiency pass (merged `5fa2673`, deployed `34927651033`)

Real batch stats (120 completed runs): 11.8 paid calls/report avg
(844 property-detail, 120 property-search, 120 AVM, 99 flood, 100
comparables, 103 permits, 25 building_detail); 41% cache-hit rate.
Three provable wastes fixed:

- **Comp enrichment pre-filter** (analysis-job.ts): `sale_age`,
  `sqft_diff`, and `year_built` at the widest sanctioned ladder step
  (strict + max yearBuiltExpansionSteps = ±14 default) are NEVER
  relaxed by any fallback tier — rescue allowlists only carry
  subdivision_match/distance, and filtersAt() only widens year+distance.
  enrichComparables never overwrites saleDate/sqft/yearBuilt, so a raw
  comp verifiably failing one is dead under every tier. Those comps are
  skipped before per-comp property-detail calls; missing fields still
  enrich (not_verified semantics preserved). Skipped count logged.
  Disabled filter (enabled:false) → Infinity → no pre-reject on it.
- **AVM circuit breaker** (property-api/index.ts getAvm): 3 consecutive
  ENTITLEMENTS_ERROR/NOT_FOUND failures → `avm:disabled:{provider}` KV
  flag, 7-day TTL (self-heals if the account gains entitlement).
  Success resets the fail counter. THV model 404'd on every one of 120
  runs — this removes a guaranteed paid miss.
- **property-search cache**: address→parcel mapping cached under
  `prop:search:{provider}:{normalized-addr-key}` for 21d
  (PROPERTY_DETAILS TTL). Success-only caching; cache hits logged as
  'property-search' cacheHits.

Verified: tsc clean; 96 appraisal vitest pass (no comp-selection
change). Expected ~11.8 → ~6-7 paid calls/report.

### 2026-09-15 — Opt-in permits + listing-derived flood (uncommitted, main)

Product direction: motivated-seller vetting (~25 evals/day → 750/mo).
Permit + flood-zone provider calls removed from the default pipeline
(~1.7 paid calls/report saved → ~5.3/report → ~940 reports/mo ceiling).

- **Permits → on demand**: AnalysisJobDO + getPropertyBundle only fetch
  permits when `enrichment.permits === true`. Reports emit
  `subject.permits.status: 'not_requested'` (new union member, API +
  dashboard types) so the UI shows a pull action, not an error.
- **New route** `POST /user/reports/:jobId/permits` (session + origin
  checked): pulls subject permits via propertyApi.getBuildingPermits
  (CLIP id from saved.subject.id), re-runs assessMajorItems with the
  user's major-item config, preserves Caller-specified manual items,
  re-runs valuation + calculateAllRehabLevelEstimates against the
  appliedSettings snapshot, rebuilds report.rehab.ledger + deductions +
  outcome + riskFlags + top-level permits summary, bumps
  evaluationRevision, optimistic-locked batch write (history + update).
- **Location-penalty gap fixed**: the proximity deduction was never
  serialized — recalculateReport (comps route) silently drops it too
  (pre-existing). Extracted `computeLocationPenalty()` in
  evaluation/index.ts (shared by pipeline + route); permits route
  rebuilds it from saved.locationRisks + loadUserAnalysisSettings
  (subject's parsed address → same resolution incl. location overrides).
  Rebuilt deductions now include a Location Penalty line when > 0.
- **Flood → listing scrape**: extractFloodSignal already ran inside the
  subject photo fetch (Redfin first in SUBJECT_FALLBACK_ORDER, Realtor
  also covered — both via listing-scraper). evaluation/index.ts now
  converts photoBundle.subject.metadata.floodRisk into a
  NormalizedFloodZone with `source: 'listing'` when no provider flood
  data exists; FEMA fields null. Risk flag reads "Flood risk (listing):
  X" vs "Flood Zone: X"; RiskFloodCard shows "Listing estimate — not
  FEMA" badge + "Risk"/"Elevated Risk" labels; MapOverlay + PDF label
  it as listing risk, not FEMA zone.
- **UI**: PropertyPermits renders a "Permits" button for
  not_requested/unavailable/missing states (authed pages only — public
  report page has no onPermitsPulled → button hidden). Pull →
  pullReportPermits() → onPermitsPulled(analysis) → analyze page
  setAnalysisResult / report page setReport. evaluationRevision flows
  through so subsequent comp edits can't stale-lock.
- /analyze/defaults now advertises permits:false, floodZone:false.

Verified: api + dashboard tsc clean; 157 api vitest pass;
dashboard regression 4/4 files pass (headline-money.test.mjs permits
subtest fixed — was already broken on HEAD: unresolvable `@/` imports
+ stale assertions; now mocks useEvaluation/client-api/sonner/cn and
asserts not_requested/loading/available states).

NOT DEPLOYED — awaiting explicit deploy instruction.

### 2026-09-15 — Closest-first comp selection (uncommitted, feat/iphone-pwa)

Product rule: nearby comps are scrutinized first and only skipped when
they actually fail — never because a farther comp carried more verified
fields or sold more recently.

- **Fetch ordered by distance**: CoreLogic comparables now request
  `sortBy: 'Distance'` (was `Sale_Date`) — the pool is the NEAREST sales
  in the 1mi/12mo window, not the newest. Nearby-but-older sales no
  longer get crowded out of the 15-comp pool before rules see them.
  ATTOM fallback unchanged (no sort param). Comparables cache key bumped
  search-v3 → search-v4 so stale recency-ordered pools don't linger.
- **Pool depth 15 → 25** (analysis-job/batch defaults, analyze route +
  dashboard queueAnalysis + /analyze/defaults): distance-sorted, the
  extra candidates are still the closest available — the sale-age rule
  culls older ones, so depth matters. Same single comparables call;
  enrichment cost unchanged for dead comps (pre-filter).
- **ARV selection order**: selectArvComps now sorts proximity FIRST
  (same street → ascending distance → sale recency), then verified
  passes, then price — was verifiedPasses-first, so a 0.9mi comp with
  more verified data could outrank a same-street comp. The 90%
  top-of-market band still gates (that's the condition-proxy scrutiny
  that legitimately rejects a cheap nearby as-is sale).
- Enrichment already ran closest-first (toEnrich sorted by distance);
  the nearest_comps fallback tier already used proximityCompare.

Verified: api + dashboard tsc clean; 96/96 appraisal vitest pass;
15/15 api regression files pass (comparable-search asserts
sortBy=Distance in the request URL).

NOT DEPLOYED — awaiting explicit deploy instruction.

### 2026-09-15 — Deployed (34931916528) + appraisal/UI improvement package

**Deployed**: `bba0a64` (permits on demand + listing flood) and
`a6b83c7` (closest-first comp selection) — merged to main, CI deploy
run 34931916528 GREEN.

**New work (uncommitted, feat/iphone-pwa)** — the 13-flag feedback
package the product engineer approved:

- **Overpass failover**: location-risk endpoints were all returning 406
  (0/25 reports had locationRisks). Now kumi.systems + private.coffee
  lead, originals as fallback; POST form-encoded; 15s per-endpoint
  timeout; 25s query timeout.
- **Fuzzy subdivision**: subdivisionBase() strips UN/UNIT/BL/LOT/PH/
  SEC/NCB/PLAT/etc + numeric identifiers; word-boundary prefix match
  (SWEETWATER CREEK ≈ SWEETWATER CREEK S UT 2E) but not OAK≈OAKWOOD.
  Mirrored API evaluator + shared filters + all dashboard call sites
  (grid badge, list card, comparison dialog, section sorting).
- **Foundation hard rule + adjustment**: foundation_match promoted to
  hard (verified family mismatch disqualifies; 'other'/unclassifiable/
  missing never fail hard). Post Tension classifies slab not raised.
  New `foundation` adjustment type — % deduction (default 10%) off comp
  price on verified family mismatch; matters when user demotes the
  filter to soft. Migration 0030 promotes existing presets' NULL/soft
  foundation_match rows to hard.
- **Settings backfill**: loadUserAnalysisSettings now fills missing
  rule types from DEFAULT_FILTERS/DEFAULT_ADJUSTMENTS — presets saved
  before new types existed (foundation adj, traffic_*, basement_sqft,
  new filters) inherit system defaults instead of silently never
  applying. Both default-preset and location-override paths.
- **Batch settings**: re-reads settings per address (both runBatch and
  retryFailed loops), last-good snapshot on transient failure,
  proximityConfig now forwarded in evalParams to /start-streaming.
- **Location penalty end-to-end**: OSM risks → bundle.enrichment →
  computeLocationPenalty(worst position, ARV, user proximityConfig) →
  calculateValuation deducts from buyPrice. FIXED: penalty now
  serialized to response (valuation.locationPenalty + effective %),
  breakdown ledger line shows effective % not 0, ValuationCard renders
  an amber "Location Penalty" line + updated buy-price formula tooltip.
- **List price**: extractListPrice() in listing-scraper (listPrice/
  askingPrice/JSON-LD offers.price) → photoBundle.metadata →
  ctx.subjectListPrice → subject.listPrice + valuation.listPrice +
  valuation.arvVsListPrice (ARV − list; negative = below ask).
  SubjectGridCard shows List Price above last-sale; ValuationCard adds
  a List Price metric cell with ARV-vs-list delta.
- **Sub-1k sqft**: subject <1000sf → comps ≤1000sf bypass ±250 (API
  evaluator + shared + batch pre-filter + provider sqftVariance widen).
- **Feature-match indicators**: new feature-match.ts compares 17
  card-visible features vs subject (subdivision, neighborhood,
  foundation, style, stories, construction, roof, condition, pool,
  garage, hvac, fireplaces, beds, baths, sqft, year, lot) — match/
  mismatch/unknown. CompGridCard gets a dot strip + match count;
  CompCard gets dot strip + green/red on every stats cell and expanded
  detail row (needs subject prop — added, back-compat with old props);
  CompComparisonDialog highlights every StatCell. Gray = unverifiable,
  never a false red.
- **Settings UI**: client-api AdjustmentType gains traffic_*/
  basement_sqft/foundation; format-helpers label maps cover all
  types; evaluation-settings chips show new types with correct
  %/$ /flat+% formats; AdjustmentRow gets dual $+% inputs for
  traffic_* types and Days+% badge for old_comp_discount.

Verified: api tsc clean; dashboard tsc clean; 110/110 appraisal vitest
pass (incl. 15 new tests: subdivision normalization, foundation
families/hard match/deduction, small-subject sqft); dashboard
regression 5/5 files pass (new feature-match.test.mjs covers match/
mismatch/unknown semantics against real shared matchers).

DEPLOYED (2026-09-15): feat/iphone-pwa fast-forwarded to main
(a6b83c7..4f50165) via `git push origin feat/iphone-pwa:main` — main
is checked out in the sibling worktree so push-by-ref is the merge
path. CI deploy run 34936244099 GREEN (API 43s, dashboard 1m24s).
Migration 0030_foundation_match_hard applied to prod D1 via
db:migrate:remote (first attempt 7403'd transiently; retry succeeded).

Follow-up still open: routes/user-reports /comps recalc path
(recalculateReport) does not recompute the location penalty — same
gap the permits route had; passes no locationPenaltyAmount into
calculateValuation so buy price can drift upward on comp edits for
fronting/backing subjects.

### 2026-09-15 — CDARV ML foundation (feat/cdarv-ml-foundation, c4fc09c, NOT merged/deployed)

Foundation for ML that consumes ideal reports and learns comp
selection/ranking. Product-engineer decisions: source = prod API
validated reports (`saved_reports.feedback_status='validated'`); model
target = comp selection/ranking; placement = own Python package under
services/ml, NOT a separate deployed microservice — uses existing
backend/background-worker infra when scheduled. eval-engine stays a
data producer only; CDARV returns shadow results only.

- `services/ml/src/cdarv/`: reports.py (parse full_response_json →
  IdealReport + CandidateComp; compGroup/asIsCompIds/afterRenovationCompIds
  are labels, never features), features.py (61 features: geography, size,
  market, per-filter ±1/0 scores, classification, subject context; NaN +
  _known indicators), store.py (SQLite: ideal_reports, comp_examples,
  model_versions, shadow_predictions; raw report kept verbatim for
  re-derivation), ingest.py (SqliteReportSource for D1 files/exports +
  HttpReportSource for prod API; content-hash idempotent), model.py
  (sklearn median-impute→scale→LogisticRegression, report-grouped split,
  top-k metrics, pickled artifacts in artifacts/ + model_versions rows),
  shadow.py (top-3 shadow selection + shadow ARV = mean selected $/sqft ×
  subject sqft, stored per model version), cli.py (init-db / ingest /
  train / shadow / dataset / status).
- `GET /v1/ml/ideal-reports` (apps/api/src/routes/ml-export.ts): API-key
  auth via existing v1 middleware; caller-scoped validated reports with
  full response JSON; cursor = `createdAt~id`, limit ≤50.
- Labels are trustworthy: manual comp edits rewrite full_response_json
  (user-reports.ts comp route) before stamping.
- Deps: numpy 2.5.3, scikit-learn 1.9.1, pytest 9.1.1 — pinned, own venv
  at services/ml/.venv. Run: `PYTHONPATH=src .venv/bin/python -m cdarv …`.

Verified: 27/27 pytest pass; 16/16 api regression files pass (new
ml-export.test.ts covers pagination/validated-only/scoping/bad cursor);
apps/api tsc clean; CLI smoke (init-db/status) ok.

Next when data flows: `ingest --source api` needs a prod fs_ key; then
train → shadow on real validated reports (164-address batch output is
the expected corpus). Known gap: staging/deploy scheduling of the ingest
job not wired — run manually for now.

### 2026-09-20 — Jev comp price classifier Candidate B (feat/jev-outcome-classification, uncommitted→commit pending)

Structured-choice comp classification beside Baseline A dual-noul argmax.
Production routing UNCHANGED — Baseline A remains authoritative; Candidate B
defaults to shadow mode.

- Flags: `JEV_COMP_CLASSIFIER_V2_ENABLED` (default false → B not production),
  `JEV_COMP_CLASSIFIER_V2_SHADOW` (default on → B runs observability-only;
  `'false'` → B off entirely). `compClassifierMode(env)` → enabled|shadow|off.
- jev service: `compClassifierEligible` (shared gate: ≤0.5mi + !shouldDisable —
  hard-gate failures never reach B), `classifyCompPriceWithJev` (one Choice per
  eligible comp: ARV|AS_IS|UNIDENTIFIED; per-comp bad answers → UNIDENTIFIED;
  envelope/API/timeout → throw→rules-selection fallback), `routeCompPriceClasses`
  (disjoint Set routing; UNIDENTIFIED/missing → neither pool). Evidence is
  price-first and non-circular (percentiles vs eligible pool, transaction flags,
  flip, saleReconciled, adjustedSalePrice, ruleEvidence; NO truth scores/ARV).
- evaluation: enabled → B routes production (same downstream + empty-ARV
  fallback); shadow → B attaches `jevPriceClassification` per comp +
  `jevCompClassification` run meta (counts, disagreements vs A, tokens, latency,
  stateHashes) on the response; `jevCompTruth` records A run meta. Under v2 the
  card chips carry P(ARV)/P(AS_IS).
- tests/jev-comp-classifier.test.ts: all spec invariants — gate-before-JEV,
  disjoint pools, fail-closed on missing/malformed/unknown/timeout, flag
  matrix, dedupe, probs-never-route. 21/21 api regression files pass; tsc clean.
- scripts/ab-comp-classifier.mjs: replays saved shadow reports → coverage/
  forcing, agreement, downstream ARV/as-is deltas (production formulas), ops
  cost; labeled metrics (accuracy/contamination/calibration/Brier) only with
  --labels — no fabricated ground truth.
- docs/jev-comp-classifier-v2.md: full 20-point deliverable incl. first live
  shadow run (Breakwater: B abstained on a genuinely ambiguous comp A forced,
  resolved an A argmax tie, 269ms vs 576ms; tokens ~equal — savings is question
  count not bytes). One flagged qualitative concern: low-confidence AS_IS on a
  verified flip — labeled data will quantify.
- Recommendation: keep A in production, collect ≥20 labeled reports before
  promotion review. NOT merged/deployed.

### 2026-09-20 (b) — Abstention analysis + Stage-1 verification (still feat/jev-outcome-classification)

Shadow-only abstention instrumentation added; no routing change, no threshold
selected. B remains shadow-only, A remains production.

- JevCompPriceClass now persists per comp: class, all 3 probabilities,
  confidence, top1, top2, margin (top1−top2). Parser computes them; dashboard
  type mirrored. Verified live on a fresh run.
- scripts/ab-comp-classifier.mjs extended: low-confidence forced rate, top-two
  margin distribution, per-comp decisiveness table, accuracy-by-confidence-band
  and accuracy-by-margin-band (labeled), coverage/contamination sweeps under
  candidate conf/margin abstention thresholds — contamination cells populate
  when labels exist. A-side argmax corrected: STRICT > both ways → exact ties
  enter NEITHER pool (was wrongly modeled as ties→AS_IS). ARV estimate now
  mirrors the arv_condition_gate prune (verified via 'excluded from ARV' in
  stored curbAppeal summaries).
- Discovered downstream stage documented: arv_condition_gate prunes verified
  below-ARV-spec comps from the ARV set post-Jev and recomputes (production
  Breakwater ARV $430,942 reproduced exactly by the harness).
- CASS ST regression forensic complete: B saw 0.2 price percentile + a
  +41.6%/125d flip — conflicting → AS_IS 0.45/ARV 0.38/UNID 0.17, conf 0.17,
  margin 0.07. Every candidate abstention threshold (conf≥0.2, margin≥0.1)
  removes it from the AS-IS pool. Production's own condition gate had already
  pruned it from ARV (vision 'dated').
- Live corpus now 2 reports/18 eligible comps: B forced rate 88.9% vs A 94.4%,
  agreement 66.7%; every B-ARV pick has positive vision curb appeal.
- Stage-1 checklist verified and written into docs/jev-comp-classifier-v2.md
  §9d (flags default, shadow can't touch pools/ARV/offers/ranking/recs, JEV
  failure fails closed, all probs/conf/margin/disagreements persisted).
- 21/21 api regression files pass; tsc clean. Still NOT promoted/deployed.

### 2026-09-20 (c) — Candidate B PROMOTED to production + merge prep

User directive: ship B as the evaluation path ("materially more accurate…
fallbacks are a good thing… don't over-classify"), keep A for rollback,
prepare to merge to main, full production-readiness test first.

Shipped:
- `JEV_COMP_CLASSIFIER_V2_ENABLED = "true"` in apps/api/wrangler.toml AND
  wrangler.local.toml (dev script uses the local file — first attempt on
  wrangler.toml alone left the dev worker in shadow mode).
- Live enabled-path verified (fresh Sarasota analysis): mode "enabled",
  jevCompTruth absent (A skipped, no double spend), 5 ARV / 3 AS_IS /
  4 UNIDENTIFIED of 12 eligible; 3 gate-fails never classified (B=null);
  UNIDENTIFIED comps have no compGroup + enabled=false. Production ARV
  $525,059 reproduced exactly as mean(adjustedSalePrice ?? salePrice) over
  B's 5-comp ARV pool. Recommendation computed downstream normally.
- Rollback = set flag "false" + redeploy; A's code path untouched.

Merge prep:
- origin/main advanced with 4252bd5 (squash of the polling work, PR #7 —
  same feature, different hash). Merged origin/main → feat branch (56a38f2).
- ort auto-merge produced a DUPLICATE /jobs/:jobId route (ours + upstream's).
  Resolved: kept our handler (richer processing payload, saved-report
  fallback for evicted DOs, userId-scoped report query) and ported
  upstream's two fixes — strict ownership (live job state with no owner
  never passes) and the error-vs-complete status correction
  (evaluation_complete event is the only reliable success marker; a
  'complete' status + error event and no eval_complete → 'error').
- Upstream's Sidebar.tsx stale eslint-disable removal came along cleanly.
- docs/jev-comp-classifier-v2.md §11 rewritten: historical shadow-stage
  recommendation preserved; current decision = B is production.

Readiness evidence:
- tsc --noEmit clean (api, post-merge) — dashboard previously clean.
- 21/21 api regression files pass post-merge.
- git status: analyze.ts merge fix + 2 wrangler flag changes + regenerated
  dashboard tsbuildinfo (tracked file) — commit pending.

Remaining:
- Commit the above; report ready-for-merge to user; merge ONLY on
  explicit user OK. No deploy performed or authorized.

### 2026-09-20 (d) — Post-merge repo audit (main @ 17bcf51)

Systematic sweep of apps/api (122 ts files, 41k LOC) + dashboard lib.
Removals NOT applied — findings only.

DEAD CODE (verified zero/ghost-only references):
- services/core/ (832 LOC) — provider interfaces + observability infra,
  zero importers.
- services/neighbourhood/ (397 LOC) — ATTOM community/schools/POI fetcher;
  both real callers (analysis-job.ts:556, webhooks/ghl.ts:281) hardcode
  neighbourhood:false. comp-selection's enrichmentOptions:{} never fetches.
- services/vision/scoring/ (305 LOC) — barrel re-export, zero importers.
- services/evaluation/filter-suggestions.ts (212 LOC) — zero refs incl tests.
- services/evaluation/condition-evidence.ts (93) + physical-evidence.ts (88)
  — referenced ONLY by their own tests (test-shadowed dead code).
- dashboard lib/fastapi-bridge.ts (214) + fastapi-config.ts (31) +
  fastapi-integration-example.ts (94) — dead V4-era FastAPI bridge.
- dashboard lib/merge-utils.ts — zero importers.
- types.ts: 7 dead V4_* env vars (LOCAL_BRIDGE_URL/TOKEN, HOSTED_API_URL,
  HOSTED_USER_CREDENTIALS, SNAPSHOT_ACTIVE_KEY_ID, SNAPSHOT_KEYS,
  SNAPSHOT_LEGACY_KEYS). Only V4_STAGING_ASSETS_ENABLED still read
  (report-assets.ts).
- middleware/auth.ts + routes/user.ts: identical hashApiKey duplicated.

ACCURACY (high severity):
- THREE ARV computations, two formulas: pipeline AppraisalService.
  calculateARV = raw mean(adjustedSalePrice ?? salePrice); server
  recalculateReport + dashboard lib/recalc shared calculateARV =
  sqft-scaled mean(adjustedPrice/compSqft)*subjectSqft (mean fallback).
  Same data → different ARV after any recalc. Silent formula switch.
- dashboard lib/recalc bypasses Candidate B: never reads
  jevPriceClassification; when filters changed, isEnabled=passesHard
  resurrects UNIDENTIFIED comps; compGroup==null gets price-threshold
  filled; and its ARV pool = all isEnabled (ARV+AS_IS buckets both
  isEnabled=true) vs server pool = selectedCompIds (ARV bucket only).
- OPENROUTER_MODEL env var overrides ALL task model defaults
  (llm/index.ts:80, analyzer.ts:327, renovation.ts:251/402). Stale
  google/gemini-2.0-flash-001 (no endpoints → 404) was in local .dev.vars;
  VERIFY PROD SECRET — if set there, all vision/LLM calls have been
  silently failing to fallback paths.

HIGH-VOLUME READINESS:
- ATTOM attomFetch: NO AbortSignal timeout — hung fallback stalls job.
- OpenRouter provider fetch (llm/openai-compatible.ts:138): NO timeout at
  any layer — vision/comp-analysis calls can hang indefinitely. (Jev
  service itself has 20s AbortSignal — good.)
- Single-analysis DO has no stall watchdog (batch DO has 180s cap + 45s
  stall detection; single job relies on SSE client patience).
- authMiddleware (all /v1/*): captureResponseBody reads ENTIRE response
  into memory to truncate at 50KB for api_usage_logs, plus a blocking D1
  insert per request. Move insert to ctx.waitUntil; cap body read.
- Good: DO responses consumed everywhere; KV caching on property/comps/
  permits/flood; comp enrichment concurrency-batched (10) + 100ms pacing;
  CoreLogic 10s token / 20s call timeouts + key rotation; Firecrawl DO
  concurrency cap; ChunkedJobState for DO event storage.

STALE DOCS: CLAUDE.md documents a Cloudflare Workflow + ANALYSIS_WORKFLOW
binding that doesn't exist (no workflows/ dir, no binding) — pipeline runs
in the analysis route+DO.

### 2026-09-20 (e) — Post-merge hardening shipped + PRODUCTION DEPLOYED

Branch chore/post-merge-hardening → main → pushed origin/main (f103ea2).
Deploy run 35483972348: API 42s ✓, dashboard 1m18s ✓. Post-deploy smoke:
api.flowstate.homes/health 200, flowstate.homes 200.

Applied (26 files, +258/−2,177):
- Deleted: services/core/{index,observability}.ts (types.ts KEPT — live
  import via llm/types.ts + zillow/types.ts relative paths), services/
  neighbourhood/ (fetcher + EnrichmentOptions.neighbourhood + callers'
  literals + neighbourhoodKey/TTL/prefix; NeighbourhoodData types moved
  into property-api/types.ts for 7-day KV cache compat), services/vision/
  scoring/, evaluation/{filter-suggestions,condition-evidence,
  physical-evidence}.ts + their 2 tests, dashboard lib/fastapi-*.ts +
  merge-utils.ts, 7 dead V4_* Env vars, duplicate hashApiKey.
- ATTOM attomFetch: 20s AbortSignal (was unbounded).
- authMiddleware: usage-log body capture + insert → ctx.waitUntil on both
  dashboard + api-key paths (quota UPDATE stays synchronous).
- CLAUDE.md: stale Workflow section → real AnalysisJobDO pipeline.
- WITHDRAWN finding: OpenRouter fetch already bounded —
  BaseLLMProvider.createFetchOptions wires this.timeout=60s.

Verified: tsc api+dashboard clean, 19/19 regression files pass
(post-deletion count), CI typecheck+deploy green.

Still open (need product-engineer decisions, NOT bugs of this commit):
- ARV formula split: pipeline raw mean vs recalc sqft-scaled — pick one.
- lib/recalc bypasses B classification (resurrects UNIDENTIFIED, pools
  ARV+AS_IS into client ARV) — consolidate on server recalc or port rules.
- Verify prod OPENROUTER_MODEL secret isn't stale gemini-2.0-flash-001.
- Single-analysis DO has no stall watchdog (batch DO does).
- services/neighbourhood removal means ATTOM key still provisioned but
  neighbourhood endpoint unused — can rotate/de-scope the key if desired.


## 2026-09-20 — Classifier reverted to Baseline A (shadow B), TYPESAFE key provisioned

- Found TYPESAFE_API_KEY absent from prod secrets (had only ever existed in
  .dev.vars) — every prod analysis to date ran rules-only; jevOutcome card
  showed "not configured". Uploaded via `wrangler secret put`.
- User directed rollback: JEV_COMP_CLASSIFIER_V2_ENABLED flipped to "false" on
  main (ad810ba), deployed — Baseline A nouls route pools, B records in
  shadow. Runtime-equivalent to 8b8d37d while retaining polling + hardening.
- Diagnosed gate starvation: eligibility = distance <=0.5mi AND no
  shouldDisable. Orlando presets (subdivision_match non-soft + fragmented
  subdivision data) yielded eligibleCount 0 of 51 comps; Dot Ln would give 1
  of 25. Rules fallback then let an $18M mispriced comp drive ARV to $19.1M.
  Reproduces identically under A — orthogonal to the A/B decision.
- Open decisions unchanged: gate starvation policy (widen radius when
  eligible < N?), outlier guard for absurd $/sqft comps, ARV formula split,
  client recalc diverging from server, prod OPENROUTER_MODEL check,
  single-analysis watchdog.
- Unmerged branch fix/landing-remove-insights-admin: landing Insights removal
  + Admin footer login + force-fresh "New Analysis" (skipCache on explicit
  re-run — 21d eval cache was returning stale reports).

## 2026-09-20 — Landing page v2 + deal-form email delivery fixed

Branch feat/landing-admin-footer (not merged): 8333a4a + d78bb45 + 0d8a862
- Landing: Insights section removed (insights.flowstate.homes was erroring),
  hero secondary CTA now scrolls to #process, Contact renumbered 04.
- Header login removed → footer Admin button bottom-right (ml-auto),
  same openPortal behavior (signed-in → /dashboard, else sign-in modal).
- Header nav links → burger menu (right side, all breakpoints) opening
  right-side Sheet slide-over; scroll-spy preserved.
- Deal form transport: MailChannels dead (401 — free Workers API sunset),
  replaced with Fastmail JMAP (Email/set + EmailSubmission; draft created
  in Sent mailbox for audit trail). hello@ is hosted on Fastmail → SPF/DKIM
  native. FASTMAIL_API_TOKEN set on flowstate-dashboard worker + .env.local.
- Verified live: JMAP send confirmed via Email/query on Sent mailbox —
  "Deal submission: 456 JMAP Verify Ave" → hello@flowstate.homes 18:44.
  Waitlist backstop + honeypot + DEAL_SUBMISSION log unchanged.
- KNOWN: same dead MailChannels path backs password-reset emails in
  apps/api/src/lib/auth.ts — still broken pending same JMAP port (needs
  FASTMAIL_API_TOKEN on the API worker too).
- Prior shadow-valuation work reverted by user in worktree; preserved on
  feat/jev-shadow-valuation (2a17ce3).

## 2026-09-20 — Password-reset emails ported to Fastmail JMAP

Branch feat/landing-admin-footer (not merged).
- apps/api: SmtpConfig + dead MailChannels send path deleted; lib/auth.ts now
  calls shared lib/jmap.ts sendEmailViaJmap (EmailConfig {token,from}).
  Env: FASTMAIL_API_TOKEN + optional AUTH_EMAIL_FROM replace SMTP_*.
  Reset URL/token is no longer logged (old fallback printed full HTML).
- FASTMAIL_API_TOKEN added to apps/api/.dev.vars and uploaded as a secret on
  flowstate-api prod worker (secret upload only — no code deploy yet).
- Verified: api+dashboard tsc clean, 19/19 api test files pass, live local
  wrangler dev (:8794) POST /auth/request-password-reset → 200, and JMAP
  Email/query on Sent mailbox shows "Reset your Flowstate password" →
  hello@flowstate.homes at 18:53.
- Note: local .dev.vars DASHBOARD_URL=http://localhost:3012 — reset
  redirectTo must use that origin locally or Better Auth 403s
  (INVALID_REDIRECT_URL).
- Also fixed a latent TS error in dashboard deal route (res.json() unknown)
  so dashboard typecheck is clean again.

## 2026-09-20 — SHIPPED: landing v2 + Fastmail email (main 0c541fc)

feat/landing-admin-footer fast-forwarded to main (ad810ba..0c541fc, 8
commits), deploy run 35543595525 green (API 43s, dashboard 1m24s).
- Landing live: Insights removed, header nav → full-bleed index-style menu
  (mono 01–04 labels, hairlines, morphing 2-bar burger), footer
  "Operator Login" inline after Terms of Service.
- Contact form live on Fastmail JMAP: prod POST /api/deal → email confirmed
  in Sent ("789 Production Verify Blvd" → hello@ 19:07 ET).
- Password reset now sends via JMAP in prod (secret pre-provisioned).
- Prod smoke: api /health 200, flowstate.homes 200 with new markup.
- Branch state: fix/landing-remove-insights-admin still holds the unmerged
  force-fresh "New Analysis" skipCache fix (6d0fa22) — cherry-pick if wanted.
  feat/jev-shadow-valuation (2a17ce3) preserved, unmerged.

Last handoff: nothing in flight. Next candidates: merge the skipCache
re-run fix; open decisions unchanged (gate starvation, outlier guard, ARV
formula split, client recalc vs B, OPENROUTER_MODEL check, DO watchdog).

## 2026-09-20 — SHIPPED: "New Analysis" force-fresh + B shadow valuation UI (main 1a3c23f)

- User reported B shadow not visible in UI: root cause — JevShadowValuationCard
  + counterfactual valuation (2a17ce3) lived only on feat/jev-shadow-valuation
  and had been reverted from the worktree; never merged. API on main was
  emitting shadow counts but dashboard rendered nothing.
- Cherry-picked 6d0fa22 (New Analysis → skipCache:true) and 2a17ce3 (shadow
  counterfactual + card) onto main via feat/rerun-and-shadow-ui; deploy run
  35544499947 green. Prod api/dashboard 200.
- Live local verification (Anchor Way, shadow mode): steps include
  jev_v2_shadow + jev_v2_shadow_valuation; shadowValuation present
  (ARV 650,000 / as-is 339,513 / buy 454,150 / ROI 11.2 / hold), deltas 0 vs
  A on this run (1 ARV + 1 AS_IS of 2 eligible, 0 disagreements).
  NOTE: eligibleCount was 2 here vs 8 in the earlier jev-classify worktree
  run — different local D1 preset/data; not a code regression.
- Card renders only when jevCompClassification.shadowValuation exists — i.e.
  shadow mode + status completed + eligibleCount > 0. Zero-eligible markets
  (Orlando gate starvation) will show no card by design.

Last handoff: nothing in flight. Open decisions unchanged.
