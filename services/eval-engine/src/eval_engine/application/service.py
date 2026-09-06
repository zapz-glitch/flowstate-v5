"""Durable application service: validate in memory, persist, return 202.

POST never claims, evaluates, or commits results. It authenticates,
validates the full body in memory (1..50 typed property requests plus one
immutable settings snapshot, both evidence modes), then persists the
snapshot, batch, and all jobs in one short transaction and returns 202
with initial QUEUED ids. Processing happens only past the worker
boundary (V4-103B); tests use the explicit test helper, never the
request path.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..contracts import EvaluationRequestV4
from ..contracts.comps import CompCandidateV4
from ..contracts.deal import (
    AdditionalRenovationItemV4,
    MajorItemEvidenceV4,
)
from ..contracts.settings import snapshot_store_parts
from ..contracts.subject import SubjectPropertyV4
from ..persistence import repositories as repo
from ..persistence.models import Evaluation, EvaluationResult
from ..api.errors import ApiFailure

_EVIDENCE_MODES = ("preloaded", "provider_pending")

_EXECUTION_TO_API = {
    "queued": "QUEUED",
    "claimed": "RUNNING",
    "running": "RUNNING",
    "succeeded": "COMPLETED",
    "failed": "FAILED",
    "dead": "FAILED",
}

_RESULT_TO_API = {
    "VALUED": "COMPLETED",
    "REVIEW_REQUIRED": "REVIEW_REQUIRED",
    "INSUFFICIENT_COMPS": "INSUFFICIENT_COMPS",
    "INSUFFICIENT_INVESTOR_DATA": "INSUFFICIENT_INVESTOR_DATA",
    "INCOMPLETE": "INCOMPLETE",
    "FAILED": "FAILED",
}


def execution_status(execution: str, result_status: str | None) -> str:
    if execution == "succeeded" and result_status in _RESULT_TO_API:
        return _RESULT_TO_API[result_status]
    return _EXECUTION_TO_API.get(execution, execution)


def _validate_property_shapes(body: dict) -> tuple[list[dict], dict, str]:
    from ..api.schemas import BatchSubmitRequest

    try:
        request = BatchSubmitRequest(**body)
    except Exception as exc:
        raise ApiFailure("VALIDATION_ERROR", "batch must contain 1 to 50 property requests", status_code=422) from exc
    mode = request.candidate_evidence_mode
    if mode not in _EVIDENCE_MODES:
        raise ApiFailure("VALIDATION_ERROR", "candidate_evidence_mode must be preloaded or provider_pending", status_code=422)
    keys = [str(item.idempotency_key).strip() for item in request.evaluations]
    if any(not key for key in keys) or len(set(keys)) != len(keys):
        raise ApiFailure("VALIDATION_ERROR", "each property requires a unique idempotency key", status_code=422)
    try:
        snapshot_in = request.settings.validated_for_durable_use()
    except ValueError as exc:
        raise ApiFailure("VALIDATION_ERROR", "invalid settings snapshot", status_code=422) from exc
    typed_items: list[dict] = []
    for item in request.evaluations:
        try:
            subject = SubjectPropertyV4(**item.subject)
            comps = [CompCandidateV4(**raw) for raw in item.comps]
            EvaluationRequestV4(
                subject=subject,
                comps=comps,
                renovation_level=item.renovation_level,
                settings=snapshot_in,
                major_item_evidence=list(item.major_item_evidence),
                additional_items=list(item.additional_items),
                evaluation_date=item.evaluation_date,
            )
        except Exception as exc:
            raise ApiFailure("VALIDATION_ERROR", "invalid property evaluation request", status_code=422) from exc
        typed_items.append(
            {
                "idempotency_key": str(item.idempotency_key),
                "payload": {
                    "subject": dict(item.subject),
                    "comps": list(item.comps),
                    "renovation_level": item.renovation_level,
                    "major_item_evidence": [entry.model_dump(mode="json") for entry in item.major_item_evidence],
                    "additional_items": [entry.model_dump(mode="json") for entry in item.additional_items],
                    "evaluation_date": item.evaluation_date,
                    "evidence_mode": mode,
                    "acquisition": {"subject": dict(item.subject), "comps": list(item.comps)},
                },
                "checkpoint": {"evidence_mode": mode, "stage": "queued"},
            }
        )
    meta = {
        "settings": request.settings.model_dump(mode="json"),
        "count": len(typed_items),
        "evidence_mode": mode,
    }
    return typed_items, meta, mode


def submit_batch(
    session: Session,
    *,
    tenant_id: str,
    requested_by_user_id: str,
    batch_key: str,
    body: dict,
) -> tuple[object, bool, list[dict]]:
    if not requested_by_user_id or not requested_by_user_id.strip():
        raise ApiFailure("VALIDATION_ERROR", "requesting user is required", status_code=422)
    items, meta, _ = _validate_property_shapes(body)
    from ..api.schemas import BatchSubmitRequest

    request = BatchSubmitRequest(**body)
    version, content, source = snapshot_store_parts(request.settings.validated_for_durable_use())
    snapshot = repo.store_settings_snapshot(
        session, tenant_id=tenant_id, snapshot_version=version, content=content, source=source
    )
    session.flush()
    try:
        batch, created = repo.create_batch_with_evaluations(
            session,
            tenant_id=tenant_id,
            requested_by_user_id=requested_by_user_id,
            idempotency_key=batch_key,
            request_payload=meta,
            items=items,
            snapshot_id=snapshot.id,
        )
    except repo.IdempotencyConflict as exc:
        raise ApiFailure("IDEMPOTENCY_CONFLICT", "idempotency key reused with different payload", status_code=409) from exc
    except ValueError as exc:
        raise ApiFailure("VALIDATION_ERROR", str(exc), status_code=422) from exc
    session.flush()
    rows = (
        session.execute(
            select(Evaluation).where(
                Evaluation.batch_id == batch.id,
                Evaluation.tenant_id == tenant_id,
                Evaluation.requested_by_user_id == requested_by_user_id,
            )
        )
        .scalars()
        .all()
    )
    by_key = {row.idempotency_key: row for row in rows}
    summaries: list[dict] = []
    for entry in items:
        row = by_key[entry["idempotency_key"]]
        summaries.append(
            {
                "evaluation_id": str(row.id),
                "idempotency_key": entry["idempotency_key"],
                "status": "QUEUED",
                "created_or_reused": "created" if created else "reused",
            }
        )
    return batch, created, summaries


def _claim_owned_evaluation(
    session: Session, *, tenant_id: str, requested_by_user_id: str,
    evaluation_id: str | None = None,
):
    """Test-boundary lease via the separately named trusted queue method."""
    return repo.claim_owned_evaluation_trusted_queue(
        session, tenant_id=tenant_id, requested_by_user_id=requested_by_user_id,
        evaluation_id=evaluation_id,
    )


def process_queued_evaluations(
    session: Session, *, tenant_id: str, requested_by_user_id: str, batch_id: object
) -> int:
    """Test/worker-boundary helper: process queued jobs past commit.

    Lives outside the request path so disconnect tests prove committed
    jobs are processed independently. Uses the durable domain evaluator;
    V4-103B owns per-property execution isolation and retries.
    """
    from ..contracts.settings import to_persistence_status
    from ..domain.evaluate import evaluate_v4

    session.expire_all()
    targets = (
        session.execute(
            select(Evaluation.id).where(
                Evaluation.batch_id == batch_id,
                Evaluation.tenant_id == tenant_id,
                Evaluation.requested_by_user_id == requested_by_user_id,
                Evaluation.status == "queued",
            )
            .order_by(Evaluation.created_at, Evaluation.id)
        )
        .scalars()
        .all()
    )
    owner_seen: set[str] = set()
    ordered_ids: list[str] = []
    for candidate in targets:
        text_id = str(candidate)
        if text_id not in owner_seen:
            owner_seen.add(text_id)
            ordered_ids.append(text_id)
    session.expire_all()
    processed = 0
    for eval_id in ordered_ids:
        try:
            live = session.execute(
                select(Evaluation).where(
                    Evaluation.id == eval_id,
                    Evaluation.tenant_id == tenant_id,
                    Evaluation.requested_by_user_id == requested_by_user_id,
                )
            ).scalar_one_or_none()
        except Exception:
            session.rollback()
            continue
        if live is None or live.status != "queued" or str(live.batch_id) != str(batch_id):
            continue
        claimed = _claim_owned_evaluation(
            session, tenant_id=tenant_id, requested_by_user_id=requested_by_user_id,
            evaluation_id=eval_id,
        )
        if claimed is None:
            session.rollback()
            continue
        claim, target = claimed
        if str(target.batch_id) != str(batch_id):
            session.rollback()
            continue
        stored = dict(target.input_payload or {})
        subject = SubjectPropertyV4(**stored.get("subject", {}))
        comps = [CompCandidateV4(**raw) for raw in stored.get("comps", [])]
        from ..persistence.models import Batch as BatchModel
        from ..persistence.models import SettingsSnapshot as SnapshotModel

        batch_row = session.execute(
            select(BatchModel).where(BatchModel.id == target.batch_id)
        ).scalar_one()
        snap = session.execute(
            select(SnapshotModel).where(SnapshotModel.id == batch_row.snapshot_id)
        ).scalar_one()
        import json as _json

        envelope = {
            "version": snap.snapshot_version,
            "content": snap.content,
            "source": snap.source,
        }
        settings_dict = dict(envelope["content"])
        settings_dict["snapshot_id"] = str(snap.id)
        settings_dict["content_hash"] = str(snap.content_hash)
        settings_dict["schema_version"] = envelope["version"]
        settings_dict["source_timestamps"] = dict((envelope["source"] or {}).get("source_timestamps", {}))
        from ..contracts.settings import SettingsSnapshotV4

        settings = SettingsSnapshotV4(**settings_dict)
        typed = EvaluationRequestV4(
            subject=subject,
            comps=comps,
            renovation_level=stored.get("renovation_level", ""),
            settings=settings,
            major_item_evidence=[MajorItemEvidenceV4(**raw) for raw in stored.get("major_item_evidence", [])],
            additional_items=[AdditionalRenovationItemV4(**raw) for raw in stored.get("additional_items", [])],
            evaluation_date=stored.get("evaluation_date"),
        )
        result = evaluate_v4(typed)
        bound = dict(result.model_dump(mode="json"))
        bound["settings_snapshot_id"] = str(snap.id)
        bound["settings_content_hash"] = str(snap.content_hash)
        try:
            repo.commit_result(
                session, tenant_id=tenant_id, evaluation_id=target.id,
                lease_owner=claim.lease_owner, lease_token=claim.lease_token,
                lease_generation=claim.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=snap.id,
                status=to_persistence_status(result.status), result_payload=bound,
            )
        except Exception:
            session.rollback()
            continue
        try:
            session.commit()
        except Exception:
            session.rollback()
            continue
        processed += 1
    return processed


def read_evaluation(
    session: Session, *, tenant_id: str, requested_by_user_id: str, evaluation_id: str
) -> dict:
    import uuid as _uuid

    try:
        parsed = _uuid.UUID(str(evaluation_id))
    except ValueError as exc:
        raise ApiFailure("NOT_FOUND", "evaluation not found", status_code=404) from exc
    try:
        row = repo.get_evaluation(
            session, tenant_id=tenant_id, requested_by_user_id=requested_by_user_id,
            evaluation_id=parsed,
        )
    except KeyError as exc:
        raise ApiFailure("NOT_FOUND", "evaluation not found", status_code=404) from exc
    latest = (
        session.execute(
            select(EvaluationResult)
            .where(
                EvaluationResult.evaluation_id == row.id,
                EvaluationResult.tenant_id == tenant_id,
                EvaluationResult.requested_by_user_id == requested_by_user_id,
            )
            .order_by(EvaluationResult.version.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    payload_result = dict(latest.result_payload) if latest is not None else None
    if payload_result is not None and row.requested_by_user_id != requested_by_user_id:
        raise ApiFailure("NOT_FOUND", "evaluation not found", status_code=404)
    status = execution_status(row.status, row.result_status)
    progress = "complete" if row.status == "succeeded" else ("failed" if row.status in ("failed", "dead") else "incomplete")
    return {
        "evaluation_id": str(row.id),
        "batch_id": str(row.batch_id),
        "tenant_id": row.tenant_id,
        "status": status,
        "result_status": row.result_status,
        "attempts": int(row.attempts),
        "error_code": row.error_code,
        "error_detail": "" if row.status == "succeeded" else (row.error_detail or ""),
        "retriable": bool(row.retriable),
        "progress": progress,
        "result": payload_result,
        "errors": [],
        "incomplete_sections": list((payload_result or {}).get("incomplete_sections", [])) if payload_result else [],
    }


def read_batch(
    session: Session, *, tenant_id: str, requested_by_user_id: str, batch_id: str
) -> dict:
    import uuid as _uuid

    try:
        parsed = _uuid.UUID(str(batch_id))
    except ValueError as exc:
        raise ApiFailure("NOT_FOUND", "batch not found", status_code=404) from exc
    try:
        progress = repo.get_batch_progress(
            session, tenant_id=tenant_id, requested_by_user_id=requested_by_user_id,
            batch_id=parsed,
        )
    except KeyError as exc:
        raise ApiFailure("NOT_FOUND", "batch not found", status_code=404) from exc
    rows = (
        session.execute(
            select(Evaluation).where(
                Evaluation.batch_id == parsed,
                Evaluation.tenant_id == tenant_id,
                Evaluation.requested_by_user_id == requested_by_user_id,
            )
        )
        .scalars()
        .all()
    )
    return {
        "batch_id": str(parsed),
        "tenant_id": tenant_id,
        "status": str(progress["status"]).upper(),
        "total": int(progress["total"]),
        "succeeded": int(progress["succeeded"]),
        "failed": int(progress["failed"]),
        "evaluations": [
            {
                "evaluation_id": str(row.id),
                "idempotency_key": row.idempotency_key,
                "status": execution_status(row.status, row.result_status),
                "created_or_reused": "reused",
            }
            for row in rows
        ],
    }


__all__ = [
    "execution_status",
    "process_queued_evaluations",
    "read_batch",
    "read_evaluation",
    "submit_batch",
]
