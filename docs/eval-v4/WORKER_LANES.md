# V4 Worker Lanes

Branch: `v4/python-fast-eval`. Candidate worktree:
`/home/lucke/src/flowstate-api-v4-eval`.

The owner has authorized the complete V4 candidate. UI preservation remains a
hard requirement, but focused adapter work is allowed after Python and OpenAPI
contracts stabilize.

## Hard rule

Stay inside the assigned lane. Do not create or edit files outside the paths
listed in a task package. Report dependencies instead of reaching into another
worker's scope.

## Lanes

| Role | Owns | Must not touch |
|---|---|---|
| backend | Assigned `services/eval-engine/src/**` engine or API paths | frontend, migrations, unassigned persistence paths |
| database | Assigned eval-engine persistence models, repositories, and Alembic files | legacy D1 migrations and schema unless an integration task explicitly requires additions |
| frontend | Focused V4 adapters under assigned `apps/dashboard/src/**` paths after contracts stabilize | API routes, visual redesign, unrelated components, Python persistence paths |
| qa | Eval-engine tests, fixtures, and assigned integration or browser tests | implementation source |
| devops | Eval-engine container and runtime files, candidate-only CI, Compose, and operational docs | live deploy configuration and production secrets |
| spark-worker | Only the exact paths named in its assignment | every other path |

## UI preservation

Do not move components, change placement, redesign the dashboard, invent copy,
or alter operator workflows. Focused data adapters and minimum V4 report fields
are allowed only in an assigned frontend package.

## TypeScript authority

Python is the financial authority for V4. TypeScript may authenticate, resolve
legacy settings during migration, submit jobs, poll results, and display them.
It must not introduce another authoritative V4 calculator.

## Completion protocol

1. Finish only the assigned paths.
2. Run the lane's focused checks.
3. Return the handoff required by the implementation plan.
4. The orchestrator invokes `sol-reviewer`, then independent QA.
5. Do not mark another lane complete or merge it.
