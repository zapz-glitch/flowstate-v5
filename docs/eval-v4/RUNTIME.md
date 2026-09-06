# Evaluation V4 candidate runtime

Candidate-only developer runtime for the V4 evaluation engine. It is
isolated from production and from unrelated Compose projects. Nothing here
deploys, migrates production data, or sends external provider calls.

## Scope

- Compose project name: `flowstate-v4-dev` (declared in `compose.dev.yaml`).
- Services: `api` (FastAPI eval engine), `migrate` (one-shot `alembic
  upgrade head` from the built API image), `postgres` (isolated
  PostgreSQL 17), `dashboard` (Next.js dev server).
- Volumes: `v4-postgres-data`, `v4-dashboard-next`. Both are prefixed by the
  project name, so they do not collide with other projects.
- Networks: `frontend` (dashboard plus API) and `backend` (API plus
  postgres). `backend` is `internal: true`; postgres publishes no host port
  (verified: `docker port flowstate-v4-dev-postgres-1` returns empty).
- Host ports are loopback-bound: API `127.0.0.1:8004` (override
  `V4_API_PORT`), dashboard `127.0.0.1:3004` (override
  `V4_DASHBOARD_PORT`). The legacy TypeScript API (`localhost:8787`) is not
  part of this Compose file.
- Base images are pinned by immutable digest
  (`python:3.12-slim@sha256:7838...`, `node:20-slim@sha256:2cf0...`,
  `postgres:17-alpine@sha256:18cf...`; full digests in the Dockerfiles and
  `compose.dev.yaml`). Python dependencies are fully hashed in
  `services/eval-engine/requirements.txt` (authoritative lock generated on
  Python 3.12/Linux; direct inputs in `requirements.in`), installed with
  `--require-hashes` in Docker and CI, including `alembic==1.19.2` so
  candidate CI installs the migration tool V4-102 will use.

## Deterministic images and build context

- `services/eval-engine/Dockerfile` runs the API as non-root user
  `flowstate` (uid 999). Build context is `./services/eval-engine`;
  `services/eval-engine/.dockerignore` (consumed for this build) excludes
  all `.env*` (except `.env.example` via negation), `*.dev.vars*`, VCS and
  editor state, caches, `.venv`, and logs, while preserving the Dockerfile
  `COPY` sources (`requirements.txt`, `alembic.ini`, `alembic/`, `src/`).
  The image therefore ships the exact migration tree the one-shot
  `migrate` service and CI run with `alembic upgrade head`.
- The dashboard Compose service uses the repository root as its build
  context, so Docker consumes the ROOT `.dockerignore` for that build (not
  `apps/dashboard/.dockerignore`, which is advisory only). The root
  `.dockerignore` excludes all `.env*`, `*.dev.vars*`, `.git`, dependency
  and build-output directories, caches, logs, and `**/*.tsbuildinfo`, while
  preserving every `COPY` source in `apps/dashboard/Dockerfile.dev`
  (`package.json`, `package-lock.json`, `turbo.json`, `packages/shared`,
  `apps/dashboard`). Because the dashboard env files are excluded from the
  context, the public build-time values the dashboard needs are passed as
  Compose environment (`NEXT_PUBLIC_API_URL`); no secret value is baked in.
- Both images are tagged `:local` and built with `pull_policy: build`.
  Candidate CI builds images but never pushes them.
- Sentinel verification (also a CI step): temporary `.env.sentinel-probe`,
  `probe-sentinel.log`, and `tsconfig.probe.tsbuildinfo` files are confirmed
  ABSENT from both build contexts while `package.json`,
  `apps/dashboard/src`, `packages/shared`, `requirements.txt`, `src/`, and
  `.env.example` are confirmed PRESENT. Verified locally 2026-09-06 with
  throwaway `busybox` context-dump builds; sentinels removed afterwards.
- Migration note for the orchestrator: `services/eval-engine/alembic/` and
  `alembic.ini` are integrated on this branch (V4-102 landed). The engine
  `.dockerignore` deliberately does NOT exclude `alembic.ini` or
  `alembic/`, so they enter the image via the Dockerfile `COPY` lines and
  the one-shot `migrate` service runs `alembic upgrade head` from the
  built image before the API starts.
- Compose `api` depends on `migrate (service_completed_successfully)` in
  addition to `postgres (service_healthy)`, so the API only starts after a
  successful migration. Candidate CI repeats the same contract: migrate
  from the built image against an isolated PostgreSQL service, verify
  revision `0002_v4_repair` plus the four `v4_*` tables, then start the API
  image and poll `/health/ready`.

## Environment contract

- `services/eval-engine/.env.example` lists every variable the candidate
  honours: `PORT`, `TS_API_BASE`, `DATABASE_URL`, `V4_INTERNAL_API_TOKEN`,
  `COTALITY_*`, `V4_EXTERNAL_CALLS_ENABLED`, `V4_TEST_PROFILE`.
- `compose.dev.yaml` passes test-only values
  (`V4_INTERNAL_API_TOKEN=candidate-local-only`,
  `V4_EXTERNAL_CALLS_ENABLED=false`, `V4_TEST_PROFILE=false`).
- The API refuses to start outside the test profile without
  `V4_INTERNAL_API_TOKEN` (see `validate_startup_configuration` in
  `services/eval-engine/src/eval_engine/main.py`; covered by
  `test_startup_requires_internal_token_outside_test_profile`).
- Never commit real credentials. `./scripts/secret-scan` rejects
  credential-shaped content (private keys, `sk-or-v1-` tokens, long Bearer
  values) in tracked and untracked working-tree files. It is a
  working-tree pattern check, not a guarantee of secret absence outside the
  scanned patterns or history.

## Health and readiness

- `GET /health` reports process liveness.
- `GET /health/db` reports PostgreSQL connectivity (`ok` or `unavailable`).
- `GET /health/ready` (alias `GET /ready`) reports `ready` only when the
  database probe succeeds AND the schema probe confirms Alembic revision
  `0002_v4_repair` with all four `v4_*` persistence tables present. An
  unmigrated database returns HTTP 503 `not_ready`.
- Compose `api` has a `healthcheck` against `/health/ready`, and
  `depends_on: postgres (service_healthy)` plus `migrate
  (service_completed_successfully)` so the API starts after postgres
  is reachable and migrations have applied. The dashboard waits on API health.
- API and postgres services use `restart: "no"`: Compose never restarts
  them automatically. This avoids crash loops locally; it is not a
  production availability posture.

## Operating the runtime

All commands go through `./scripts/runtime`, which pins
`--project-name flowstate-v4-dev -f compose.dev.yaml` and filters container
listing by the `com.docker.compose.project=flowstate-v4-dev` label.
Unrelated and production containers are never listed, started, or stopped.

```bash
./scripts/runtime up      # build and start the isolated project, wait for API readiness + dashboard
./scripts/runtime status  # show only V4 project containers plus API/dashboard reachability
./scripts/runtime health  # probe /health, /health/db, /health/ready and the dashboard (PASS/FAIL)
./scripts/runtime logs    # follow API/worker service logs only
./scripts/runtime test    # run the V4 Python suite (host .venv when usable, else temporary host venv from the hashed lock)
./scripts/runtime down    # stop only the V4 dev project; fails honestly if compose fails or containers remain
```

`down` propagates `compose down` failures and then verifies no
`flowstate-v4-dev` containers remain; it exits nonzero with the leftover
names if any survive. `test` prefers an existing usable host `.venv` and
otherwise creates a temporary host venv from the hashed lock (removed on
exit): no Docker socket is mounted into any app container. The DB-backed
tests start their isolated PostgreSQL containers through the host Docker
CLI directly.

## Rollback rehearsal

To rehearse a clean rollback of the candidate runtime:

```bash
./scripts/runtime down
docker compose --project-name flowstate-v4-dev -f compose.dev.yaml down -v
./scripts/runtime up
./scripts/runtime health
```

`down -v` removes the isolated `v4-postgres-data` and `v4-dashboard-next`
volumes. This is expected to delete candidate-local postgres data and the
dashboard `.next` cache only; it does not touch any other project because
every object is scoped to `flowstate-v4-dev`. Re-run `health` to confirm
the stack returns to `ready`.

## External calls

Normal candidate runs make no OpenAI, Firecrawl, Cotality, or other external
calls. `V4_EXTERNAL_CALLS_ENABLED=false` in the Compose file, and the
current engine has no provider client in its request path. A bounded
real-provider proof is a separately authorized step (see V4-010 in
`docs/EVALUATION_V4_IMPLEMENTATION_PLAN.md`), not part of this runtime.
Candidate CI installs pinned PyPI packages (build-time dependency fetch);
it performs no deployment and no provider API calls.

## What this runtime does not do

- No persistence-dependent worker supervision or provider limiter (V4-103B).
- No durable queue, lease, retry, or recovery semantics (V4-102/V4-104).
- No TypeScript bridge or dashboard adapter (V4-201/V4-202).
- No deployment and no production wiring (stays in `deploy.yml` on `main`).
