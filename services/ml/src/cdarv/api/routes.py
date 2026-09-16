"""CDARV internal API — reached only via the apps/api /cdarv/* proxy.

Every route requires the internal bearer token (deps.require_internal).
The proxy supplies user/reviewer identity explicitly; this service never
sees dashboard sessions.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..domain import datasets as ds
from ..domain import monitoring, registry, reviews as rv, submissions as sub
from ..domain.features import extract_rule_context
from ..persistence.models import Dataset, Guidance, Job, Model, Prediction, Review
from ..persistence import repositories as repo
from ..reports import ReportParseError, parse_report
from .deps import get_session, require_internal
from .errors import ApiFailure
from .schemas import (
    ActivateShadowIn, BuildDatasetIn, DecideIn, ExternalCompIn, GuidanceIn,
    OpenReviewIn, PreferenceIn, ScoreShadowIn, SetLabelsIn, SubmissionIn,
    TrainIn,
)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_internal)])


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ApiFailure:
        raise
    except (rv.ReviewError, registry.RegistryError, ValueError) as exc:
        raise ApiFailure("BAD_REQUEST", str(exc), status_code=400) from exc
    except ReportParseError as exc:
        raise ApiFailure("BAD_REPORT", str(exc), status_code=422) from exc


def _not_found(what: str) -> ApiFailure:
    return ApiFailure("NOT_FOUND", f"{what} not found", status_code=404)


def _snapshot_out(s) -> dict:
    subject = s.report_json.get("subject") if isinstance(s.report_json, dict) else {}
    return {
        "id": s.id, "report_id": s.report_id, "job_id": s.job_id,
        "user_id": s.user_id, "version": s.version,
        "address": (subject or {}).get("address"),
        "content_hash": s.content_hash, "status": s.status,
        "completeness": s.completeness,
        "completeness_notes": s.completeness_notes,
        "provenance": s.provenance_json,
        "submitted_by": s.submitted_by,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _job_out(j: Job) -> dict:
    return {
        "id": j.id, "type": j.type, "status": j.status,
        "payload": j.payload_json, "result": j.result_json,
        "error_code": j.error_code, "error_detail": j.error_detail,
        "attempts": j.attempts,
        "created_at": j.created_at.isoformat() if j.created_at else None,
    }


def _model_out(m: Model) -> dict:
    return {
        "id": m.id, "name": m.name, "version": m.version,
        "dataset_id": m.dataset_id, "target": m.target,
        "feature_spec": m.feature_names_json,
        "metrics": m.metrics_json, "dataset_hash": m.dataset_hash,
        "status": m.status,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _dataset_out(d: Dataset) -> dict:
    return {
        "id": d.id, "name": d.name, "version": d.version,
        "manifest": d.manifest_json,
        "feature_spec_version": d.feature_spec_version,
        "code_version": d.code_version,
        "split_summary": d.split_summary_json,
        "geo_summary": d.geo_summary_json,
        "created_by": d.created_by,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def _prediction_out(p: Prediction) -> dict:
    return {
        "id": p.id, "snapshot_id": p.snapshot_id, "model_id": p.model_id,
        "status": p.status, "selected_comp_ids": p.selected_comp_ids,
        "scores": p.scores_json, "shadow_arv": p.shadow_arv,
        "recalc": p.recalc_json, "input_hash": p.input_hash,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


# ─── Submissions / review queue ───────────────────────────────────────────────

@router.post("/submissions", status_code=201)
def submit(body: SubmissionIn, session: Session = Depends(get_session)):
    snap, outcome = _wrap(
        sub.submit_report, session,
        report_id=body.report_id, user_id=body.user_id,
        created_at=body.created_at, report_json=body.report_json,
        job_id=body.job_id, address=body.address,
        submitted_by=body.submitted_by,
        selection_history=body.selection_history,
    )
    return {"snapshot": _snapshot_out(snap), "outcome": outcome}


@router.get("/queue")
def queue(status: str | None = None, session: Session = Depends(get_session)):
    return {"snapshots": [_snapshot_out(s) for s in sub.list_queue(session, status)]}


@router.get("/snapshots/{snapshot_id}")
def snapshot_detail(snapshot_id: str, session: Session = Depends(get_session)):
    snap = sub.get_snapshot(session, snapshot_id)
    if snap is None:
        raise _not_found("snapshot")
    parsed = _wrap(
        parse_report,
        report_id=snap.report_id, user_id=snap.user_id,
        created_at=snap.provenance_json.get("report_created_at") or "",
        report_json=snap.report_json,
    )
    revs = session.execute(
        select(Review).where(Review.snapshot_id == snap.id)
        .order_by(Review.version.desc())
    ).scalars().all()
    return {
        "snapshot": _snapshot_out(snap),
        "review_packet": {
            "subject": parsed.subject,
            "valuation": parsed.valuation,
            # Rules as applied for this run + the operator's edit trail —
            # reviewers see what ran, what the user kept, and the variance.
            "applied_settings": (
                snap.report_json.get("appliedSettings")
                if isinstance(snap.report_json, dict) else None
            ),
            "selection_history": (snap.provenance_json or {}).get("selection_history") or [],
            "comps": [
                {
                    "comp_id": c.comp_id,
                    "transaction_key": c.transaction_key,
                    "raw": c.raw,
                    "rule_context": extract_rule_context(parsed, c),
                }
                for c in parsed.comps
            ],
        },
        "reviews": [
            {"id": r.id, "version": r.version, "status": r.status,
             "reviewer_id": r.reviewer_id,
             "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in revs
        ],
    }


# ─── Reviews ──────────────────────────────────────────────────────────────────

@router.post("/reviews", status_code=201)
def open_review(body: OpenReviewIn, session: Session = Depends(get_session)):
    review, outcome = _wrap(
        rv.open_review, session,
        snapshot_id=body.snapshot_id, reviewer_id=body.reviewer_id,
    )
    return {"review_id": review.id, "version": review.version,
            "status": review.status, "outcome": outcome}


@router.get("/reviews/{review_id}")
def get_review(review_id: str, session: Session = Depends(get_session)):
    review = rv.get_review(session, review_id)
    if review is None:
        raise _not_found("review")
    return {"review": rv.review_detail(session, review)}


@router.post("/reviews/{review_id}/labels")
def set_labels(review_id: str, body: SetLabelsIn,
               session: Session = Depends(get_session)):
    review = rv.get_review(session, review_id)
    if review is None:
        raise _not_found("review")
    count = _wrap(rv.set_comp_labels, session, review,
                  [l.model_dump() for l in body.labels])
    return {"labels_set": count}


@router.post("/reviews/{review_id}/preferences", status_code=201)
def add_pref(review_id: str, body: PreferenceIn,
             session: Session = Depends(get_session)):
    review = rv.get_review(session, review_id)
    if review is None:
        raise _not_found("review")
    pref = _wrap(
        rv.add_preference, session, review,
        preferred_comp_id=body.preferred_comp_id,
        over_comp_id=body.over_comp_id,
        reasons=body.reasons, note=body.note,
    )
    return {"preference_id": pref.id}


@router.post("/reviews/{review_id}/external-comps", status_code=201)
def add_external(review_id: str, body: ExternalCompIn,
                 session: Session = Depends(get_session)):
    review = rv.get_review(session, review_id)
    if review is None:
        raise _not_found("review")
    row = _wrap(
        rv.add_external_comp, session, review,
        source=body.source, transaction=body.transaction,
        availability_date=body.availability_date, note=body.note,
    )
    return {"external_comp_id": row.id}


@router.post("/reviews/{review_id}/decide")
def decide(review_id: str, body: DecideIn,
           session: Session = Depends(get_session)):
    review = rv.get_review(session, review_id)
    if review is None:
        raise _not_found("review")
    review = _wrap(
        rv.decide, session, review,
        action=body.action, reviewer_id=body.reviewer_id,
        comp_ranking=body.comp_ranking,
        valuation_benchmark=body.valuation_benchmark,
        gold_standard=body.gold_standard,
        gold_standard_evidence=body.gold_standard_evidence,
        note=body.note,
    )
    return {"review_id": review.id, "status": review.status}


# ─── Datasets ─────────────────────────────────────────────────────────────────

@router.post("/datasets", status_code=201)
def build_dataset(body: BuildDatasetIn, session: Session = Depends(get_session)):
    dataset = _wrap(
        ds.build_dataset, session,
        name=body.name, created_by=body.created_by, scope=body.scope,
        test_fraction=body.test_fraction, val_fraction=body.val_fraction,
        seed=body.seed,
    )
    return {"dataset": _dataset_out(dataset)}


@router.get("/datasets")
def list_datasets(session: Session = Depends(get_session)):
    rows = session.execute(
        select(Dataset).order_by(Dataset.name, Dataset.version.desc())
    ).scalars().all()
    return {"datasets": [_dataset_out(d) for d in rows]}


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str, session: Session = Depends(get_session)):
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise _not_found("dataset")
    return {"dataset": _dataset_out(dataset)}


# ─── Jobs / training ──────────────────────────────────────────────────────────

@router.post("/models/train", status_code=202)
def enqueue_train(body: TrainIn, session: Session = Depends(get_session)):
    if session.get(Dataset, body.dataset_id) is None:
        raise _not_found("dataset")
    job = repo.enqueue(session, "train_model",
                       {"dataset_id": body.dataset_id, "name": body.name})
    return {"job": _job_out(job)}


@router.get("/jobs")
def list_jobs(status: str | None = None, session: Session = Depends(get_session)):
    q = select(Job).order_by(Job.created_at.desc()).limit(200)
    if status:
        q = q.where(Job.status == status)
    return {"jobs": [_job_out(j) for j in session.execute(q).scalars()]}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, session: Session = Depends(get_session)):
    job = session.get(Job, job_id)
    if job is None:
        raise _not_found("job")
    return {"job": _job_out(job)}


@router.get("/models")
def list_models(session: Session = Depends(get_session)):
    return {"models": [_model_out(m) for m in registry.list_models(session)]}


@router.get("/models/{model_id}")
def get_model(model_id: str, session: Session = Depends(get_session)):
    model = session.get(Model, model_id)
    if model is None:
        raise _not_found("model")
    return {"model": _model_out(model)}


# ─── Shadow state / predictions ───────────────────────────────────────────────

@router.get("/shadow/state")
def get_shadow_state(session: Session = Depends(get_session)):
    return {"shadow": registry.shadow_state(session)}


@router.post("/shadow/activate")
def activate(body: ActivateShadowIn, session: Session = Depends(get_session)):
    return {"shadow": _wrap(
        registry.activate_shadow, session,
        model_id=body.model_id, activated_by=body.activated_by,
    )}


@router.post("/shadow/deactivate")
def deactivate(session: Session = Depends(get_session)):
    return {"shadow": registry.deactivate_shadow(session)}


@router.post("/shadow/score", status_code=202)
def score(body: ScoreShadowIn, session: Session = Depends(get_session)):
    if sub.get_snapshot(session, body.snapshot_id) is None:
        raise _not_found("snapshot")
    job = repo.enqueue(session, "shadow_score",
                       {"snapshot_id": body.snapshot_id})
    return {"job": _job_out(job)}


@router.get("/predictions")
def list_predictions(snapshot_id: str | None = None, model_id: str | None = None,
                     session: Session = Depends(get_session)):
    q = select(Prediction).order_by(Prediction.created_at.desc()).limit(500)
    if snapshot_id:
        q = q.where(Prediction.snapshot_id == snapshot_id)
    if model_id:
        q = q.where(Prediction.model_id == model_id)
    return {"predictions": [_prediction_out(p) for p in session.execute(q).scalars()]}


@router.get("/predictions/{prediction_id}")
def get_prediction(prediction_id: str, session: Session = Depends(get_session)):
    pred = session.get(Prediction, prediction_id)
    if pred is None:
        raise _not_found("prediction")
    return {"prediction": _prediction_out(pred)}


# ─── Monitoring / guidance ────────────────────────────────────────────────────

@router.get("/monitoring/summary")
def monitoring_summary(session: Session = Depends(get_session)):
    return {"summary": monitoring.summary(session)}


@router.get("/guidance")
def list_guidance(session: Session = Depends(get_session)):
    rows = session.execute(
        select(Guidance).order_by(Guidance.version.desc())
    ).scalars().all()
    return {"guidance": [
        {"id": g.id, "version": g.version, "title": g.title, "body": g.body,
         "examples": g.examples_json, "status": g.status,
         "created_by": g.created_by,
         "created_at": g.created_at.isoformat() if g.created_at else None}
        for g in rows
    ]}


@router.post("/guidance", status_code=201)
def create_guidance(body: GuidanceIn, session: Session = Depends(get_session)):
    existing = session.execute(
        select(Guidance.version).order_by(Guidance.version.desc()).limit(1)
    ).scalar()
    row = Guidance(
        version=(existing + 1) if existing else 1,
        title=body.title, body=body.body, examples_json=body.examples,
        status="active", created_by=body.created_by,
    )
    session.add(row)
    session.flush()
    return {"guidance_id": row.id, "version": row.version}


__all__ = ["router"]
