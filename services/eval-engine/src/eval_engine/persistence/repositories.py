"""Repositories: idempotency, snapshots, queue claims, results, progress.

All queue semantics are PostgreSQL only. There is no SQLite fallback for
claim/lease behavior; callers must supply a PostgreSQL engine/session.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import canonical_hash
from .models import Batch, Evaluation, EvaluationResult, SettingsSnapshot, _utcnow


class IdempotencyConflict(Exception):
    def __init__(self, message: str, *, existing_hash: str, new_hash: str):
        super().__init__(message)
        self.existing_hash = existing_hash
        self.new_hash = new_hash


MAX_ATTEMPTS_DEFAULT = 5
LEASE_TTL = timedelta(minutes=5)
RETRY_BASE_DELAY = timedelta(seconds=30)
RETRY_MAX_DELAY = timedelta(hours=1)


def _retry_delay(attempts: int) -> timedelta:
    shift = min(max(0, attempts - 1), 10)
    delay = RETRY_BASE_DELAY * (2**shift)
    return min(delay, RETRY_MAX_DELAY)


@dataclass(frozen=True)
class Claim:
    evaluation_id: uuid.UUID
    tenant_id: str
    lease_owner: str
    attempts: int


def store_settings_snapshot(
    session: Session,
    *,
    tenant_id: str,
    snapshot_version: str,
    content: dict,
    source: dict | None = None,
) -> SettingsSnapshot:
    payload_hash = canonical_hash({"version": snapshot_version, "content": content})
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
        content=content,
        source=source or {},
    )
    session.add(row)
    session.flush()
    return row


def create_batch_with_evaluations(
    session: Session,
    *,
    tenant_id: str,
    idempotency_key: str,
    request_payload: dict,
    items: list[dict],
    snapshot_id: uuid.UUID | None = None,
) -> Batch:
    """Create a batch plus one evaluation row per property.

    Same key + same payload reuses the existing batch. Same key with a
    different payload raises IdempotencyConflict. Tenant scope is enforced
    by the unique constraint on (tenant_id, idempotency_key).
    """
    request_hash = canonical_hash(request_payload)
    existing = session.execute(
        select(Batch).where(
            Batch.tenant_id == tenant_id,
            Batch.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.request_hash != request_hash:
            raise IdempotencyConflict(
                "idempotency key reused with different payload",
                existing_hash=existing.request_hash,
                new_hash=request_hash,
            )
        return existing
    if not 1 <= len(items) <= 50:
        raise ValueError("batch must contain 1 to 50 property requests")
    batch = Batch(
        tenant_id=tenant_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        status="pending",
        total_count=len(items),
        snapshot_id=snapshot_id,
    )
    session.add(batch)
    session.flush()
    for item in items:
        payload = item.get("payload", item)
        key = str(item.get("idempotency_key", str(uuid.uuid4())))
        row_hash = canonical_hash(payload)
        dupe = session.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant_id,
                Evaluation.idempotency_key == key,
            )
        ).scalar_one_or_none()
        if dupe is not None:
            if dupe.request_hash != row_hash:
                raise IdempotencyConflict(
                    f"evaluation idempotency key reused: {key}",
                    existing_hash=dupe.request_hash,
                    new_hash=row_hash,
                )
            if dupe.batch_id != batch.id:
                raise IdempotencyConflict(
                    f"evaluation idempotency key already used: {key}",
                    existing_hash=dupe.request_hash,
                    new_hash=row_hash,
                )
            continue
        session.add(
            Evaluation(
                tenant_id=tenant_id,
                batch_id=batch.id,
                idempotency_key=key,
                request_hash=row_hash,
                status="queued",
                attempts=0,
                max_attempts=int(item.get("max_attempts", MAX_ATTEMPTS_DEFAULT)),
                next_attempt_at=_utcnow(),
                input_payload=payload if isinstance(payload, dict) else {"value": payload},
            )
        )
    session.flush()
    return batch


def claim_next_evaluation(
    session: Session,
    *,
    tenant_id: str,
    lease_owner: str,
    lease_ttl: timedelta = LEASE_TTL,
    now: datetime | None = None,
) -> Claim | None:
    """Atomically claim one due evaluation using row locks and SKIP LOCKED.

    PostgreSQL only. Returns None when no claimable row exists.
    """
    current = now or _utcnow()
    expires = current + lease_ttl
    row = session.execute(
        select(Evaluation)
        .where(
            Evaluation.tenant_id == tenant_id,
            Evaluation.status == "queued",
            (Evaluation.next_attempt_at.is_(None))
            | (Evaluation.next_attempt_at <= current),
            (Evaluation.lease_expires_at.is_(None))
            | (Evaluation.lease_expires_at <= current),
        )
        .order_by(Evaluation.next_attempt_at.asc().nulls_first(), Evaluation.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if row is None:
        return None
    row.status = "claimed"
    row.lease_owner = lease_owner
    row.lease_expires_at = expires
    row.last_heartbeat_at = current
    row.attempts = int(row.attempts) + 1
    row.updated_at = current
    session.flush()
    return Claim(
        evaluation_id=row.id,
        tenant_id=row.tenant_id,
        lease_owner=lease_owner,
        attempts=int(row.attempts),
    )


def heartbeat_lease(
    session: Session,
    *,
    evaluation_id: uuid.UUID,
    lease_owner: str,
    lease_ttl: timedelta = LEASE_TTL,
    now: datetime | None = None,
) -> bool:
    current = now or _utcnow()
    result = session.execute(
        update(Evaluation)
        .where(
            Evaluation.id == evaluation_id,
            Evaluation.lease_owner == lease_owner,
            Evaluation.status.in_(["claimed", "running"]),
        )
        .values(
            lease_expires_at=current + lease_ttl,
            last_heartbeat_at=current,
            updated_at=current,
        )
    )
    session.flush()
    return result.rowcount == 1


def mark_running(
    session: Session, *, evaluation_id: uuid.UUID, lease_owner: str
) -> bool:
    result = session.execute(
        update(Evaluation)
        .where(
            Evaluation.id == evaluation_id,
            Evaluation.lease_owner == lease_owner,
            Evaluation.status == "claimed",
        )
        .values(status="running", updated_at=_utcnow())
    )
    session.flush()
    return result.rowcount == 1


def recover_stale_leases(
    session: Session,
    *,
    tenant_id: str | None = None,
    now: datetime | None = None,
) -> int:
    """Return expired claimed/running leases to queued with bounded retry."""
    current = now or _utcnow()
    stmt = (
        update(Evaluation)
        .where(
            Evaluation.status.in_(["claimed", "running"]),
            Evaluation.lease_expires_at.is_not(None),
            Evaluation.lease_expires_at <= current,
        )
        .values(
            status="queued",
            lease_owner=None,
            lease_expires_at=None,
            error_code="lease_expired",
            updated_at=current,
        )
    )
    if tenant_id is not None:
        stmt = stmt.where(Evaluation.tenant_id == tenant_id)
    result = session.execute(stmt)
    session.flush()
    count = result.rowcount or 0
    if count:
        _apply_retry_schedule(session, current=current, tenant_id=tenant_id)
    return count


def _apply_retry_schedule(
    session: Session, *, current: datetime, tenant_id: str | None = None
) -> None:
    rows = session.execute(
        select(Evaluation).where(
            Evaluation.status == "queued",
            Evaluation.error_code == "lease_expired",
            *(
                [Evaluation.tenant_id == tenant_id]
                if tenant_id is not None
                else []
            ),
        )
    ).scalars()
    for row in rows:
        attempts = int(row.attempts)
        if attempts >= int(row.max_attempts):
            row.status = "dead"
            row.error_code = "max_attempts_exceeded"
        else:
            row.next_attempt_at = current + _retry_delay(attempts)
            row.error_code = None
        row.updated_at = current
    session.flush()


def fail_evaluation(
    session: Session,
    *,
    evaluation_id: uuid.UUID,
    error_code: str,
    error_detail: str = "",
    now: datetime | None = None,
) -> str:
    current = now or _utcnow()
    row = session.get(Evaluation, evaluation_id)
    if row is None:
        raise KeyError(str(evaluation_id))
    attempts = int(row.attempts)
    if attempts >= int(row.max_attempts):
        row.status = "dead"
    else:
        row.status = "queued"
        row.next_attempt_at = current + _retry_delay(attempts)
    row.lease_owner = None
    row.lease_expires_at = None
    row.error_code = error_code
    row.error_detail = error_detail
    row.updated_at = current
    session.flush()
    _refresh_batch_counts(session, row.batch_id)
    return row.status


def commit_result(
    session: Session,
    *,
    tenant_id: str,
    evaluation_id: uuid.UUID,
    methodology_version: str,
    snapshot_id: uuid.UUID | None,
    status: str,
    result_payload: dict,
    expected_version: int | None = None,
) -> EvaluationResult:
    """Idempotent versioned result commit.

    Re-committing the same payload hash returns the existing row instead of
    creating a duplicate version. A new payload creates version N+1.
    """
    if status not in {"succeeded", "failed", "incomplete"}:
        raise ValueError(f"invalid result status: {status}")
    row = session.get(Evaluation, evaluation_id)
    if row is None or row.tenant_id != tenant_id:
        raise KeyError(str(evaluation_id))
    result_hash = canonical_hash(
        {"methodology": methodology_version, "payload": result_payload}
    )
    latest_version = session.execute(
        select(func.max(EvaluationResult.version)).where(
            EvaluationResult.evaluation_id == evaluation_id
        )
    ).scalar() or 0
    if expected_version is not None and expected_version != latest_version + 1:
        raise IntegrityError(
            "result version conflict", params=None, orig=Exception("stale version")
        )
    same_payload = session.execute(
        select(EvaluationResult).where(
            EvaluationResult.evaluation_id == evaluation_id,
            EvaluationResult.result_hash == result_hash,
            EvaluationResult.methodology_version == methodology_version,
        )
    ).scalar_one_or_none()
    if same_payload is not None:
        return same_payload
    record = EvaluationResult(
        tenant_id=tenant_id,
        evaluation_id=evaluation_id,
        version=latest_version + 1,
        methodology_version=methodology_version,
        snapshot_id=snapshot_id,
        status=status,
        result_payload=result_payload,
        result_hash=result_hash,
    )
    session.add(record)
    session.flush()
    if status == "succeeded":
        row.status = "succeeded"
    elif status in {"failed", "incomplete"}:
        row.status = "failed"
    row.lease_owner = None
    row.lease_expires_at = None
    row.error_code = None
    row.updated_at = _utcnow()
    session.flush()
    _refresh_batch_counts(session, row.batch_id)
    return record


def save_checkpoint(
    session: Session, *, evaluation_id: uuid.UUID, checkpoint: dict
) -> None:
    row = session.get(Evaluation, evaluation_id)
    if row is None:
        raise KeyError(str(evaluation_id))
    row.checkpoint = checkpoint
    row.updated_at = _utcnow()
    session.flush()


def _refresh_batch_counts(session: Session, batch_id: uuid.UUID) -> None:
    succeeded = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(Evaluation.batch_id == batch_id, Evaluation.status == "succeeded")
        ).scalar()
        or 0
    )
    failed = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(
                Evaluation.batch_id == batch_id,
                Evaluation.status.in_(["failed", "dead"]),
            )
        ).scalar()
        or 0
    )
    total = (
        session.execute(
            select(func.count())
            .select_from(Evaluation)
            .where(Evaluation.batch_id == batch_id)
        ).scalar()
        or 0
    )
    batch = session.get(Batch, batch_id)
    if batch is None:
        return
    batch.succeeded_count = succeeded
    batch.failed_count = failed
    batch.total_count = total
    remaining = total - succeeded - failed
    if total and remaining <= 0:
        batch.status = "succeeded" if failed == 0 else ("failed" if succeeded == 0 else "partial")
    elif succeeded or failed:
        batch.status = "running"
    else:
        batch.status = "pending"
    batch.updated_at = _utcnow()
    session.flush()


def get_batch_progress(session: Session, *, tenant_id: str, batch_id: uuid.UUID) -> dict:
    batch = session.get(Batch, batch_id)
    if batch is None or batch.tenant_id != tenant_id:
        raise KeyError(str(batch_id))
    _refresh_batch_counts(session, batch_id)
    session.refresh(batch)
    return {
        "batch_id": str(batch.id),
        "tenant_id": batch.tenant_id,
        "status": batch.status,
        "total": int(batch.total_count),
        "succeeded": int(batch.succeeded_count),
        "failed": int(batch.failed_count),
    }


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
    ) -> tuple[str, bool]:
        request_hash = canonical_hash(request_payload)
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
        request_hash = canonical_hash(request_payload)
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
