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
| `V4_WORKER_OWNER` | `worker:service` | lease owner string |
| `V4_EXTERNAL_CALLS_ENABLED` | `false` | provider calls off in candidate |
| `COTALITY_CONCURRENCY` | `4` | max active provider leases |
| `COTALITY_RPM` | `40` | safe calls per 60s sliding window |
| `V4_WORKER_LEASE_SECONDS` | `300` | evaluation lease TTL |
| `V4_WORKER_HEARTBEAT_SECONDS` | `30` | heartbeat interval |
| `V4_WORKER_POLL_SECONDS` | `1` | idle poll interval |

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
- Provider 429 / limiter exhaustion persists `next_attempt_at`
  (Retry-After honored) and returns the row to `queued` without spinning.
- Heartbeats extend the lease during work; graceful shutdown
  (SIGINT/SIGTERM) stops claiming, stops heartbeats, and exits.
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
  commit-then-replay, stale fencing, heartbeats, isolation, 429/
  Retry-After, RPM boundary, concurrent max, multi-process coordination,
  external-disabled zero calls, restart, stubbed 1/5/10/20/50 batches.
- `tests/test_migrations.py`: head `0004_v4_provider_limiter`,
  additive downgrade removes only the two limiter tables.
- CI: worker/limiter tests run in the suite; migration check asserts
  revision `0004_v4_provider_limiter` plus the seven `v4_*` tables.
- No live providers are called anywhere in the candidate path.
