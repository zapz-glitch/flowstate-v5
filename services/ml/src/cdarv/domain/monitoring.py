"""Monitoring aggregates for the dashboard Performance view.

All numbers are descriptive: label coverage, market coverage, missing-data
rates, and prediction outcomes. Agreement-with-evaluator is reported as a
diagnostic, never as an accuracy claim.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..persistence.models import (
    CompLabel, Dataset, Model, Prediction, Review, Snapshot,
)


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

    return {
        "snapshots_by_status": {s: c for s, c in snaps},
        "labels_by_kind": {l: c for l, c in labels},
        "predictions_by_status": {s: c for s, c in preds},
        "independently_reviewed_reports": reviewed,
        "datasets": datasets,
        "models": models,
        "coverage_by_market": markets,
    }


__all__ = ["summary"]
