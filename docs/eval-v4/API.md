# V4 Durable Evaluation API

Durable candidate HTTP surface. POST persists and returns 202 QUEUED;
it never evaluates inline. A worker boundary (V4-103B; tests use the
explicit helper) processes committed jobs independently, so client
disconnect never cancels accepted work. No live provider calls exist
anywhere in this path (no OpenAI/Firecrawl).

## Auth: service-to-service credentials

Tenant and user are derived from the credential, never from the body.
One baseline token env exists; the secure record format is:

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

Requests use `Authorization: Bearer <token>`. Every submit and read
filters both credential-derived tenant and `requested_by_user_id`;
cross-tenant and cross-user access return indistinguishable 404.

## Endpoints

- `POST /v1/evaluations` (202): authenticates, validates the full body
  in memory (1..50 fully typed property requests plus one immutable
  settings snapshot; both `preloaded` and `provider_pending` evidence
  modes), then persists snapshot, batch, and all jobs in one short
  transaction and returns initial QUEUED ids immediately. The durable
  payload and checkpoint carry `evidence_mode` plus acquisition inputs,
  and the mode is part of the idempotency identity. Same scope plus
  same payload returns the same IDs (`reused`); same scope plus
  different payload returns 409 `IDEMPOTENCY_CONFLICT`. No claims,
  evaluation, or result commits happen in the handler.
- `GET /v1/evaluations/{id}`: owner scoped (404 on cross-tenant or
  cross-user), returns execution/result status, progress, result
  payload, errors, and incomplete sections.
- `GET /v1/evaluation-batches/{id}`: owner scoped (404 on cross-tenant
  or cross-user), returns batch progress plus per-evaluation IDs/status.
- `POST /evaluate`: test-only (`V4_TEST_PROFILE=true`), never part of
  candidate routing.

Status mapping is explicit: execution `queued/claimed/running` map to
`QUEUED/RUNNING`; persistence `VALUED` maps to API `COMPLETED`; all
other durable result statuses pass through unchanged.

## Durable ownership

`requested_by_user_id` is stored on batches, evaluations, and results
(additive Alembic `0003_v4_owner` with owner-scoped idempotency uniques
and composite indexes; legacy tenant-only uniques replaced at head).
Per-property execution isolation (retries, fencing across properties)
is a V4-103B requirement, not an API claim.

## Errors

Machine-typed JSON: `AUTH_MISSING`/`AUTH_INVALID` (401),
`MALFORMED_JSON` (400), `INVALID_SHAPE`/`VALIDATION_ERROR` (422),
`IDEMPOTENCY_CONFLICT`/`LEASE_CONFLICT`/`DOMAIN_ERROR` (409),
`NOT_FOUND` (404), `INTERNAL_ERROR` (500). No DB or auth details leak.
Result payloads carry `settings_snapshot_id` plus
`settings_content_hash` bound to the durable snapshot.
