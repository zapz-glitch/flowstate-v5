# Evaluation V4 candidate runtime

Candidate-only developer runtime for the V4 evaluation engine. It is
isolated from production and from unrelated Compose projects. Nothing here
deploys, migrates production data, or sends external provider calls.

## Scope

- Compose project name: `flowstate-v4-dev` (declared in `compose.dev.yaml`).
- Services: `api` (FastAPI eval engine), `postgres` (isolated PostgreSQL 17),
  `dashboard` (Next.js dev server).
- Volumes: `v4-postgres-data`, `v4-dashboard-next`. Both are prefixed by the
  project name, so they do not collide with other projects.
- Networks: `frontend` (dashboard plus API) and `backend` (API plus
  postgres). `backend` is `internal: true`; postgres has no host port.
- Host ports are loopback-bound: API `127.0.0.1:8004` (override
  `V4_API_PORT`), dashboard `127.0.0.1:3004` (override
  `V4_DASHBOARD_PORT`). The legacy TypeScript API (`localhost:8787`) is not
  part of this Compose file.

## Deterministic images and build context

- `services/eval-engine/Dockerfile` pins `python:3.12-slim`, creates a
  `flowstate` system user, and runs the API as that non-root user. Build
  context is `./services/eval-engine`; `services/eval-engine/.dockerignore`
  keeps caches, `.venv`, logs, and `.git` out of the context.
- `apps/dashboard/Dockerfile.dev` is a development-only image (`node:20-slim`
  plus `npm ci` plus `next dev`). Its Compose build context is the repo root
  with a narrow `COPY` list (root package files, `packages/shared`,
  `apps/dashboard`). `apps/dashboard/.dockerignore` is advisory only: Docker
  reads a `.dockerignore` from the context root, so it is not consumed while
  the context stays at the repo root.
- Both images are tagged `:local` and built with `pull_policy: build`.
  Candidate CI builds images but never pushes them.

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
  values) in tracked and untracked working-tree files.

## Health and readiness

- `GET /health` reports process liveness.
- `GET /health/db` reports PostgreSQL connectivity (`ok` or `unavailable`).
- `GET /health/ready` (alias `GET /ready`) reports `ready` only when the
  database probe succeeds.
- Compose `api` has a `healthcheck` against `/health/ready`, and
  `depends_on: postgres (service_healthy)` so the API starts after postgres
  is reachable. The dashboard waits on API health.
- Both API and postgres services use `restart: "no"` so a failed candidate
  never restarts itself into a crash loop during local development.

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
./scripts/runtime test    # run the V4 Python suite (host .venv when usable, else isolated container)
./scripts/runtime down    # stop only the V4 dev project
```

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

## What this runtime does not do

- No persistence-dependent worker supervision or provider limiter (V4-103B).
- No durable queue, lease, retry, or recovery semantics (V4-102/V4-104).
- No TypeScript bridge or dashboard adapter (V4-201/V4-202).
- No deployment and no production wiring (stays in `deploy.yml` on `main`).
