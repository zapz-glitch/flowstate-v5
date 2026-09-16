"""Monitoring aggregates for the dashboard Performance view.

All numbers are descriptive: label coverage, market coverage, missing-data
rates, and prediction outcomes. Agreement-with-evaluator is reported as a
diagnostic, never as an accuracy claim.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..persistence.models import (
    Approval, CompLabel, Dataset, Model, Prediction, Review, Snapshot,
)

_POSITIVE_LABELS = ("strong_arv", "usable_with_adjustment")


def _evaluator_selected(snapshot: Snapshot) -> set[str]:
    """Comp ids the original evaluator selected for ARV/as-is groups."""
    comps_block = snapshot.report_json.get("comps") or {}
    arv_ids = {str(v) for v in comps_block.get("afterRenovationCompIds") or []}
    as_is_ids = {str(v) for v in comps_block.get("asIsCompIds") or []}
    selected: set[str] = set()
    for item in comps_block.get("items") or []:
        if not isinstance(item, dict) or item.get("id") is None:
            continue
        cid = str(item["id"])
        if item.get("compGroup") in ("arv", "as_is") or cid in arv_ids or cid in as_is_ids:
            selected.add(cid)
    return selected


def _shadow_agreement(session: Session) -> dict:
    """Diagnostic agreement rates for scored shadow predictions.

    Two distinct signals, per the design contract:
    - agreement with the original evaluator's selection (diagnostic only —
      matching the rules engine is not the goal)
    - agreement with the latest human review's positive labels (the
      training signal)
    Outcome accuracy is intentionally absent: no verified renovated-resale
    outcomes exist yet.
    """
    preds = session.execute(
        select(Prediction).where(Prediction.status == "scored")
    ).scalars().all()

    # Latest review per snapshot → reviewer-accepted comp ids.
    latest_review: dict[str, str] = {}
    latest_version: dict[str, int] = {}
    for rev in session.execute(select(Review)).scalars():
        if rev.version >= latest_version.get(rev.snapshot_id, -1):
            latest_version[rev.snapshot_id] = rev.version
            latest_review[rev.snapshot_id] = rev.id
    accepted: dict[str, set[str]] = {}
    for snap_id, rev_id in latest_review.items():
        labels = session.execute(
            select(CompLabel.comp_id).where(
                CompLabel.review_id == rev_id,
                CompLabel.label.in_(_POSITIVE_LABELS),
            )
        ).scalars().all()
        accepted[snap_id] = set(labels)

    eval_scores: list[float] = []
    review_scores: list[float] = []
    n_reviewed = 0
    for pred in preds:
        chosen = set(pred.selected_comp_ids or [])
        if not chosen:
            continue
        snapshot = session.get(Snapshot, pred.snapshot_id)
        if snapshot is None:
            continue
        eval_sel = _evaluator_selected(snapshot)
        if eval_sel:
            eval_scores.append(len(chosen & eval_sel) / len(chosen | eval_sel))
        rev_sel = accepted.get(pred.snapshot_id)
        if rev_sel:
            n_reviewed += 1
            review_scores.append(len(chosen & rev_sel) / len(chosen))

    return {
        "scored_predictions": len(preds),
        "predictions_with_review": n_reviewed,
        "evaluator_jaccard_mean": (
            round(sum(eval_scores) / len(eval_scores), 4) if eval_scores else None
        ),
        "reviewer_overlap_mean": (
            round(sum(review_scores) / len(review_scores), 4) if review_scores else None
        ),
        "outcome_accuracy": "insufficient outcome data",
    }


def summary(session: Session) -> dict:
    snaps = session.execute(
        select(Snapshot.status, func.count()).group_by(Snapshot.status)
    ).all()
    labels = session.execute(
        select(CompLabel.label, func.count()).group_by(CompLabel.label)
    ).all()
    preds = session.execute(
        select(Prediction.status, func.count()).group_by(Prediction.status)
    ).all()

    # Coverage by market (state parsed from subject address tail).
    markets: dict[str, int] = {}
    for snap in session.execute(select(Snapshot)).scalars():
        address = (snap.report_json.get("subject") or {}).get("address") or ""
        parts = [p.strip() for p in address.split(",")]
        market = parts[-1] if len(parts) > 1 else "unknown"
        markets[market] = markets.get(market, 0) + 1

    datasets = session.execute(select(func.count()).select_from(Dataset)).scalar() or 0
    models = session.execute(select(func.count()).select_from(Model)).scalar() or 0
    reviewed = session.execute(
        select(func.count()).select_from(Review).where(Review.status == "approved")
    ).scalar() or 0
    gold = session.execute(
        select(func.count()).select_from(Approval).where(Approval.gold_standard.is_(True))
    ).scalar() or 0

    return {
        "snapshots_by_status": {s: c for s, c in snaps},
        "labels_by_kind": {l: c for l, c in labels},
        "predictions_by_status": {s: c for s, c in preds},
        "independently_reviewed_reports": reviewed,
        "gold_standard_reports": gold,
        "datasets": datasets,
        "models": models,
        "coverage_by_market": markets,
        "shadow_agreement": _shadow_agreement(session),
    }


__all__ = ["summary"]
