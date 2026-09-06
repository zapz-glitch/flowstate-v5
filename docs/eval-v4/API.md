# V4 Durable Evaluation API

Candidate/test durable HTTP surface for the V4 evaluation engine. No live
provider calls exist anywhere in this path (no OpenAI/Firecrawl).

## Auth: service-to-service credentials

Tenant/user are derived from the credential, never from the body. One
baseline token env exists; the secure record format is:

`V4_API_CREDENTIALS`: JSON array of credential records:

```json
[
  {
    "tenant_id": "tenant-a",
    "user_id": "service-a",
    "token_sha256": "<hex sha256 of bearer token>",
    "expires_at": "2027-01-01T00:00:00+00:00",
    "previous_token_sha256": "<hex of prior token during rotation>",
    "previous_expires_at": "2026-10-01T00:00:00+00:00"
  }
]
```

Rules:

- `tenant_id`, `user_id`, `token_sha256` (64 hex chars) are required.
- Only the SHA-256 hash is stored; plaintext tokens never appear in config.
- Verification uses constant-time compare; tokens are never logged.
- Rotation: `previous_token_sha256` plus explicit `previous_expires_at`
  are both required; the previous token is rejected once expired.
- Fallback: when `V4_API_CREDENTIALS` is absent, a single
  `V4_INTERNAL_API_TOKEN` maps to `V4_DEFAULT_TENANT`/`V4_DEFAULT_USER`
  (defaults `default`/`service`).
- Startup rejects a missing candidate auth outside `V4_TEST_PROFILE=true`.

Requests use `Authorization: Bearer <token>`. Failures are machine typed
(`AUTH_MISSING`/`AUTH_INVALID`, 401) without DB/auth detail.

## Endpoints

- `POST /v1/evaluations` (202): accepts 1..50 fully typed property
  requests plus one validated immutable settings snapshot. Requires
  tenant-scoped `Idempotency-Key`. Auth and validation complete before
  any transaction; snapshot, batch, and evaluations persist
  transactionally. Same key plus same payload returns the same IDs
  (`reused`); same key plus different payload returns 409
  `IDEMPOTENCY_CONFLICT`. Accepted jobs survive client disconnect and
  are polled via GET.
- `GET /v1/evaluations/{id}`: tenant scoped (404 on cross-tenant),
  returns execution/result status, progress, result payload, errors, and
  incomplete sections.
- `GET /v1/evaluation-batches/{id}`: tenant scoped (404 on
  cross-tenant), returns batch progress plus per-evaluation IDs/status.
- `POST /evaluate`: test-only (`V4_TEST_PROFILE=true`), never part of
  candidate routing.

Status mapping is explicit: execution `queued/claimed/running` map to
`QUEUED/RUNNING`; persistence `VALUED` maps to API `COMPLETED`; all
other durable result statuses pass through unchanged.

## Evidence mode

Submission carries `candidate_evidence_mode`:

- `preloaded`: caller-supplied subject/comps evidence is evaluated inline
  after commit (candidate/test path).
- `provider_pending`: typed provider port exists
  (`api/providers.py`, subject/comps/permits acquisition plus
  checkpoint) but has no live implementation; items queue as pending.

Result payloads carry `settings_snapshot_id` plus
`settings_content_hash` bound to the durable snapshot; mismatches fail
before writes. Errors are machine typed (`VALIDATION_ERROR`,
`IDEMPOTENCY_CONFLICT`, `NOT_FOUND`, `PROVIDER_PENDING`) without
exposing DB or auth internals.
