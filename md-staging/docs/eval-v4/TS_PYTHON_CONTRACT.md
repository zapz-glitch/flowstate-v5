# V4 TypeScript to Python Contract

The existing TypeScript stack remains the product shell. The Python service is
the only V4 financial authority and integrates over versioned HTTP/OpenAPI
contracts.

## Endpoints

- `GET /health` reports process health.
- `POST /v1/evaluations` accepts 1 to 50 property requests and returns 202.
- `GET /v1/evaluations/{evaluation_id}` returns one tenant-scoped result.
- `GET /v1/evaluation-batches/{batch_id}` returns batch progress.
- `POST /evaluate` exists only when `V4_TEST_PROFILE=true` and is never part of
  candidate or production routing.

The isolated development service uses port 8004.

## Data flow

1. The existing application authenticates the user.
2. The adapter resolves the user's settings with existing scope precedence.
3. The adapter posts subject evidence, candidate comps, permits, renovation
   input, and one immutable typed settings snapshot.
4. FastAPI persists the batch and property jobs before returning 202.
5. Durable workers calculate and persist versioned results.
6. The existing UI polls and displays the authoritative response without
   recalculating V4 money in the browser.

## Serialization

This document is the V4-001 draft contract. Current Pydantic and OpenAPI are
non-authoritative scaffolding. Accepted V4-101 Pydantic models and generated
OpenAPI become the machine contract after review. Money and measured decimal
values use decimal strings in JSON. Dates use ISO 8601. Enumerations are
explicit and unknown values fail validation rather than silently mapping to a
default.

## Settings snapshot identity (IC-1)

One canonical envelope/hash is shared by the typed domain, persisted
canonicalization, and the result:

- `SettingsSnapshotV4.canonical_payload()` returns the envelope
  `{version, content, source}`. Generated identifiers (`snapshot_id`,
  `content_hash`) are excluded. `version` is the schema/snapshot version,
  `content` carries values (filters, adjustments, transaction rule, tiers,
  deal, major items), and `source` carries provenance/timestamps
  (`source_timestamps`; per-rule `source`/`precedence`/`version` live
  inside `content` and are hashed verbatim).
- `SettingsSnapshotV4.compute_content_hash()` hashes that envelope with
  the single shared `canonical_hash` in `contracts/base.py` (exact
  context-independent Decimal normalization, Unicode NFC, stable key
  order, SHA-256 over compact sorted-key JSON). The persistence layer
  re-exports the same implementation; there is exactly one.
- `snapshot_store_parts(snapshot)` splits the envelope into
  `(version, content, source)` for `store_settings_snapshot`, so the
  persistence identity input is exactly the envelope the domain hashes,
  and the serialized stored JSON re-hashes identically.
- Equivalent Decimal spellings (`12.50`/`12.5`/`1.25E+1`), key order, and
  Unicode NFC forms hash identically; material provenance differences
  (timestamps, per-rule source/precedence/version) hash differently.
- Domain `COMPLETED` maps to persistence `VALUED` via
  `to_persistence_status` (`DOMAIN_TO_PERSISTENCE_STATUS`); all other
  durable statuses are spelled identically. Cross-layer proof lives in
  `services/eval-engine/tests/test_integration_contracts.py`.

## Existing TypeScript touchpoints

- `apps/api/src/services/property-api/`
- `apps/api/src/services/user-settings/`
- `apps/api/src/routes/analyze.ts`
- `apps/dashboard/src/lib/client-api.ts`
- `apps/dashboard/src/hooks/use-report-settings.ts`
- `apps/dashboard/src/hooks/use-analysis-evaluation.ts`

The backend owner implements the TypeScript API bridge. The frontend owner
implements the dashboard adapter after that bridge stabilizes. Layout and
operator behavior must remain intact.
