# V4 staging setup

Status: staging app deployed; production release and owner acceptance pending.
Staging app is now deployed and agent-tested; owner acceptance is still required.
Dashboard: https://staging.flowstate.homes (versionab63b044-ec93-4b9b-8186-3b849633bed8).
API: https://api.staging.flowstate.homes (version06165426-6113-4523-81c8-77c50dcf2e17).
Separate D1:13de78d5-6d02-452a-9101-82cfff4299ed; all23 migrations applied.
Separate KV:1846bfcab8444b198a38a5fd068f8550; R2:flowstate-v4-staging-report-assets.
New staging Durable Objects use SQLite namespaces compatible with the free plan.
Custom-domain TLS initially failed during activation, then recovered without bypass.
Actual browser login survives reload; no production API traffic was observed.
Real staging userV7yMtWoR4tAHQo1b9D71Nb9KEb90bdXP now owns the Render queue scope;
synthetic canary credential was removed. Login/password are in the ignored0600 file
`.data/local-candidate/staging-login.json`. Do not print or commit credentials.

### Hosted app verification

| Property | Saved job | Displayed ARV | Buy price | Selected comps |
| --- | --- | ---: | ---: | ---: |
| 3 Heritage Cove Ct | job_1788994136273_ef2zqvpq | $374,000 | $247,000 | 1 |
| 4648 Piedmont Ct | job_1788994233197_armyzrcs | $317,000 | $198,000 | 2 |
| 16049 Magnolia Hill St | job_1788994366613_45jvwspt | $384,000 | $246,000 | 1 |

All saved reports explicitly use python-v4/provider_authoritative_upper_half_v2
and remain REVIEW_REQUIRED/preliminary, including honest missing-style/hazard
limitations. Heritage has9 permit records/6 assets; Piedmont2 permits/3 assets.
Magnolia has9 permit records/6 assets. Heritage/Piedmont PDFs downloaded.
Piedmont browser Remove from ARV recalculated
to314000; Reset restored original exact ARV and saved revision2. Asset owner200
versus unauthenticated401; comp edits reject missing auth401, wrong Origin403,
stale revision409. No owner approval has been inferred from these automated tests.

The hosted adapter needed a Cloudflare compatibility fix: redirect:error is not
supported at the edge. It now uses manual and rejects non-success responses;
tests prove301/302/303/307/308 are not followed.21 API/4 dashboard regressions and
API types pass. No legacy evaluation fallback or appraisal rule changes were made.
Remaining readiness work: durable job-state hydration/restart recovery (the DO
persists jobState but /state reads memory only), failure/restore/rollback checks,
and owner browser acceptance. Maps remain unconfigured as previously deferred.

PostgreSQL `dpg-dagsfppt0dsc73fjgbo0-a` is available (17, Virginia,5GB,
0.1c-256mb, public allowlist empty). Python API `srv-dagsi5uk1f9s73dp1s40`
has been created at https://flowstate-v4-staging-python.onrender.com.
API and worker are live at candidate `9ba02f3`. Worker ID:
`srv-dagsn3uk1f9s73dpllfg`. HTTPS readiness returns database/schema ok.
Initial deployment exposed bare PostgreSQL URL handling in Alembic and health;
both now normalize to psycopg3. Full final local Python suite353pass.
Hosted synthetic canary passed exact ARV parity with local Python: automatic
550000 using comps3/2, manual450000 using3/0, reset550000, insufficient null.
All four submissions replay the original evaluation IDs. Missing authentication
returns401; unknown evaluation404; returned tenant/user match canary credentials.
These are synthetic backend tests, not real-address/browser/app acceptance.
GitHub candidate CI run34405245843 passed for the exact deployed commit9ba02f3,
including application regressions, types/lint, dependency audit, Next/OpenNext
builds, API dry-run and Python checks. No production workflow was triggered.
Initial transport identity is `staging-infrastructure-canary`, deliberately not
an app account. Add real staging D1-user credentials before app testing.
Provisioning helper: `/tmp/flowstate-render-stage.mjs`; canary helper:
`/tmp/flowstate-render-canary.py`. Local canary credential is Git-ignored and0600
at `.data/local-candidate/render-staging-canary.json`; never print or commit it.
Hosted transport now passes local HTTP integration against the real durable
Python API, PostgreSQL and supervised worker. Full Python suite:350pass. Hosted
TLS, real Render restart behavior, DNS and browser staging login remain unverified.
Target workspace: Flowstate (`tea-dagodvek1f9s73dp4it0`). Keep Starter build
pipeline; no Pro workspace upgrade required for the proposed foundation.
The owner selected PostgreSQL for Python first. Existing application users,
authentication and reports stay on D1. Main and production remain untouched.

## Infrastructure foundation

`render.staging.yaml` defines the Python durable API, one owner-scoped worker,
and a separate PostgreSQL 17 database. Defaults are small paid instances in
Virginia, manual deploys, no public database access, no live provider calls.
Confirm workspace, pricing and repository access before importing this file.
Automatic deploys being off does not prevent the initial Blueprint deployment.
Do not import until the integration gates below are resolved.

Blueprint fields follow the [Render reference](https://render.com/docs/blueprint-spec).
Remote validation, provisioning and backup/restore verification remain pending.
The worker may start before the API migration on first deployment; verify schema
readiness and explicitly restart it after migrations if its startup fails.

Supply secrets through the hosting secret controls, never Git or chat:

- `V4_API_CREDENTIALS`: hashed credential records for tenant
  `flowstate-v4-staging` and the explicitly chosen staging user.
- `V4_WORKER_USER`: that same authorized staging user, not a production user.
- Independent Cloudflare session, snapshot-signing and Python transport secrets.
- `V4_HOSTED_USER_CREDENTIALS` on the staging Cloudflare API: JSON object keyed
  by the authenticated D1 user ID, each value containing `token` and `tenantId`.
  The corresponding Python hashed credential must authorize that same user ID.
  There is no shared/default-user fallback. Provision an owner-scoped worker for
  each enabled staging tester; the initial blueprint defines only one worker.

Proposed staging domains are `staging.flowstate.homes` (dashboard) and
`api.staging.flowstate.homes` (API). Auth uses a separate cookie prefix and
`.staging.flowstate.homes` cookie domain. Default production/local auth is retained.
The API example config deliberately has unresolved D1/KV IDs: replace them only
with newly provisioned staging resources. The dashboard has its own staging
Wrangler config. Build NEXT_PUBLIC_API_URL with the staging API origin; setting
only a runtime variable cannot replace a production URL already in the JS bundle.

## Required integration before app testing

Completed prerequisite: queued requests now preserve selected_comp_ids through
both application and supervised-worker execution. Null/omitted remains automatic
selection; invalid duplicate/blank/empty selections fail validation before writes.
Verified347 full-suite tests plus2 supervised-worker tests separately.

- Create separate Cloudflare staging dashboard/API, D1, KV, Durable Objects and
  private R2 bindings. Do not deploy `wrangler.local.toml`: its IDs are for local
  emulation, not a safe remote staging configuration.
- Verify the implemented hosted adapter on Render: HTTPS-only origin, per-user
  credentials, content/job/user-derived idempotency, preloaded frozen evidence,
  bounded20second polling, returned tenant/user/job checks and no legacy fallback.
  Timeout does not cancel the committed durable job; repeating the same frozen
  request reuses it. The `/evaluate` development bridge remains localhost-only.
- Keep preloaded evidence for initial durable tests. The worker currently refuses
  live-provider mode without a provider adapter and serves one tenant/user scope;
  this is not yet a general multi-user hosted evaluation deployment.
- Verify staged assets with actual private R2. Staging persistence now requires
  V4_STAGING_ASSETS_ENABLED=true plus the bucket binding. Existing owner/share
  authorization stays intact and production persistence remains blocked.
- Verify login, the agreed real addresses, saved reports, manual selection/reset,
  photos and PDF against staging. Test unauthorized access, timeouts, retries,
  worker restart, restore and rollback; require owner app approval before release.
- Compose build defects repaired: API Dockerfile added, complete npm workspaces
  copied, Node22 images pinned, API host port separated as V4_TS_API_PORT.
  Full Compose app wiring is still not verified: local D1 migrations/accounts,
  dashboard server-side API addressing and the evaluation transport need a full
  startup/browser pass. Existing host-based app remains unchanged.

## Docker context security verification

Container inspection caught nested `apps/api/.dev.vars` inclusion after adding
the API workspace to the dev images. Root-only ignore patterns did not protect
nested credentials or generated caches. Both affected images created in that pass
were removed by exact image ID; their seven source/layer cache records were removed
by exact cache ID and absence verified. No images were pushed or services restarted.
Recursive exclusions now cover nested env/dev-vars files and generated directories;
both Dockerfiles check credential-file absence before installing dependencies.
This cleanup removed generated images/cache only, not source credentials or volumes.
Corrected API/dashboard images both rebuild successfully with npm audit0. The API
image passes a network-disabled, non-root credential-absence check and actual
Wrangler startup/HTTP health smoke test, without publishing ports. All21 API and
4 dashboard regression files pass. Full Compose login/evaluation remains pending.
The database harness now uses the same pinned PostgreSQL17 image as CI/Compose:
350 full-suite tests pass, plus a separate new server-major-version assertion.

## Local verification commands

From `services/eval-engine`, with locked dependencies installed:

```sh
PYTHONPATH=src python -m pytest tests -q
```

The harness only uses loopback ports 55440/55441 and cleans up its owned
disposable databases/containers. Never substitute a production database URL.
From the repository root:

```sh
docker build -t flowstate-v4-staging-check:local services/eval-engine
```

The owner approved the paid staging foundation. Only staging resources have
been created; production migrations and production key rotation are out of scope.
