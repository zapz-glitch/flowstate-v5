"""Review workflow: corrections, structured labels, approvals.

Review versions are immutable once created — a later correction starts a
new version against the same snapshot. The original evaluator result in
the snapshot is never touched by review activity.

Statuses: needs_review → approved | needs_more_evidence | excluded.
Approval scopes are independent: a review can approve comp_ranking
without endorsing the ARV for benchmarking.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..persistence.models import (
    Approval,
    CompLabel,
    ExternalComp,
    Preference,
    Review,
    Snapshot,
)
from .labels import COMP_LABELS, LABEL_REASONS


class ReviewError(ValueError):
    pass


def open_review(session: Session, *, snapshot_id: str, reviewer_id: str) -> tuple[Review, str]:
    """Start (or reopen) review work on a snapshot.

    If the latest review is still open ('needs_review'/'needs_more_evidence')
    it is returned as-is — reopening is idempotent. A decided review
    (approved/excluded) yields a NEW version so history is preserved.
    """
    snapshot = session.get(Snapshot, snapshot_id)
    if snapshot is None:
        raise ReviewError("snapshot not found")
    if snapshot.status == "excluded":
        raise ReviewError("snapshot is excluded — reopen by new submission")

    latest = session.execute(
        select(Review).where(Review.snapshot_id == snapshot_id)
        .order_by(Review.version.desc()).limit(1)
    ).scalar_one_or_none()

    if latest and latest.status in ("needs_review", "needs_more_evidence"):
        snapshot.status = "needs_review" if snapshot.status == "submitted" else snapshot.status
        session.flush()
        return latest, "reused"

    review = Review(
        snapshot_id=snapshot_id,
        version=(latest.version + 1) if latest else 1,
        status="needs_review",
        reviewer_id=reviewer_id,
    )
    session.add(review)
    snapshot.status = "needs_review"
    session.flush()
    return review, "created"


def get_review(session: Session, review_id: str) -> Review | None:
    return session.get(Review, review_id)


def _require_open(review: Review) -> None:
    if review.status not in ("needs_review", "needs_more_evidence"):
        raise ReviewError(f"review is {review.status} — open a new version to correct")


def set_comp_labels(
    session: Session,
    review: Review,
    labels: list[dict],
) -> int:
    """Upsert reviewer labels. Each item:
    {comp_id, label, reasons[], note?}. Unlabeled comps keep their prior
    state (default not_reviewed) — nothing is auto-labeled."""
    _require_open(review)
    count = 0
    for item in labels:
        label = item.get("label")
        if label not in COMP_LABELS:
            raise ReviewError(f"invalid label '{label}'")
        reasons = item.get("reasons") or []
        bad = [r for r in reasons if r not in LABEL_REASONS]
        if bad:
            raise ReviewError(f"invalid reasons: {bad}")
        comp_id = str(item.get("comp_id") or "")
        if not comp_id:
            raise ReviewError("comp_id required")

        row = session.execute(
            select(CompLabel).where(
                CompLabel.review_id == review.id, CompLabel.comp_id == comp_id
            )
        ).scalar_one_or_none()
        if row is None:
            row = CompLabel(review_id=review.id, comp_id=comp_id,
                            transaction_key=item.get("transaction_key"),
                            label=label, reasons_json=list(reasons),
                            note=item.get("note"))
            session.add(row)
        else:
            row.label = label
            row.reasons_json = list(reasons)
            row.note = item.get("note")
            if item.get("transaction_key"):
                row.transaction_key = item["transaction_key"]
        count += 1
    session.flush()
    return count


def add_preference(
    session: Session, review: Review, *,
    preferred_comp_id: str, over_comp_id: str,
    reasons: list[str] | None = None, note: str | None = None,
) -> Preference:
    """Record "prefer B over A for this subject+target, because …"."""
    _require_open(review)
    if preferred_comp_id == over_comp_id:
        raise ReviewError("a comp cannot be preferred over itself")
    pref = Preference(
        review_id=review.id,
        preferred_comp_id=preferred_comp_id,
        over_comp_id=over_comp_id,
        reasons_json=list(reasons or []),
        note=note,
    )
    session.add(pref)
    session.flush()
    return pref


def add_external_comp(
    session: Session, review: Review, *,
    source: str, transaction: dict, availability_date: str,
    note: str | None = None,
) -> ExternalComp:
    """Register a comparable outside the original pool. Source, transaction
    identity, and the date the evidence was available are mandatory —
    an added comp must never pretend to have existed earlier than it did."""
    _require_open(review)
    if not source or not transaction or not availability_date:
        raise ReviewError("source, transaction, and availability_date are required")
    row = ExternalComp(
        review_id=review.id, source=source,
        transaction_json=transaction, availability_date=availability_date,
        note=note,
    )
    session.add(row)
    session.flush()
    return row


def decide(
    session: Session, review: Review, *,
    action: str,
    reviewer_id: str,
    comp_ranking: bool = False,
    valuation_benchmark: bool = False,
    gold_standard: bool = False,
    gold_standard_evidence: str | None = None,
    note: str | None = None,
) -> Review:
    """Decide a review: 'approve' | 'needs_more_evidence' | 'exclude'."""
    _require_open(review)
    if action not in ("approve", "needs_more_evidence", "exclude"):
        raise ReviewError(f"invalid action '{action}'")
    if gold_standard and not gold_standard_evidence:
        raise ReviewError("gold_standard requires supporting evidence")
    if action == "approve" and not (comp_ranking or valuation_benchmark):
        raise ReviewError("approval must name at least one scope")

    snapshot = session.get(Snapshot, review.snapshot_id)
    assert snapshot is not None

    if action == "needs_more_evidence":
        review.status = "needs_more_evidence"
        snapshot.status = "needs_more_evidence"
    elif action == "exclude":
        review.status = "excluded"
        snapshot.status = "excluded"
    else:
        review.status = "approved"
        snapshot.status = "approved"
        approval = Approval(
            review_id=review.id,
            comp_ranking_approved=comp_ranking,
            valuation_benchmark_approved=valuation_benchmark,
            gold_standard=gold_standard,
            gold_standard_by=reviewer_id if gold_standard else None,
            gold_standard_evidence=gold_standard_evidence,
            approved_by=reviewer_id,
        )
        session.add(approval)
    review.summary_note = note
    review.reviewer_id = reviewer_id
    session.flush()
    return review


def review_detail(session: Session, review: Review) -> dict:
    labels = session.execute(
        select(CompLabel).where(CompLabel.review_id == review.id)
    ).scalars().all()
    prefs = session.execute(
        select(Preference).where(Preference.review_id == review.id)
    ).scalars().all()
    externals = session.execute(
        select(ExternalComp).where(ExternalComp.review_id == review.id)
    ).scalars().all()
    approval = session.execute(
        select(Approval).where(Approval.review_id == review.id)
    ).scalar_one_or_none()
    return {
        "id": review.id,
        "snapshot_id": review.snapshot_id,
        "version": review.version,
        "status": review.status,
        "reviewer_id": review.reviewer_id,
        "summary_note": review.summary_note,
        "labels": [
            {"comp_id": l.comp_id, "transaction_key": l.transaction_key,
             "label": l.label, "reasons": l.reasons_json, "note": l.note}
            for l in labels
        ],
        "preferences": [
            {"preferred_comp_id": p.preferred_comp_id,
             "over_comp_id": p.over_comp_id,
             "reasons": p.reasons_json, "note": p.note}
            for p in prefs
        ],
        "external_comps": [
            {"id": e.id, "source": e.source, "transaction": e.transaction_json,
             "availability_date": e.availability_date, "note": e.note}
            for e in externals
        ],
        "approval": (
            {
                "comp_ranking": approval.comp_ranking_approved,
                "valuation_benchmark": approval.valuation_benchmark_approved,
                "gold_standard": approval.gold_standard,
                "gold_standard_by": approval.gold_standard_by,
                "gold_standard_evidence": approval.gold_standard_evidence,
                "approved_by": approval.approved_by,
            }
            if approval else None
        ),
    }


__all__ = [
    "ReviewError", "add_external_comp", "add_preference", "decide",
    "get_review", "open_review", "review_detail", "set_comp_labels",
]
