"""Job queue: claim/lease semantics for the CDARV worker.

Single-statement atomic claim works on both Postgres and the SQLite test
profile (UPDATE ... RETURNING). Postgres deployments can additionally rely
on row locking; the lease fields fence a crashed worker's stale jobs via
lease_expires_at regardless.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .models import Job


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def enqueue(session: Session, job_type: str, payload: dict[str, Any]) -> Job:
    job = Job(type=job_type, payload_json=payload)
    session.add(job)
    session.flush()
    return job


def claim_next(session: Session, *, owner: str, lease_seconds: int = 300) -> Job | None:
    """Atomically claim the oldest runnable job (queued or expired lease)."""
    now = _utcnow()
    expiry = now + timedelta(seconds=lease_seconds)
    token = str(uuid.uuid4())
    stmt = (
        update(Job)
        .where(
            Job.id == select(Job.id)
            .where(
                Job.status == "queued",
                (Job.next_attempt_at.is_(None)) | (Job.next_attempt_at <= now),
            )
            .order_by(Job.created_at)
            .limit(1)
            .scalar_subquery()
        )
        .values(
            status="running",
            lease_owner=owner,
            lease_token=token,
            lease_expires_at=expiry,
            last_heartbeat_at=now,
            attempts=Job.attempts + 1,
        )
        .returning(Job)
        .execution_options(synchronize_session=False)
    )
    row = session.execute(stmt).scalar_one_or_none()
    if row is not None:
        # The UPDATE ran in SQL; refresh so the ORM object reflects the
        # claimed status (the identity map may hold pre-update attributes).
        session.refresh(row)
    return row


def complete(session: Session, job: Job, result: dict[str, Any]) -> None:
    job.status = "succeeded"
    job.result_json = result
    job.lease_owner = job.lease_token = None
    job.lease_expires_at = None
    session.flush()


def fail(session: Session, job: Job, code: str, detail: str,
         retry_seconds: int = 60) -> None:
    if job.attempts >= job.max_attempts:
        job.status = "dead"
    else:
        job.status = "queued"
        job.next_attempt_at = _utcnow() + timedelta(seconds=retry_seconds)
    job.error_code = code
    job.error_detail = detail[:4000]
    job.lease_owner = job.lease_token = None
    job.lease_expires_at = None
    session.flush()


def heartbeat(session: Session, job: Job, lease_seconds: int = 300) -> None:
    job.last_heartbeat_at = _utcnow()
    job.lease_expires_at = job.last_heartbeat_at + timedelta(seconds=lease_seconds)
    session.flush()


def recover_expired(session: Session) -> int:
    """Requeue running jobs whose lease expired (crashed worker)."""
    now = _utcnow()
    result = session.execute(
        update(Job)
        .where(Job.status == "running", Job.lease_expires_at < now)
        .values(status="queued", lease_owner=None, lease_token=None,
                lease_expires_at=None, next_attempt_at=now)
        .execution_options(synchronize_session=False)
    )
    session.flush()
    return int(result.rowcount or 0)


__all__ = ["claim_next", "complete", "enqueue", "fail", "heartbeat", "recover_expired"]
