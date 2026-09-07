# V4 worker runtime (V4-103B)

Candidate-only supervised worker process. It consumes the owner-scoped
queue fairly, using canonical claims, `mark_running`, heartbeats during
work, stale-lease recovery on (re)start, checkpoints, bounded
retries/terminal non-retry, per-property isolation, fenced result
commit, and exact replay. Preloaded evidence evaluates the deterministic
engine. `provider_pending` uses the typed `ProviderPort` and persists
acquisition checkpoints; with external calls disabled (`false` in
Compose) those items resolve to a deferred `REVIEW_REQUIRED` terminal
without any provider call and never spin.

The shared PostgreSQL-backed Cotality limiter globally coordinates max
4 active leases and a sliding safe 40 calls per 60 seconds with no
bursts across processes. Each attempt/retry counts; lease expiries are
recovered; provider 429s persist `next_attempt` (Retry-After honored,
bounded jitter applied by the worker backoff). Legacy consumers are not
claimed to be covered: only the supervised worker lane is.

## Services

- `api`: FastAPI eval engine (unchanged request path: submit 202 QUEUED,
  never evaluates inline).
- `migrate`: one-shot `alembic upgrade head` from the built image.
- `worker`: `python -m eval_engine.worker.main`, same built image,
  `depends_on: migrate (service_completed_successfully)` plus postgres
  healthy, `restart: unless-stopped` (candidate-safe: a crashed worker
  restarts; at-most-once terminal commits are fenced by the lease, and
  stale leases are recovered on restart).
- `postgres`: isolated, internal-only. `dashboard`: unchanged.

The worker has no client coupling: it never serves HTTP and shares only
the database contract with the API.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `V4_WORKER_TENANT` | `default` | tenant scope the worker consumes |
| `V4_WORKER_OWNER` | `worker:service` | lease executor identity (not ownership) |
| `V4_WORKER_USER` | (required) | durable requesting-user scope; startup fails without it except `V4_TEST_PROFILE=true` or explicit `V4_WORKER_ALLOW_DEFAULT_USER=true` local escape hatch |
| `V4_EXTERNAL_CALLS_ENABLED` | `false` | provider calls off in candidate |
| `COTALITY_CONCURRENCY` | `4` | max active provider leases |
| `COTALITY_RPM` | `40` | safe calls per 60s sliding window |
| `V4_WORKER_LEASE_SECONDS` | `300` | evaluation lease TTL |
| `V4_WORKER_HEARTBEAT_SECONDS` | `30` | heartbeat interval |
| `V4_WORKER_POLL_SECONDS` | `1` | idle poll interval |
| `V4_WORKER_RECOVERY_SECONDS` | `30` | periodic owner-scoped recovery interval |

## Fairness

Claims are round-robin across batches: the batch holding the oldest due
queued row is served first, excluding the just-processed batch while any
other due batch exists. A single 50-property batch therefore cannot
starve smaller batches. Inside a batch, the oldest due row goes first.

## Failure model

- Unexpected per-property exceptions map to a bounded retry (exponential
  30s base, 1h cap, +/-10% jitter, testable via `compute_backoff` with a
  seeded RNG) or a terminal `dead` for non-retryable codes
  (`invalid_evidence`, `validation_error`, `auth_denied`).
- Provider 429 persists `next_attempt_at` as `max(Retry-After,
  bounded jittered backoff)` (timedelta / numeric / numeric-string /
  HTTP-date / ISO-8601 forms; negatives rejected) and returns the row
  to `queued`; at persisted `attempts` exhaustion it terminally fails
  instead of requeueing. Limiter capacity refusal never consumes a
  claim attempt: it bumps a persisted `limiter_defers` checkpoint
  counter, requeues with a bounded delay, and terminally fails with
  `limiter_exhausted` past `max_limiter_defers` (default 25, also
  bounded by `max_attempts`).
- Each outbound provider request holds its own limiter permit
  (subject, comps, and permits when the acquisition requests it),
  released in a `finally`; a renewal heartbeat keeps a held permit
  alive across slow calls and output produced after the permit was
  lost is discarded (bounded transient retry), never committed.
  Provider 429 keeps its window count and frees the slot.
- Claim due checks use `max(app now, DB now)` so app/DB skew cannot
  strand rows; only retryable DB operational/disconnect failures are
  transient claim retries (bounded budget, then the run raises and the
  process exits nonzero) — fatal schema/config/permission failures
  propagate. Startup recovery plus periodic owner-scoped recovery run
  on the DB clock in short transactions; recovery and claims are
  filtered to one durable owner scope (tenant + requesting user).
- Heartbeats extend the lease during work; graceful shutdown
  (SIGINT/SIGTERM) stops new claims only — the in-flight heartbeat
  continues until the active claim finishes.
- One evaluation completion per transaction (eval lock, then batch
  lock) so concurrent completions serialize instead of deadlocking.

## Operating

```bash
./scripts/runtime up      # api + migrate + worker + dashboard
./scripts/runtime status  # includes the worker container line
./scripts/runtime health  # api checks + worker service line
./scripts/runtime logs    # follows api + worker logs
./scripts/runtime logs worker  # worker only
./scripts/runtime test    # full suite incl. worker/limiter + migration head 0004
./scripts/runtime down
```

## Verification

- `tests/test_worker.py` + `tests/test_limiter.py`: simultaneous
  workers (no duplicate claims), fair batches, crash/recover,
  commit-then-replay, stale fencing, heartbeats (incl. heartbeat
  surviving shutdown until the in-flight claim finishes),
  isolation, 429/Retry-After, RPM boundary, concurrent max,
  genuine multiprocessing coordination (spawned processes, not only
  threads; skewed process clocks defer to the DB clock),
  external-disabled zero calls, restart, stubbed 1/5/10/20/50 batches.
- Cold-start harness (`tests/conftest.py` `isolated_pg`): starts the
  isolated PG container only when 127.0.0.1:55440 is closed, verifies
  identity (`SELECT 1` + `SHOW server_version` on the maintenance DB)
  before reusing any listener, refuses Neon/prod/non-loopback URLs,
  removes ONLY a harness-created container on session teardown
  (startup failure cleans up half-created containers). The
  `v4-health-pg-ic3` readiness container (port 55441) is managed and
  torn down by its own test. Focused and full runs leave no
  `v4-persist-pg-102` / `v4-health-pg-ic3` containers behind.
- `--max-jobs N` means process at most N claimed evaluations per run
  (product `main.py` clamps N<1 to 1, so a bare `--max-jobs 0` must
  never be used as a smoke signal). CI submits one known preloaded
  stub evaluation (tenant `ci-smoke`, user `ci-user`), runs the real
  worker binary with `--max-jobs 1` and `V4_WORKER_USER=ci-user`, and
  asserts a persisted terminal `succeeded 1/1` batch/evaluation row.
- `tests/test_migrations.py`: head `0004_v4_provider_limiter`,
  additive downgrade removes only the two limiter tables.
- CI: worker/limiter tests run in the suite; migration check asserts
  revision `0004_v4_provider_limiter` plus the seven `v4_*` tables.
- Compose smoke: supervised worker runs with explicit
  `V4_WORKER_TENANT` + `V4_WORKER_OWNER` + `V4_WORKER_USER`
  (dev default `local-dev-user` with the explicit local escape hatch);
  `./scripts/runtime health` FAILS when the worker service is
  absent/stopped and PASSES when it is Up.
- No live providers are called anywhere in the candidate path.
