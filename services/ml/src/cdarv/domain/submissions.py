"""Submission intake: report → versioned snapshot in the review queue.

Idempotent by (report_id, content_hash): sending the same unchanged report
twice returns the existing snapshot — never a duplicate example. If the
report changed upstream (e.g. comps re-selected then re-sent), a new
snapshot version is created and any prior un-reviewed work is preserved.
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..persistence.models import Job, Snapshot
from ..reports import ReportSnapshot, parse_report


def submit_report(
    session: Session,
    *,
    report_id: str,
    user_id: str,
    created_at: str,
    report_json: str | dict,
    job_id: str | None = None,
    address: str | None = None,
    submitted_by: str,
) -> tuple[Snapshot, str]:
    """Create or reuse a snapshot. Returns (snapshot, outcome) where
    outcome is 'created' | 'new_version' | 'duplicate'."""
    parsed = parse_report(
        report_id=report_id, user_id=user_id, created_at=created_at,
        report_json=report_json, job_id=job_id, address=address,
    )

    existing = session.execute(
        select(Snapshot).where(Snapshot.report_id == report_id)
        .order_by(Snapshot.version.desc())
    ).scalars().all()

    for snap in existing:
        if snap.content_hash == parsed.content_hash:
            return snap, "duplicate"

    snapshot = Snapshot(
        report_id=report_id,
        job_id=job_id,
        user_id=user_id,
        version=(existing[0].version + 1) if existing else 1,
        content_hash=parsed.content_hash,
        status="submitted",
        completeness=parsed.completeness,
        completeness_notes="; ".join(parsed.completeness_notes) or None,
        report_json=json.loads(parsed.raw_json),
        provenance_json=parsed.provenance,
        submitted_by=submitted_by,
    )
    session.add(snapshot)
    session.flush()
    return snapshot, "new_version" if existing else "created"


def enqueue_shadow_score(session: Session, snapshot_id: str) -> Job:
    job = Job(type="shadow_score", payload_json={"snapshot_id": snapshot_id})
    session.add(job)
    session.flush()
    return job


def list_queue(session: Session, status: str | None = None) -> list[Snapshot]:
    q = select(Snapshot).order_by(Snapshot.created_at.desc())
    if status:
        q = q.where(Snapshot.status == status)
    return list(session.execute(q).scalars())


def get_snapshot(session: Session, snapshot_id: str) -> Snapshot | None:
    return session.get(Snapshot, snapshot_id)


__all__ = [
    "enqueue_shadow_score",
    "get_snapshot",
    "list_queue",
    "submit_report",
]
