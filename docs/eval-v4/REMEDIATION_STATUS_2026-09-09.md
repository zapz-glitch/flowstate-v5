# Readiness remediation status

Update September9: Docker access restored. Full isolated Python/PostgreSQL suite
now passes342tests (27deprecation warnings); one stale API assertion now correctly
checks preliminary REVIEW_REQUIRED output without changing evaluation policy.
Pinned Python Docker build passes. Owner chose PostgreSQL for Python only and
Cloudflare/Render staging; see STAGING_SETUP.md and render.staging.yaml. YAML and
local isolation checks pass, but remote provisioning, hosted adapter and staging
app/storage verification remain pending. No paid resources or deployments made.
The Docker blocker below is historical and superseded by this verification.

The owner authorized execution after the PR review. Local code/security/CI fixes
are implemented. Production rollout is **not approved or verified**. Main remains
16f879adcd6b93a7daad815ea6efdde56c874b91; no production credentials were rotated.

## Completed

1. **Deployment isolation.** Default wrangler.toml again uses production environment
   and dashboard origin, with no local-only R2 binding. Local development explicitly
   uses wrangler.local.toml and --local. Production API bundle dry-run passed and
   displayed only production bindings. A regression protects this split.
2. **Authoritative reset.** Valid insufficient-comp responses clear dollar values
   and adopt the saved revision atomically. Malformed/stale responses are rejected.
   Live browser test on Northlake job_1788965532465_ay4jwomw: manual selection
   revision1, null reset revision2, reload/add revision3, final null reset revision4.
   No new provider evaluation was run. Artifact: .data/local-candidate/reset-null-remediation.json.
3. **Sale-date consistency.** Comparable reports use frozen canonical sale date and
   price together, including provider-detail fallback. Regression passes.
4. **Request bounds.** Durable Python /v1/ POSTs authenticate before reading bodies
   and enforce2MiB streamed limits with missing/false Content-Length. Exact raw bytes
   remain available downstream.13 new boundary tests pass.
5. **Signing-key lifecycle.** New snapshots use versioned signatures with key IDs,
   separate from bridge authentication. Verification accepts retained old signing
   keys; pre-versioned snapshots require explicit legacy verification keys. Local
   setup preserves old signatures without rotating transport/provider credentials.
   Cache precedence and dotenv JSON encoding regressions were found and fixed during
   independent review/browser testing. Local browser proves old -> new signing works.
6. **Assets.** Existing exact-report share cookies now authorize photos only while
   sharing remains enabled. Owner/cross-owner/wrong-job/expired/private tests pass.
   Authorized report deletion removes only its validated storage prefix before the
   DB row. Storage failure retains the report and returns retryable503; some assets
   may already be removed, so retry is idempotent. No live assets were deleted.
7. **CI/dependencies.** Real automatically discovered API/dashboard tests replace
   the successful test echo. ESLint now runs correctness checks instead of next lint.
   Candidate CI runs all PRs, tests, lint, audits, Next/OpenNext builds, API dry-run
   and the existing Python/database checks. Unused MapLibre removed; sharp/esbuild
   dependency paths patched. Full npm audit reports zero vulnerabilities.

## Verification

- Clean npm ci in /tmp/flowstate-remediation-verify.6EWkpV/repo passes, audit0.
- Clean hash-locked Python install passes in separate disposable virtualenv.
- 196 core/contract/staged/bridge/request-boundary Python tests pass using that env.
- All18 API regression files and4 dashboard regression files pass, alongside
  workspace typechecks, lint and the secret-pattern scan.
- Production Next webpack build and full OpenNext Cloudflare bundle build pass in
  the disposable copy. API production dry-run passes. Nothing was deployed.
- Independent review of signing/configuration/CI fixes passes. Browser manual/reset
  regression passes against the actual saved Northlake report.
- Python advisory scan: no known vulnerabilities after updating the disposable
  environment's pip24 installer to26.2. Application lock packages had no findings.
  CI/container bootstrap now pins pip26.2 by its downloaded universal-wheel hash;
  container execution itself still awaits Docker access.

## Signing configuration and rotation

Runtime secrets: V4_SNAPSHOT_ACTIVE_KEY_ID, V4_SNAPSHOT_KEYS (JSON ID-to-key map),
V4_SNAPSHOT_LEGACY_KEYS (JSON array for pre-versioned signatures). Maximum8 entries
per key collection, minimum32 characters per key. Do not reuse bridge/API keys for
new signing. Keep prior verification keys when adding a new active ID; removing a
key intentionally revokes recalculation of reports signed with it.

For local setup, node scripts/local-candidate.mjs configure-snapshots validates the
explicit current configuration, then saves it. Cached configuration never overrides
an explicit valid current keyring. --from-saved-keys is an explicit recovery option,
not an automatic fallback. JSON-valued dotenv entries use single quotes so both Node
and Wrangler preserve JSON exactly. Key files/backups stay ignored with0600 permissions.

## Remaining gates, in order

- **Staging target and access:** owner must identify non-production Python hosting,
  PostgreSQL, storage/worker bindings and credential references. No arbitrary hosting
  account was selected and no production-only safeguards were removed. The tested
  application still uses the loopback development bridge until staging transport,
  authentication, health/failure paths and rollback have been integrated and tested.
- **Docker/database:** Docker Desktop WSL integration is unavailable. Full isolated
  PostgreSQL migration/worker/rollback tests remain blocked; earlier full run had
  107 setup errors, not a green suite. Enable the isolated harness environment or
  run the prepared workflow in a trusted CI environment.
- **Asset orphan retention:** no automatic destructive sweep was added. Choose a
  retention/grace-period policy, then implement dry-run inventory and scheduled
  cleanup for failed-save/abandoned assets. Normal report deletion is implemented.
- **Remote gates/PR:** CI files are updated locally; GitHub required-check settings
  and successful remote CI are not configured/verified. No commit, push, PR, merge
  or deployment was performed during this pass. Release remains gated on the above
  checks; owner app approval boxes remain open.
- Older-sale/radius policy, permit-to-system-age mapping, comparable hazards and
  throughput certification remain separate unfinished work.

Resume with the staging environment choice and Docker access, not by removing the
local-only guards. Local API runs via npm run dev -w @flowstate-api/api (session9996);
dashboard3004 and Python8788 remain available.
