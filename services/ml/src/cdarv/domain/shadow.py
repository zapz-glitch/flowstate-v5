"""Shadow scoring: model ranks eligible comps; production math sets the ARV.

Eligibility is the stored appraisal-rule result — the model ranks among
eligible candidates and can never make an ineligible comp eligible. The
ARV comes from `POST /internal/cdarv/recalculate` on the production API
(`recalculateReport` — the same aggregation the dashboard uses), so CDARV
never reimplements valuation formulas.

Insufficient evidence is a first-class outcome: when the eligible pool is
empty the prediction is recorded as `insufficient_evidence`, not a number.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..persistence.models import Job, Model, Prediction, Snapshot
from ..reports import parse_report
from .features import extract_comp_features
from .training import load_artifact, score_features

DEFAULT_TOP_K = 3


class RecalcError(RuntimeError):
    pass


def _recalc(report_id: str, comp_ids: list[str]) -> dict[str, Any]:
    """Call the production API's internal recalc — existing math only."""
    base = os.environ.get("CDARV_TS_API_URL", "").rstrip("/")
    secret = os.environ.get("CDARV_TS_INTERNAL_SECRET", "")
    if not base or not secret:
        raise RecalcError("CDARV_TS_API_URL / CDARV_TS_INTERNAL_SECRET not configured")
    req = urllib.request.Request(
        f"{base}/internal/cdarv/recalculate",
        data=json.dumps({"reportId": report_id, "selectedCompIds": comp_ids}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-CDARV-Internal-Secret": secret,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def score_snapshot(
    session: Session, *, snapshot: Snapshot, model_row: Model,
    job: Job | None = None, top_k: int = DEFAULT_TOP_K,
) -> Prediction:
    report = parse_report(
        report_id=snapshot.report_id, user_id=snapshot.user_id,
        created_at=snapshot.provenance_json.get("report_created_at") or "",
        report_json=snapshot.report_json,
    )
    artifact = load_artifact(model_row)

    # Eligibility gate: only comps the appraisal rules passed are rankable.
    eligible = [c for c in report.comps if c.is_enabled]
    input_hash = snapshot.content_hash

    if not eligible:
        return _record(
            session, snapshot=snapshot, model_row=model_row, job=job,
            status="insufficient_evidence", selected=[], scores={},
            shadow_arv=None, recalc=None, input_hash=input_hash,
        )

    features = [extract_comp_features(report, c) for c in eligible]
    probs = score_features(artifact, features)
    ranked = sorted(zip(eligible, probs), key=lambda p: p[1], reverse=True)
    k = min(top_k, len(ranked))
    selected = ranked[:k]
    scores = {c.comp_id: round(float(p), 6) for c, p in ranked}
    selected_ids = [c.comp_id for c, _ in selected]

    recalc: dict[str, Any] | None = None
    shadow_arv: float | None = None
    status = "scored"
    try:
        recalc = _recalc(snapshot.report_id, selected_ids)
        valuation = recalc.get("valuation") if isinstance(recalc, dict) else None
        arv = (valuation or {}).get("arv") or recalc.get("arv")
        shadow_arv = float(arv) if isinstance(arv, (int, float)) else None
        if shadow_arv is None:
            status = "insufficient_evidence"
    except Exception as exc:
        status = "error"
        recalc = {"error": str(exc)}

    return _record(
        session, snapshot=snapshot, model_row=model_row, job=job,
        status=status, selected=selected_ids, scores=scores,
        shadow_arv=shadow_arv, recalc=recalc, input_hash=input_hash,
    )


def _record(
    session: Session, *, snapshot: Snapshot, model_row: Model,
    job: Job | None, status: str, selected: list[str], scores: dict,
    shadow_arv: float | None, recalc: dict | None, input_hash: str,
) -> Prediction:
    row = session.execute(
        select(Prediction).where(
            Prediction.snapshot_id == snapshot.id,
            Prediction.model_id == model_row.id,
        )
    ).scalar_one_or_none()
    if row is None:
        row = Prediction(snapshot_id=snapshot.id, model_id=model_row.id,
                         input_hash=input_hash)
        session.add(row)
    row.job_id = job.id if job else row.job_id
    row.status = status
    row.selected_comp_ids = selected
    row.scores_json = scores
    row.shadow_arv = shadow_arv
    row.recalc_json = recalc
    row.input_hash = input_hash
    session.flush()
    return row


__all__ = ["DEFAULT_TOP_K", "RecalcError", "score_snapshot"]
