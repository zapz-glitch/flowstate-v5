# Flowstate v5 engineering state

## Current objective

Review and verify the V4 Python evaluator, then replace backend evaluation on
`v4-python` only after replacement tests pass. Use production main as the
application baseline. Review dependencies and rotate service credentials for
production-like candidate testing. Preserve main and all UI code.

## Baselines

- Repository: zapz-glitch/flowstate-v5
- Main: 16f879a (must remain unchanged).
- V4 candidate: ab317a5, tracking origin/v4-python.
- Existing separate API V4 checkout has a user-modified package-lock.json;
  leave that checkout untouched.
- User selected antislop during work for comments and documentation.

## Active

- V5-06: final independent QA and SOL review of the preparatory package.

## Queued

- V5-04: repair replacement blockers, then verify the backend integration.
- V5-05: isolated runtime and application verification with unchanged UI.
- V5-06: independent QA and SOL review; candidate branch handoff.

## Completed

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

## Findings and blockers

- Live provider and authenticated legacy-contract adapter are missing.
- Browser recalculation overrides backend financial results. User permission
  for nonvisual client data handling was requested and remains pending.
- Saved 501000 tiers conflict with V4 500000 boundaries; migration must not
  silently alter operator settings. Investor policy approval remains a gate.
- Service administration access/secure replacement secrets were requested and
  remain pending. No credentials were rotated, revoked, copied, or exposed by
  the implementation. No live provider verification occurred.
- Full Compose has missing API-worker Dockerfile, port variable collision,
  container-loopback URL, and project isolation issues. No application runtime
  or browser regression claim is supported.
- SOL review: preparatory guard/CI changes eligible for QA; evaluator
  replacement CHANGES_REQUIRED. The old evaluator remains active.

## Definition of done

- Python methodology and authenticated application routes verified.
- Existing application response contracts preserved without UI edits.
- Dependency installation, relevant tests, build and isolated DB checks pass.
- Service credential rotation and bounded live verification have evidence.
- Independent QA and SOL review complete; any external blockers disclosed.
- Main remains at its baseline; all changes reside on the V4 candidate.

## Last handoff

2026-09-08: Foundation verified and dependencies repaired on v4-python only.
Resume after confirming nonvisual browser data-flow scope and secure provider
administration access. Implement evidence/settings/response adapters and runtime
repairs, verify authenticated end-to-end candidate behavior, then reconsider
replacement. No push, deployment, or production-main update has occurred.
