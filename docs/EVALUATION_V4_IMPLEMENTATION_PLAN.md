# Evaluation V4 Implementation Plan

Candidate branch: `v4/python-fast-eval`

Recorded baseline: `47e299203cd54c8ad8b1c685e8e7b75fb3a8b064`

Candidate worktree: `/home/lucke/src/flowstate-api-v4-eval`

This plan implements the owner-approved methodology in
`docs/EVALUATION_V4.md`. It does not authorize deployment, production writes,
or changes to `main`, the primary integration worktree, V3, or Flowstate V3.

## Agent verification

Verified from the effective global agent definitions on 2026-09-06:

| Alias | Effective model | Role |
|---|---|---|
| `sol-planner` | `openrouter-sol/openai/gpt-5.6-sol` | orchestration |
| `sol-reviewer` | `openrouter-sol/openai/gpt-5.6-sol` | independent review |
| `backend` | `openrouter-spark/meta/muse-spark-1.3` | backend implementation |
| `frontend` | `openrouter-spark/meta/muse-spark-1.3` | frontend implementation |
| `database` | `openrouter-spark/meta/muse-spark-1.3` | persistence |
| `devops` | `openrouter-spark/meta/muse-spark-1.3` | runtime and operations |
| `qa` | `openrouter-spark/meta/muse-spark-1.3` | independent QA |
| `spark-worker` | `openrouter-spark/meta/muse-spark-1.3` | bounded implementation |
| `astra-reviewer` | `openrouter-astra/openai/gpt-6-astra` | exceptional escalation |

Configuration and specialist handoffs in session
`ses_f87b73cc2ffettALmXiiPS7sbc` identify the expected Muse model. SOL remains
the normal planner and reviewer. Astra is used only for unresolved worker
failures, ambiguous high-risk issues, or a requested second opinion.

## Baseline assessment

| Area | KEEP | MODIFY | REPLACE | MISSING |
|---|---|---|---|---|
| Product UI | Existing routes, layout, settings tabs, reports, SSE and polling behavior | Add a thin V4 API adapter and new result fields without visual redesign | Browser-side financial authority | Baseline screenshots and V4 browser regression evidence |
| Providers | Existing CoreLogic normalization and credential references | Route all shared provider use through a real global coordinator before cutover | Isolate-local token and request pacing as quota enforcement | Shared 40 RPM and four-concurrent limiter with persisted deferrals |
| Evaluation | Existing settings names and evidence normalization | Map every setting to a typed immutable snapshot | TypeScript, browser, and LLM comp-selection authority | One Decimal Python engine, ledgers, deterministic investor cohort |
| Persistence | Existing D1 records remain intact for legacy and rollback | Add isolated V4 PostgreSQL storage and migration/import tooling | Durable Object memory as authoritative V4 job state | Jobs, batches, leases, settings snapshots, result versions, idempotency |
| Runtime | FastAPI scaffold on port 8004 and current Cloudflare app remain isolated | Harden container, health, worker supervision, candidate CI | Fire-and-forget execution | Worker process, Compose isolation, recovery and release rehearsal |
| Tests | Existing health test | Build full offline and stubbed suites | Disabled test scripts as acceptance evidence | Financial fixtures, load matrix, security, browser, bounded-live evidence |

The repository currently uses Cloudflare D1, Durable Objects, KV, and R2-era
patterns. The older engineering state describing PostgreSQL and Neon was not a
description of this checkout. V4 will use isolated PostgreSQL storage for its
durable queue and immutable audit records while legacy D1 remains unchanged.
The integration adapter will authenticate through the existing application and
send a resolved settings snapshot to FastAPI. Production cutover requires a
separate migration and authorization step.

## Shared contracts

This Markdown contract is the V4-001 draft authority. The current scaffold
Pydantic models are placeholders and must not generate a client. Accepted
Pydantic models and their OpenAPI output become the machine-readable authority
after V4-101 contract review. Money and measured decimal values cross JSON as
decimal strings, not binary floats.

### Evaluation request

- Tenant and authenticated user context supplied by the trusted adapter.
- Idempotency key scoped to tenant.
- One to 50 property requests.
- Subject evidence, comparable universe, subject permits and system evidence,
  renovation level, operator overrides, evaluation date, and immutable
  settings snapshot.
- Request payload hash stored before work starts.

### Settings snapshot

- Snapshot ID, schema version, source timestamps, and SHA-256 content hash.
- Appraisal filters and adjustments with rule ID, value, unit, enabled state,
  source, and precedence.
- Four explicit renovation tiers, five renovation levels per tier, per-square-
  foot rate, and minimum flip profit.
- Deal percentages with their calculation base, wholesale fee, display
  rounding increment and mode, and mapped Initial Offer behavior when present.
- Major Item enabled state, threshold years, cost, inclusion category, source,
  and precedence.
- No Thresholds-tab fields in V4 decision inputs.

### Comparable decision

- Stable comp ID and evidence reference.
- Eligibility status and all rule outcomes.
- ARV status: accepted, rejected, or not examined after early stop.
- Investor status: accepted, rejected, or insufficient evidence.
- Explicit reasons and limitations.

### Adjustment ledger

- Ledger entry ID, stage, target type and ID, rule ID, signed Decimal amount,
  unit, evidence, input values, and duplicate-prevention key.

### Investor cohort result

- Method version, status, eligible and selected counts, selected comp IDs,
  exclusions, observed mean, median, range, adjusted mean PPSF, indicated
  subject value, and limitations.

### Renovation item

- System ID, source, evidence date, supported age, threshold, auto/manual
  provenance, inclusion status, signed cost, and deduplication group.

### Job and batch state

- Batch and evaluation IDs, tenant, status, attempts, lease owner and expiry,
  heartbeat, next attempt, checkpoint, error code, result version, and
  timestamps.
- State transitions are compare-and-swap guarded. Result commits are unique per
  evaluation and methodology/settings version.

### Error and incomplete result

- Machine code, affected section, retriable flag, operator-facing detail,
  evidence limitations, and partial result references.
- One property failure does not fail a batch. Independent supported sections
  remain available.

## Work packages

| ID | Owner | Objective | Dependencies | Allowed paths | Acceptance and verification | Status |
|---|---|---|---|---|---|---|
| V4-001 | sol-planner | Baseline, methodology, contracts, and task board | none | `docs/**`, engineering state | Documents match owner directive; baseline and model evidence recorded | active |
| V4-101 | backend | Typed Decimal contracts and evaluation core: evidence validation, first-three ARV, ledgers, proposed investor cohort, rehab, major items, deal math, rounding | V4-001 | `services/eval-engine/src/eval_engine/contracts/**`, `domain/**`, `schemas.py`, `decision_tree.py` | Golden unit fixtures, determinism, no LLM or Firecrawl imports | queued |
| V4-102 | database | PostgreSQL models, Alembic migration, repositories, settings snapshot and durable queue semantics | V4-001 | `services/eval-engine/src/eval_engine/persistence/**`, `services/eval-engine/alembic/**`, `alembic.ini` | Migration up and down on isolated PostgreSQL, constraint and claim tests | queued |
| V4-103A | devops | Hardened image, Compose isolation, environment contract, health and candidate CI | V4-001 | `services/eval-engine/Dockerfile`, `.env.example`, root `compose*.yaml`, `scripts/runtime`, candidate CI and runtime docs | Non-root image, isolated PostgreSQL and ports, secret scan, safe runtime checks | active, uncommitted |
| V4-104 | backend | Authenticated FastAPI batch endpoints and provider-port contract | V4-101, V4-102 | `services/eval-engine/src/eval_engine/api/**`, `application/**`, `main.py` | 202 contract, test-only sync route, 1 to 50 validation, tenant isolation and idempotency tests | queued |
| V4-103B | devops | Worker supervision, persisted retries, shared provider limiter and recovery | V4-102, V4-104 | eval worker and runtime paths assigned after integration | Restart, lease expiry, Retry-After, 40 RPM and four-concurrency tests | queued |
| V4-201 | backend | Existing TypeScript API auth, settings snapshot, provider and job bridge | V4-104 | focused `apps/api/src/**` paths listed in task branch | Typecheck, auth derivation, settings mapping and no cross-tenant access | queued |
| V4-202 | frontend | Existing dashboard client and report adapter without layout changes | V4-201 | focused `apps/dashboard/src/**` paths listed in task branch | Typecheck, settings round trips, submit and poll flows, screenshot diff | queued |
| V4-301 | qa | Independent financial, settings, persistence, recovery, batch, security, and browser suite | V4-101 through V4-202 | tests and fixtures only | Offline and stubbed matrix passes on exact integrated commit | queued |
| V4-008 | sol-reviewer | Pre-QA and post-QA reviews of each accepted package and final integrated commit | each package | read-only review | READY_FOR_QA then VERIFIED, or precise repair evidence | queued |
| V4-009 | astra-reviewer | Exceptional escalation only | two failed repair rounds or high-risk ambiguity | read-only review | Independent root-cause verdict and bounded repair instructions | conditional |
| V4-010 | qa and sol-reviewer | Bounded real-provider side-by-side proof | V4-301 and credentials or access | candidate only | One supported stored result and one honest incomplete result, calls and latency measured | blocked on later authorization and safe test data |

## Dependency order

1. Accept V4-001 and commit the common baseline.
2. Create isolated worktrees for V4-101, V4-102, and V4-103A.
3. Integrate reviewed foundation commits into the candidate branch.
4. Build V4-104 against the integrated foundation, then V4-103B.
5. Build V4-201, then V4-202, only after OpenAPI stabilizes.
6. Run V4-301 against the exact integrated commit in a clean QA worktree.
7. Repair through the owning worker, rerun affected tests, and invalidate stale
   approvals.
8. Obtain V4-008 final verification. Use V4-009 only under its escalation rule.
9. Prepare V4-010 evidence without deploying or changing production.

## Review handoff

Each worker returns:

```text
TASK ID:
AGENT / ACTUAL MODEL:
BRANCH / WORKTREE:
BASE COMMIT:
CANDIDATE COMMIT:
FILES CHANGED:
IMPLEMENTATION SUMMARY:
FOCUSED CHECKS RUN:
KNOWN LIMITATIONS:
CONTRACT OR MIGRATION IMPACT:
NEXT HANDOFF: sol-planner -> sol-reviewer
```

The reviewer returns `READY_FOR_QA` or `CHANGES_REQUIRED` before QA and
`VERIFIED` or `CHANGES_REQUIRED` after QA. QA never repairs code in its
independent verification worktree.

## Release safety

- Candidate runtime uses port 8004, a distinct Compose project name, isolated
  PostgreSQL storage, isolated volumes, and test-only credentials.
- Production schedulers, callbacks, and deployment workflows stay disabled in
  candidate runs.
- No live provider load test runs without an explicit bounded budget.
- No secret value enters Git, frontend bundles, screenshots, logs, or handoffs.
- Main, integration, legacy, and V3 remain unchanged.

## Service security boundary

- Durable endpoints require a service credential mapped to tenant and user
  authorization by the TypeScript adapter. Request bodies cannot choose a
  different tenant.
- The synchronous `/evaluate` route is registered only when
  `V4_TEST_PROFILE=true`; candidate and production startup reject a missing
  internal credential.
- Candidate Compose binds public development ports to loopback and places the
  database on an internal network.
- Credential rotation behavior will be defined and tested in V4-104. The
  baseline does not claim overlap support.
- V4-104 acceptance tests must cover missing, invalid, expired, and
  cross-tenant credentials. The baseline tests only startup configuration.

## External security blocker

The candidate removes a tracked local-settings file that contained a
credential. Provider revocation or rotation remains externally unverified, and
reachable-history remediation requires a coordinated repository-owner
decision. These actions do not block committing the sanitized candidate
baseline, but both risks must be resolved before production use or wider
repository distribution. Never record the replacement credential in Git.
