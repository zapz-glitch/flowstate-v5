"""Shadow predictions: score stored reports without touching production.

For each ideal report, CDARV re-scores the candidate pool, picks its own
top-k selection, and derives a shadow ARV using the same methodology the
pipeline reports (mean comp $/sqft × subject sqft). Results land in
`shadow_predictions` keyed by model version — reviewable, replayable, and
never written back to the report database.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .features import extract_comp_features
from .model import load_artifact, score
from .reports import parse_report
from .store import Store

DEFAULT_TOP_K = 3


@dataclass
class ShadowOutcome:
    report_id: str
    prediction: dict[str, Any]


def _shadow_arv(selected: list[dict[str, Any]], subject_sqft: float | None) -> float | None:
    ppsf = [c["price_per_sqft"] for c in selected if c.get("price_per_sqft")]
    if not ppsf or not subject_sqft:
        return None
    return round(sum(ppsf) / len(ppsf) * subject_sqft, 2)


def score_report(report, artifact: dict[str, Any], top_k: int = DEFAULT_TOP_K) -> dict[str, Any]:
    """Produce the shadow selection for one parsed report."""
    features = [extract_comp_features(report, comp) for comp in report.comps]
    probs = score(artifact, features)

    ranked = sorted(
        zip(report.comps, probs, strict=True),
        key=lambda pair: pair[1],
        reverse=True,
    )
    k = min(top_k, len(ranked))
    selection = ranked[:k]

    selected_payload: list[dict[str, Any]] = []
    for comp, p in selection:
        ppsf = comp.raw.get("pricePerSqft")
        selected_payload.append(
            {
                "comp_id": comp.comp_id,
                "score": round(float(p), 6),
                "price_per_sqft": ppsf if isinstance(ppsf, (int, float)) else None,
                "sale_price": comp.raw.get("salePrice"),
                "distance_miles": comp.raw.get("distanceMiles"),
                "actually_selected": comp.label_selected,
            }
        )

    subject_sqft = report.subject.get("squareFeet")
    shadow_arv = _shadow_arv(
        selected_payload,
        float(subject_sqft) if isinstance(subject_sqft, (int, float)) else None,
    )
    actual_arv = report.arv

    true_ids = {c.comp_id for c in report.comps if c.label_arv}
    picked_ids = {c["comp_id"] for c in selected_payload}

    return {
        "model_target": artifact["target"],
        "top_k": k,
        "scores": {comp.comp_id: round(float(p), 6) for comp, p in zip(report.comps, probs)},
        "selected": selected_payload,
        "shadow_arv": shadow_arv,
        "actual_arv": actual_arv,
        "arv_delta": (
            round(shadow_arv - actual_arv, 2)
            if shadow_arv is not None and actual_arv is not None
            else None
        ),
        "overlap_with_actual": len(true_ids & picked_ids),
        "actual_selected_count": len(true_ids),
    }


def run_shadow(
    store: Store,
    *,
    model_ref: str = "latest",
    report_id: str | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> list[ShadowOutcome]:
    with store.connect() as conn:
        version = store.get_model_version(conn, model_ref)
        if version is None:
            raise RuntimeError(f"model version '{model_ref}' not found — train first")
        artifact = load_artifact(version["artifact_path"])

        rows = conn.execute(
            "SELECT * FROM ideal_reports WHERE report_id = ?" if report_id
            else "SELECT * FROM ideal_reports ORDER BY report_created_at, report_id",
            (report_id,) if report_id else (),
        ).fetchall()

        outcomes: list[ShadowOutcome] = []
        for row in rows:
            report = parse_report(
                report_id=row["report_id"],
                user_id=row["user_id"],
                created_at=row["report_created_at"],
                report_json=row["report_json"],
                job_id=row["job_id"],
                address=row["address"],
                feedback_status=row["feedback_status"],
                feedback_at=row["feedback_at"],
            )
            prediction = score_report(report, artifact, top_k=top_k)
            store.upsert_shadow(
                conn,
                model_version_id=version["id"],
                report_id=row["report_id"],
                prediction=prediction,
            )
            outcomes.append(ShadowOutcome(report_id=row["report_id"], prediction=prediction))
        return outcomes


__all__ = ["DEFAULT_TOP_K", "ShadowOutcome", "run_shadow", "score_report"]
