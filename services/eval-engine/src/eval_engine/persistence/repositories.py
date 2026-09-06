"""Repositories: idempotency, snapshots, queue claims, results, progress.

All queue semantics are PostgreSQL only with PostgreSQL-enforced fencing,
tenant scoping, and content addressing. There is no SQLite fallback.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import canonical_hash, canonical_json
from .models import Batch, Evaluation, EvaluationResult, SettingsSnapshot, _utcnow


class IdempotencyConflict(Exception):
    def __init__(self, message: str, *, existing_hash: str, new_hash: str):
        super().__init__(message)
        self.existing_hash = existing_hash
        self.new_hash = new_hash


class LeaseMismatch(Exception):
    pass


class TerminalReplay(Exception):
    """A different terminal identity was already committed for this lease."""

    def __init__(self, message: str, *, existing_version: int):
        super().__init__(message)
        self.existing_version = existing_version


def _valid_lease_generation(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LeaseMismatch("lease_generation is required")
    if value < 0:
        raise LeaseMismatch("lease_generation is required")
    return value


MAX_ATTEMPTS_DEFAULT = 5
LEASE_TTL = timedelta(minutes=5)
RETRY_BASE_DELAY = timedelta(seconds=30)
RETRY_MAX_DELAY = timedelta(hours=1)

_TERMINAL_EXECUTION = {"succeeded", "failed", "dead"}
_RETRIABLE_CODES = {"transient", "lease_expired", "provider_timeout"}
_NON_RETRIABLE_CODES = {"invalid_evidence", "validation_error", "auth_denied"}


def _retry_delay(attempts: int) -> timedelta:
    shift = min(max(0, attempts - 1), 10)
    delay = RETRY_BASE_DELAY * (2**shift)
    return min(delay, RETRY_MAX_DELAY)


def _normalize_item(item: dict) -> dict:
    payload = item.get("payload", item)
    if not isinstance(payload, dict):
        payload = {"value": payload}
    return {
        "idempotency_key": str(item["idempotency_key"]),
        "payload": canonical_json(payload),
        "max_attempts": int(item.get("max_attempts", MAX_ATTEMPTS_DEFAULT)),
    }


def _batch_request_hash(
    items: list[dict], snapshot_id: uuid.UUID, request_payload: dict
) -> str:
    normalized = sorted(
        (_normalize_item(item) for item in items),
        key=lambda entry: entry["idempotency_key"],
    )
    return canonical_hash(
        {
            "items": normalized,
            "snapshot_id": str(snapshot_id),
            "meta": canonical_json(request_payload),
        }
    )


@dataclass(frozen=True)
class Claim:
    evaluation_id: uuid.UUID
    tenant_id: str
    lease_owner: str
    lease_token: uuid.UUID
    lease_generation: int
    attempts: int


def _check_tenant(tenant_id: str) -> None:
    if not tenant_id or not tenant_id.strip():
        raise ValueError("tenant_id is required")


def store_settings_snapshot(
    session: Session,
    *,
    tenant_id: str,
    snapshot_version: str,
    content: dict,
    source: dict | None = None,
) -> SettingsSnapshot:
    """Store a fully content-addressed snapshot (content plus provenance)."""
    _check_tenant(tenant_id)
    normalized_content = canonical_json(content)
    normalized_source = canonical_json(source or {})
    payload_hash = canonical_hash(
        {
            "version": snapshot_version,
            "content": normalized_content,
            "source": normalized_source,
        }
    )
    existing = session.execute(
        select(SettingsSnapshot).where(
            SettingsSnapshot.tenant_id == tenant_id,
            SettingsSnapshot.content_hash == payload_hash,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    row = SettingsSnapshot(
        tenant_id=tenant_id,
        snapshot_version=snapshot_version,
        content_hash=payload_hash,
        content=normalized_content,
        source=normalized_source,
    )
    session.add(row)
    try:
        with session.begin_nested():
            session.flush()
    except IntegrityError:
        return session.execute(
            select(SettingsSnapshot).where(
                SettingsSnapshot.tenant_id == tenant_id,
                SettingsSnapshot.content_hash == payload_hash,
            )
        ).scalar_one()
    return row


def create_batch_with_evaluations(
    session: Session,
    *,
    tenant_id: str,
    idempotency_key: str,
    request_payload: dict,
    items: list[dict],
    snapshot_id: uuid.UUID,
) -> tuple[Batch, bool]:
    """Create a batch plus one evaluation row per property.

    Uses ON CONFLICT for concurrency-safe idempotency: same key plus same
    authoritative hash returns (existing, True); same key with a different
    hash raises IdempotencyConflict (reuse/conflict, never raw
    IntegrityError). snapshot_id is required (non-null FK).

    Duplicate property keys inside one request are rejected before any
    batch insert. The batch creation flag comes from INSERT ... RETURNING
    atomic evidence (inserted row means created True, conflict means
    replay with created False). Exact replay returns created False;
    conflicting reuse raises IdempotencyConflict; the requested item
    count must equal the persisted evaluation count for the batch.
    """
    _check_tenant(tenant_id)
    if snapshot_id is None:
        raise ValueError("snapshot_id is required")
    if not 1 <= len(items) <= 50:
        raise ValueError("batch must contain 1 to 50 property requests")
    # Intra-request duplicate property keys are a caller error: reject
    # before any batch insert so no partial batch can persist.
    seen_keys: set[str] = set()
    for raw in items:
        try:
            dup_key = str(raw["idempotency_key"])
        except (KeyError, TypeError) as exc:
            raise ValueError("each item requires an idempotency_key") from exc
        if not dup_key.strip():
            raise ValueError("each item requires an idempotency_key")
        if dup_key in seen_keys:
            raise ValueError(
                f"duplicate property idempotency key: {dup_key}"
            )
        seen_keys.add(dup_key)
    snapshot = session.execute(
        select(SettingsSnapshot).where(
            SettingsSnapshot.id == snapshot_id,
            SettingsSnapshot.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()
    if snapshot is None:
        raise KeyError(f"snapshot {snapshot_id} not found for tenant")
    normalized_items = [_normalize_item(item) for item in list(items)]
    row_hashes = {
        entry["idempotency_key"]: canonical_hash(entry["payload"])
        for entry in normalized_items
    }
    request_hash = _batch_request_hash(list(items), snapshot_id, request_payload)
    with session.begin_nested():
        inserted_id = session.execute(
            text(
                "INSERT INTO v4_batches "
                "(id, tenant_id, idempotency_key, request_hash, status, "
                " total_count, succeeded_count, failed_count, snapshot_id, "
                " created_at, updated_at) "
                "VALUES (:id, :tenant, :key, :hash, 'pending', "
                " :total, 0, 0, :snap, now(), now()) "
                "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING "
                "RETURNING id"
            ),
            {
                "id": uuid.uuid4(),
                "tenant": tenant_id,
                "key": idempotency_key,
                "hash": request_hash,
                "total": len(items),
                "snap": snapshot_id,
            },
        ).scalar_one_or_none()
    created_now = inserted_id is not None
    batch = session.execute(
        select(Batch).where(
            Batch.tenant_id == tenant_id,
            Batch.idempotency_key == idempotency_key,
        )
    ).scalar_one()
    if batch.request_hash != request_hash:
        raise IdempotencyConflict(
            "idempotency key reused with different payload",
            existing_hash=batch.request_hash,
            new_hash=request_hash,
        )
    if batch.snapshot_id != snapshot_id:
        raise IdempotencyConflict(
            "idempotency key reused with different snapshot",
            existing_hash=str(batch.snapshot_id),
            new_hash=str(snapshot_id),
        )
    if not created_now:
        # Exact replay must see requested count equal persisted count.
        # Skip the check while a concurrent same-key creator is still
        # inside its evaluation-insert window (persisted == 0): the
        # row-level ON CONFLICT plus the per-evaluation ownership check
        # below still fence cross-batch reuse deterministically.
        # Refresh first: this session's snapshot may predate the winning
        # creator's evaluation inserts (READ COMMITTED).
        session.execute(
            text(
                "SELECT 1 FROM v4_evaluations "
                "WHERE tenant_id = :tenant AND batch_id = :batch LIMIT 1"
            ),
            {"tenant": tenant_id, "batch": batch.id},
        )
        with session.no_autoflush:
            session.execute(
                select(Evaluation)
                .where(
                    Evaluation.batch_id == batch.id,
                    Evaluation.tenant_id == tenant_id,
                )
                .execution_options(populate_existing=True)
            ).scalars().all()
        persisted_total = session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(
                Evaluation.batch_id == batch.id,
                Evaluation.tenant_id == tenant_id,
            )
        ).scalar() or 0
        if persisted_total and persisted_total != len(items):
            raise IdempotencyConflict(
                "idempotency key replayed with different item count",
                existing_hash=batch.request_hash,
                new_hash=request_hash,
            )
    for item in items:
        normalized = _normalize_item(item)
        row_hash = canonical_hash(normalized["payload"])
        with session.begin_nested():
            session.execute(
                text(
                    "INSERT INTO v4_evaluations "
                    "(id, tenant_id, batch_id, idempotency_key, request_hash, "
                    " status, attempts, max_attempts, lease_generation, "
                    " next_attempt_at, input_payload, retriable, "
                    " created_at, updated_at) "
                    "VALUES (:id, :tenant, :batch, :key, :hash, 'queued', "
                    " 0, :maxa, 0, now(), "
                    " CAST(:payload AS jsonb), true, now(), now()) "
                    "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING"
                ),
                {
                    "id": uuid.uuid4(),
                    "tenant": tenant_id,
                    "batch": batch.id,
                    "key": normalized["idempotency_key"],
                    "hash": row_hash,
                    "maxa": normalized["max_attempts"],
                    "payload": __import__("json").dumps(normalized["payload"]),
                },
            )
        dupe = session.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant_id,
                Evaluation.idempotency_key == normalized["idempotency_key"],
            )
        ).scalar_one()
        if dupe.request_hash != row_hash:
            raise IdempotencyConflict(
                f"evaluation idempotency key reused: {normalized['idempotency_key']}",
                existing_hash=dupe.request_hash,
                new_hash=row_hash,
            )
        if str(dupe.batch_id) != str(batch.id):
            raise IdempotencyConflict(
                f"evaluation key already used: {normalized['idempotency_key']}",
                existing_hash=dupe.request_hash,
                new_hash=row_hash,
            )
    session.flush()
    _refresh_batch_counts(session, batch.tenant_id, batch.id)
    return batch, created_now


def claim_next_evaluation(
    session: Session,
    *,
    tenant_id: str,
    lease_owner: str,
    lease_ttl: timedelta = LEASE_TTL,
    now: datetime | None = None,
) -> Claim | None:
    """Atomically claim one due evaluation (row lock plus SKIP LOCKED)."""
    _check_tenant(tenant_id)
    current = now or _utcnow()
    expires = current + lease_ttl
    token = uuid.uuid4()
    claimed_id = session.execute(
        text(
            "SELECT id FROM v4_evaluations "
            "WHERE tenant_id = :tenant AND status = 'queued' "
            "AND (next_attempt_at IS NULL OR next_attempt_at <= :now) "
            "AND (lease_expires_at IS NULL OR lease_expires_at <= :now) "
            "ORDER BY next_attempt_at NULLS FIRST, created_at "
            "LIMIT 1 FOR UPDATE SKIP LOCKED"
        ),
        {"tenant": tenant_id, "now": current},
    ).scalar_one_or_none()
    if claimed_id is None:
        return None
    result = session.execute(
        update(Evaluation)
        .where(
            Evaluation.id == claimed_id,
            Evaluation.tenant_id == tenant_id,
            Evaluation.status == "queued",
        )
        .values(
            status="claimed",
            lease_owner=lease_owner,
            lease_token=token,
            lease_generation=Evaluation.lease_generation + 1,
            lease_expires_at=expires,
            last_heartbeat_at=current,
            attempts=Evaluation.attempts + 1,
            updated_at=current,
        )
        .returning(Evaluation.lease_generation, Evaluation.attempts)
    ).one_or_none()
    if result is None:
        return None
    session.flush()
    return Claim(
        evaluation_id=claimed_id,
        tenant_id=tenant_id,
        lease_owner=lease_owner,
        lease_token=token,
        lease_generation=int(result[0]),
        attempts=int(result[1]),
    )


def _lock_evaluation_row(
    session: Session, *, tenant_id: str, evaluation_id: uuid.UUID
) -> Evaluation:
    """Lock one tenant evaluation row for the duration of the mutation.

    populate_existing refreshes the identity-map copy so validation sees
    the current database state, no_autoflush keeps pending changes out of
    the locked read, and defaulting `now` after the lock prevents
    expiry races between timestamp capture and validation.
    """
    with session.no_autoflush:
        row = session.execute(
            select(Evaluation)
            .where(
                Evaluation.id == evaluation_id,
                Evaluation.tenant_id == tenant_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
    if row is None:
        raise KeyError(str(evaluation_id))
    return row


def _check_locked_lease(
    row: Evaluation,
    *,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    now: datetime,
    allowed: set[str],
) -> None:
    expected_generation = _valid_lease_generation(lease_generation)
    if (
        row.status not in allowed
        or row.lease_owner != lease_owner
        or row.lease_token != lease_token
        or int(row.lease_generation) != expected_generation
        or row.lease_expires_at is None
        or row.lease_expires_at <= now
    ):
        raise LeaseMismatch(f"stale or foreign lease for {evaluation_id}")


def _require_active_lease(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    now: datetime | None = None,
    allowed: set[str],
) -> Evaluation:
    row = _lock_evaluation_row(
        session, tenant_id=tenant_id, evaluation_id=evaluation_id
    )
    current = now or _utcnow()
    _check_locked_lease(
        row,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=current,
        allowed=allowed,
    )
    return row


def _cas_evaluation_lease(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    now: datetime | None = None,
    expect_status: set[str],
    mutate,
) -> bool:
    row = _lock_evaluation_row(
        session, tenant_id=tenant_id, evaluation_id=evaluation_id
    )
    current = now or _utcnow()
    try:
        _check_locked_lease(
            row,
            evaluation_id=evaluation_id,
            lease_owner=lease_owner,
            lease_token=lease_token,
            lease_generation=lease_generation,
            now=current,
            allowed=expect_status,
        )
    except LeaseMismatch:
        return False
    mutate(row, current)
    session.flush()
    return True


def heartbeat_lease(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    lease_ttl: timedelta = LEASE_TTL,
    now: datetime | None = None,
) -> bool:
    def _touch(row: Evaluation, at: datetime) -> None:
        row.lease_expires_at = at + lease_ttl
        row.last_heartbeat_at = at
        row.updated_at = at

    try:
        _valid_lease_generation(lease_generation)
    except LeaseMismatch:
        return False
    return _cas_evaluation_lease(
        session,
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=now,
        expect_status={"claimed", "running"},
        mutate=_touch,
    )


def mark_running(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    now: datetime | None = None,
) -> bool:
    def _start(row: Evaluation, at: datetime) -> None:
        row.status = "running"
        row.updated_at = at

    try:
        _valid_lease_generation(lease_generation)
    except LeaseMismatch:
        return False
    return _cas_evaluation_lease(
        session,
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=now,
        expect_status={"claimed"},
        mutate=_start,
    )


def recover_stale_leases(
    session: Session,
    *,
    tenant_id: str,
    now: datetime | None = None,
) -> int:
    """Return expired claimed/running leases to queued with bounded retry."""
    _check_tenant(tenant_id)
    current = now or _utcnow()
    result = session.execute(
        update(Evaluation)
        .where(
            Evaluation.tenant_id == tenant_id,
            Evaluation.status.in_(["claimed", "running"]),
            Evaluation.lease_expires_at.is_not(None),
            Evaluation.lease_expires_at <= current,
        )
        .values(
            status="queued",
            lease_owner=None,
            lease_token=None,
            lease_expires_at=None,
            error_code="lease_expired",
            updated_at=current,
        )
    )
    session.flush()
    count = result.rowcount or 0
    if count:
        _apply_retry_schedule(session, current=current, tenant_id=tenant_id)
    return count


def _apply_retry_schedule(
    session: Session, *, current: datetime, tenant_id: str
) -> None:
    rows = session.execute(
        select(Evaluation).where(
            Evaluation.tenant_id == tenant_id,
            Evaluation.status == "queued",
            Evaluation.error_code == "lease_expired",
        )
    ).scalars()
    for row in rows:
        attempts = int(row.attempts)
        if attempts >= int(row.max_attempts):
            row.status = "dead"
            row.error_code = "max_attempts_exceeded"
            row.retriable = False
        else:
            row.next_attempt_at = current + _retry_delay(attempts)
            row.error_code = None
        row.updated_at = current
    session.flush()


def fail_evaluation(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    error_code: str,
    error_detail: str = "",
    retriable: bool | None = None,
    result_status: str | None = None,
    now: datetime | None = None,
) -> str:
    """Record a fenced terminal or retryable failure for the lease holder."""
    row = _require_active_lease(
        session,
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=now,
        allowed={"claimed", "running"},
    )
    current = now or _utcnow()
    if retriable is None:
        if error_code in _NON_RETRIABLE_CODES:
            retriable = False
        elif error_code in _RETRIABLE_CODES:
            retriable = True
        else:
            retriable = int(row.attempts) < int(row.max_attempts)
    attempts = int(row.attempts)
    if retriable and attempts < int(row.max_attempts):
        row.status = "queued"
        row.next_attempt_at = current + _retry_delay(attempts)
    elif retriable:
        row.status = "failed"
        row.next_attempt_at = None
    else:
        row.status = "dead"
        row.next_attempt_at = None
    if result_status is not None:
        row.result_status = result_status
    row.lease_owner = None
    row.lease_token = None
    row.lease_expires_at = None
    row.error_code = error_code
    row.error_detail = error_detail
    row.retriable = bool(retriable)
    row.updated_at = current
    session.flush()
    _refresh_batch_counts(session, tenant_id, row.batch_id)
    return row.status


def _result_identity(
    methodology_version: str,
    snapshot_id: uuid.UUID,
    status: str,
    result_payload: dict,
) -> str:
    return canonical_hash(
        {
            "methodology": methodology_version,
            "snapshot_id": str(snapshot_id),
            "status": status,
            "payload": canonical_json(result_payload),
        }
    )


def commit_result(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    methodology_version: str,
    snapshot_id: uuid.UUID,
    status: str,
    result_payload: dict,
    now: datetime | None = None,
) -> tuple[EvaluationResult, bool]:
    """Concurrency-safe idempotent versioned result commit.

    Locking: the evaluation row is locked before `now` defaults and before
    lease validation, and the lock is held through version allocation and
    the terminal transition, so one active lease consumes at most one
    terminal result. One evaluation completion per transaction: the batch
    counter refresh locks the batch row deterministically after the
    evaluation lock (eval then batch), so concurrent completions serialize
    instead of deadlocking.

    Replay control: the result identity is context-independent (exact
    canonical payload). If the evaluation already succeeded and the
    presented identity equals the current terminal identity, the existing
    row returns with (row, False) and no state or timestamp changes. A
    different identity on a terminal row raises TerminalReplay. An active
    lease is required for new identities, historical identities, and
    successful reuse, and reuse completes the current execution atomically.
    Tenant lookup stays tenant scoped; tenant auth itself is external.

    Snapshot binding: the durable snapshot is derived from the locked
    evaluation's batch, never from caller control. A caller-supplied
    snapshot_id must exactly equal the batch snapshot, and a result
    payload carrying settings_snapshot_id/settings_content_hash must
    match the durable snapshot id and content hash; mismatches raise
    IdempotencyConflict before any replay, fencing, or insert decision.
    """
    _check_tenant(tenant_id)
    row = _lock_evaluation_row(
        session, tenant_id=tenant_id, evaluation_id=evaluation_id
    )
    current = now or _utcnow()
    bound_batch = session.execute(
        select(Batch).where(
            Batch.id == row.batch_id,
            Batch.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()
    if bound_batch is None:
        raise KeyError(f"batch {row.batch_id} not found for tenant")
    durable_snapshot_id = bound_batch.snapshot_id
    if snapshot_id != durable_snapshot_id:
        raise IdempotencyConflict(
            "result snapshot must equal the evaluation batch snapshot",
            existing_hash=str(durable_snapshot_id),
            new_hash=str(snapshot_id),
        )
    snapshot = session.execute(
        select(SettingsSnapshot).where(
            SettingsSnapshot.id == durable_snapshot_id,
            SettingsSnapshot.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()
    if snapshot is None:
        raise KeyError(f"snapshot {durable_snapshot_id} not found for tenant")
    normalized_claims = result_payload if isinstance(result_payload, dict) else {}
    claimed_snapshot_id = normalized_claims.get("settings_snapshot_id")
    if claimed_snapshot_id is not None and str(claimed_snapshot_id) != str(
        durable_snapshot_id
    ):
        raise IdempotencyConflict(
            "result payload snapshot id must equal the batch snapshot",
            existing_hash=str(durable_snapshot_id),
            new_hash=str(claimed_snapshot_id),
        )
    claimed_content_hash = normalized_claims.get("settings_content_hash")
    if claimed_content_hash is not None and str(claimed_content_hash) != str(
        snapshot.content_hash
    ):
        raise IdempotencyConflict(
            "result payload snapshot hash must match the durable snapshot",
            existing_hash=str(snapshot.content_hash),
            new_hash=str(claimed_content_hash),
        )
    result_hash = _result_identity(
        methodology_version, durable_snapshot_id, status, result_payload
    )
    same = session.execute(
        select(EvaluationResult).where(
            EvaluationResult.evaluation_id == evaluation_id,
            EvaluationResult.tenant_id == tenant_id,
            EvaluationResult.methodology_version == methodology_version,
            EvaluationResult.snapshot_id == durable_snapshot_id,
            EvaluationResult.status == status,
            EvaluationResult.result_hash == result_hash,
        )
    ).scalar_one_or_none()
    if row.status == "succeeded":
        if same is None:
            existing_version = (
                session.execute(
                    select(func.max(EvaluationResult.version)).where(
                        EvaluationResult.evaluation_id == evaluation_id,
                        EvaluationResult.tenant_id == tenant_id,
                    )
                ).scalar()
                or 0
            )
            raise TerminalReplay(
                f"evaluation {evaluation_id} already has a terminal result",
                existing_version=int(existing_version),
            )
        return same, False
    _check_locked_lease(
        row,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=current,
        allowed={"claimed", "running"},
    )
    if same is not None:
        row.status = "succeeded"
        row.result_status = status
        row.lease_owner = None
        row.lease_token = None
        row.lease_expires_at = None
        row.error_code = None
        row.updated_at = current
        session.flush()
        _refresh_batch_counts(session, tenant_id, row.batch_id)
        return same, False
    latest_version = session.execute(
        select(func.max(EvaluationResult.version)).where(
            EvaluationResult.evaluation_id == evaluation_id,
            EvaluationResult.tenant_id == tenant_id,
        )
    ).scalar() or 0
    record = EvaluationResult(
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        version=latest_version + 1,
        methodology_version=methodology_version,
        snapshot_id=durable_snapshot_id,
        status=status,
        result_payload=canonical_json(result_payload),
        result_hash=result_hash,
    )
    session.add(record)
    session.flush()
    row.status = "succeeded"
    row.result_status = status
    row.lease_owner = None
    row.lease_token = None
    row.lease_expires_at = None
    row.error_code = None
    row.updated_at = current
    session.flush()
    _refresh_batch_counts(session, tenant_id, row.batch_id)
    return record, True


def save_checkpoint(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_token: uuid.UUID,
    lease_generation: int,
    checkpoint: dict,
    now: datetime | None = None,
) -> None:
    row = _require_active_lease(
        session,
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        lease_owner=lease_owner,
        lease_token=lease_token,
        lease_generation=lease_generation,
        now=now,
        allowed={"claimed", "running"},
    )
    current = now or _utcnow()
    row.checkpoint = canonical_json(checkpoint)
    row.updated_at = current
    session.flush()


def _refresh_batch_counts(
    session: Session, tenant_id: str, batch_id: uuid.UUID
) -> None:
    """Serialize terminal counter refresh under deterministic locks.

    One evaluation completion per transaction: callers hold the evaluation
    row lock, then this helper takes the batch row lock (eval then batch
    ordering everywhere), so concurrent completions serialize on the batch
    row instead of deadlocking.
    """
    session.execute(
        text(
            "SELECT id FROM v4_batches "
            "WHERE id = :id AND tenant_id = :tenant FOR UPDATE"
        ),
        {"id": batch_id, "tenant": tenant_id},
    )
    with session.no_autoflush:
        batch = session.execute(
            select(Batch)
            .where(Batch.id == batch_id, Batch.tenant_id == tenant_id)
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
    if batch is None:
        raise KeyError(str(batch_id))
    succeeded = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(
                Evaluation.batch_id == batch_id,
                Evaluation.tenant_id == tenant_id,
                Evaluation.status == "succeeded",
            )
        ).scalar()
        or 0
    )
    failed = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(
                Evaluation.batch_id == batch_id,
                Evaluation.tenant_id == tenant_id,
                Evaluation.status.in_(["failed", "dead"]),
            )
        ).scalar()
        or 0
    )
    total = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(
                Evaluation.batch_id == batch_id,
                Evaluation.tenant_id == tenant_id,
            )
        ).scalar()
        or 0
    )
    if not 1 <= total <= 50:
        raise ValueError("batch total out of range 1..50")
    batch.succeeded_count = succeeded
    batch.failed_count = failed
    batch.total_count = total
    remaining = total - succeeded - failed
    if remaining <= 0:
        if failed == 0:
            batch.status = "succeeded"
        elif succeeded == 0:
            batch.status = "failed"
        else:
            batch.status = "partial"
    elif succeeded or failed:
        batch.status = "running"
    else:
        batch.status = "pending"
    batch.updated_at = _utcnow()
    session.flush()


def get_batch_progress(
    session: Session, *, tenant_id: str, batch_id: uuid.UUID
) -> dict:
    _check_tenant(tenant_id)
    batch = session.execute(
        select(Batch).where(Batch.id == batch_id, Batch.tenant_id == tenant_id)
    ).scalar_one_or_none()
    if batch is None:
        raise KeyError(str(batch_id))
    _refresh_batch_counts(session, tenant_id, batch_id)
    session.refresh(batch)
    return {
        "batch_id": str(batch.id),
        "tenant_id": batch.tenant_id,
        "status": batch.status,
        "total": int(batch.total_count),
        "succeeded": int(batch.succeeded_count),
        "failed": int(batch.failed_count),
    }


def get_evaluation(
    session: Session, *, tenant_id: str, evaluation_id: uuid.UUID
) -> Evaluation:
    _check_tenant(tenant_id)
    row = session.execute(
        select(Evaluation).where(
            Evaluation.id == evaluation_id,
            Evaluation.tenant_id == tenant_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise KeyError(str(evaluation_id))
    return row


class IdempotencyStore:
    """Tenant-scoped idempotency helper backed by PostgreSQL rows."""

    def __init__(self, session: Session):
        self._session = session

    def check_or_reserve_batch(
        self,
        *,
        tenant_id: str,
        idempotency_key: str,
        request_payload: dict,
        items: list[dict] | None = None,
        snapshot_id: uuid.UUID | None = None,
    ) -> tuple[str, bool]:
        _check_tenant(tenant_id)
        if items is not None and snapshot_id is not None:
            request_hash = _batch_request_hash(list(items), snapshot_id, request_payload)
        else:
            request_hash = canonical_hash(canonical_json(request_payload))
        existing = self._session.execute(
            select(Batch).where(
                Batch.tenant_id == tenant_id,
                Batch.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing is None:
            return request_hash, False
        if existing.request_hash != request_hash:
            raise IdempotencyConflict(
                "batch idempotency key reused with different payload",
                existing_hash=existing.request_hash,
                new_hash=request_hash,
            )
        return existing.request_hash, True

    def record_evaluation_conflict(
        self, *, tenant_id: str, idempotency_key: str, request_payload: dict
    ) -> None:
        _check_tenant(tenant_id)
        request_hash = canonical_hash(canonical_json(request_payload))
        existing = self._session.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant_id,
                Evaluation.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing is None:
            return
        if existing.request_hash != request_hash:
            raise IdempotencyConflict(
                "evaluation idempotency key reused with different payload",
                existing_hash=existing.request_hash,
                new_hash=request_hash,
            )
