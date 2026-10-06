# V4 PR and production-readiness review

Subsequent remediation is tracked in REMEDIATION_STATUS_2026-09-09.md. Findings
below preserve the original review evidence; they are not all still unfixed.

Verdict: **request changes; not ready to merge or deploy as the production evaluator.**

Reviewed September 9, 2026. This is an analysis, not authorization to change main,
deploy, rotate credentials or close owner acceptance tasks. No implementation fixes
were made during this review. Documentation and generated diagnostic artifacts only.

## Reviewed revision and main compatibility

- Live GitHub main: `16f879adcd6b93a7daad815ea6efdde56c874b91`.
- Local main is identical and is an ancestor of candidate HEAD
  `9a3c7788e63d2c6e99f9fa7772100d3cd6576608`.
- Remote v4-python: `ab317a503e668b89727d46f06942fd1442a816ba`; local HEAD is four
  commits ahead. At review start, 50 tracked files were modified and 45 files
  untracked. Those working-tree changes were included in this review, but are not
  represented by a remote PR or commit. A PR of the current remote branch would
  not contain the tested local implementation.
- GitHub reports no open PRs. This is a candidate readiness review, not an approval
  of an existing PR. No branch checkout, merge, push or deployment was performed.
- Git ancestry is compatible; runtime/configuration compatibility is not. No
  tracked D1 migration/shared-package delta versus main was found. Separate Python
  PostgreSQL migrations exist, but their execution/rollback was not verified here.

## Findings

### P1: Default deployment configuration contains local-only settings

`apps/api/wrangler.toml:11-12` changes main's production environment and real
dashboard origin to development and localhost:3004. Lines25-27 add a global R2
binding for `flowstate-v4-local-report-assets`. Main's deployment workflow uses
bare `wrangler deploy` (`.github/workflows/deploy.yml:38`). Merging this configuration
would deploy local settings against the production worker, breaking production
origin/auth behavior and potentially failing on an unprovisioned bucket.

Required: isolate local configuration; dry-run and inspect the actual production
manifest/bindings before merging. Do not deploy the candidate file as-is.

### P1: Reset can retain a stale dollar valuation after a successful null result

`apps/dashboard/src/hooks/use-analysis-evaluation.ts:105` rejects every response
without a valuation. But `INSUFFICIENT_COMPS` with `valuation:null` is a valid,
successfully persisted response. Reproduction using the real frozen Northlake
request, offline: select comp2330124393 -> ARV618551.7547756553; reset to automatic
selection -> INSUFFICIENT_COMPS/no ARV. The UI rejects the reset response and retains
the old approximately $619k result and revision, incorrectly claiming the previous
result is unchanged. Subsequent edits can conflict with the updated server revision.

Required: accept explicitly valid insufficient results, replace authoritative state
and revision together, and test manual-selection -> reset -> reload -> next edit.

### P1 release gate: Production cannot execute the tested Python/asset flow

`apps/api/src/services/evaluation/python.ts:284-286` requires development and a
loopback HTTP bridge. The container deploys the separate durable API, not that bridge.
With no engine flag, the dispatcher retains the legacy evaluator. Private image
persistence also refuses production (`services/report-assets.ts:59`). These are
deliberate containment measures, not controls to simply remove.

Required: authenticated production transport, worker routing, deployment/health
checks, private storage configuration, staging integration and verified rollback.

### P2: Report sale date can disagree with canonical evaluation evidence

`apps/api/src/services/evaluation/python.ts:99` maps canonical sale price but uses
the original comparable date. The supported provider-detail fallback can fill
both missing sale fields in the frozen request. Offline reproduction: detail
sale300000/date2026-08-01 with normalized sale fields null yields report price300000
but report date null, although Python weights the sale using August1.

Required: map the canonical sale date alongside its price; test detail fallback
and saved-report/PDF consistency.

### P2: Durable Python API buffers unauthenticated bodies without a cap

`services/eval-engine/src/eval_engine/main.py:45-49` reads all `/v1/*` POST bodies
before authentication. A network-reachable unauthenticated caller can cause memory
pressure with oversized bodies. Safe in-process reproduction buffered3,145,728bytes
before a simulated401; no network service was attacked. The local bridge's2MB cap
does not protect this separate durable API.

Required: authenticate before buffering where possible, enforce streamed/body-size
limits in the service and ingress, and test oversized unauthenticated requests.

### P2: Authentication-token rotation invalidates historical report signatures

`apps/api/src/services/evaluation/python.ts:277,305-307` signs and verifies frozen
reports with only the current bridge bearer token. There is no signing-key ID or
historical verification keyring. Rotating that credential makes old reports fail
recalculation with409/New Analysis. They remain viewable, but not recalculable.

Required: separate transport and report-signing keys; version signatures and test
rotation while retaining verification of earlier report snapshots.

### P2: CI does not enforce the new application regression tests

`.github/workflows/evaluation-v4-candidate.yml:82-90` typechecks and runs Python,
but omits all16 new API suites and all4 dashboard regression files. The API's
`package.json:13` test command is a successful echo; its typecheck excludes tests.
Thus green CI does not verify report ownership, frozen evidence, listing authority,
permitted recalculation, or the new permit/formatting behavior.

Required: explicit locked test tooling and commands in PR CI, production bundle
checks, dependency/security gates and required branch checks. GitHub returned
"Branch not protected" and no effective main rulesets at review time.

## Security and operational follow-up

- Production npm audit reports1critical affected package: maplibre-gl5.20.0.
  This version is already present on main, not introduced by V4. No application
  import/use was found, so exploit reachability is unproven. The official advisory
  affects <=6.4.0 and identifies6.4.1 as patched. Remove the unused dependency or
  upgrade and verify rather than blindly applying a major-version audit fix.
  Source: https://github.com/advisories/GHSA-jrc7-96c5-q579.
- Full npm audit reports9 affected package entries:1critical,4high,4moderate.
  Additional paths include development/build tooling (sharp/miniflare/wrangler/
  OpenNext and esbuild/drizzle-kit). Counts include transitive chains, not9 distinct
  independently exploitable application vulnerabilities. No audit fix was applied.
- Inspected asset and snapshot paths showed no confirmed new IDOR, auth bypass,
  credential exposure or fetch SSRF. Focused security tests pass; this is not a
  comprehensive penetration-test certification.
- Asset authorization is owner-only. Existing shared-report viewers cannot fetch
  those owner-bound photos; shared exports need scoped share authorization.
- Report deletion removes only D1 rows (`routes/user-reports.ts:445`), not the new
  R2 assets. Failed saves can also orphan assets. Define retention and cleanup.
- Current credential-pattern scan passes; it is a limited regex scan, not a full
  history or provider-account audit. Ignored local login/provider files remain
  ignored. Python advisory audit was not run because pip-audit is unavailable.
- Latest main Deploy run failed at Cloudflare API deployment; dashboard was skipped.
  API typecheck and npm install passed in that run. No detailed failure cause was
  returned by the available failed-log request. This failure predates these changes:
  https://github.com/zapz-glitch/flowstate-v5/actions/runs/34181028014.
- `npm run lint` fails because the inherited script invokes `next lint` with the
  installed Next16. Main has the same script. Repair the lint workflow separately.

## Verification

| Check | Result |
| --- | --- |
| Current GitHub main / ancestry / open PRs | Verified; no open PRs |
| Workspace typechecks | Pass |
| All16 API regression suites | Pass |
| All4 dashboard regression files | Pass |
| Full Python suite, documented service cwd | 221 passed,1 skipped,107 setup errors |
| PostgreSQL tests / migrations / rollback | Blocked: Docker WSL integration unavailable |
| Production npm audit | Fail:1critical affected package |
| Full npm audit | Fail:1critical,4high,4moderate affected package entries |
| Repository credential-pattern scanner | Pass; matched content suppressed |
| Lint | Fails inherited next lint command |
| Production-mode dashboard build | Pass: isolated copy, next build --webpack |

Python tests used the existing shared virtualenv, not a clean hashed-lock install.
The dashboard build used existing node_modules in an isolated source copy at
/tmp/flowstate-pr-review.vWQRwh; it did not overwrite the running app's .next.
This verifies Next compilation, not the OpenNext Cloudflare deployment artifact.
The first root-directory invocation had test namespace import errors; the correct
service-directory invocation resolved those and produced the results above. Docker
reports that WSL integration is unavailable; no production database was used.
Earlier five-address and latest permit browser QA remain useful local evidence,
but do not substitute for production runtime, database or capacity verification.

## Recommended order before a PR can be approved

1. Separate local and production deployment configuration.
2. Fix stale-null-reset and canonical-date defects, with regression tests.
3. Bound durable API request bodies; design signing-key rotation and asset lifecycle.
4. Wire production Python/storage in staging with failure and rollback checks.
5. Wire application tests/security/build checks into required CI; resolve advisories.
6. Run clean locked installs and isolated PostgreSQL/migration/worker suites.
7. Commit the complete reviewed file set, open a PR against current main and review
   its exact diff and CI results. Obtain owner app approval before closing MD tasks.

Older-sale/1-mile/1.5-mile expansion still awaits the sale-age cap. Permit-to-system
ages, comparable hazards and production capacity are not completed by this review.
