"""Durable application service: validate, persist, evaluate inline."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..contracts import EvaluationRequestV4, SubjectPropertyV4
from ..contracts.comps import CompCandidateV4
from ..contracts.settings import snapshot_store_parts, to_persistence_status
from ..domain.evaluate import evaluate_v4
from ..persistence import repositories as repo
from ..persistence.models import Evaluation, EvaluationResult, SettingsSnapshot
from ..api.errors import ApiFailure
from ..api.providers import NoLiveProvider

_CANDIDATE_TEST_MODES = {"preloaded", "provider_pending"}

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


def _require_mode(mode: str) -> None:
    if mode not in _CANDIDATE_TEST_MODES:
        raise ApiFailure("VALIDATION_ERROR", "candidate_evidence_mode must be preloaded or provider_pending", status_code=422)


def _typed_property_request(
    item: dict, settings, evidence_mode: str
) -> EvaluationRequestV4:
    if evidence_mode == "provider_pending":
        raise ApiFailure("PROVIDER_PENDING", "provider evidence is pending; no live provider configured", status_code=202)
    try:
        subject = SubjectPropertyV4(**item.get("subject", {}))
        comps = [CompCandidateV4(**raw) for raw in item.get("comps", [])]
        return EvaluationRequestV4(
            subject=subject,
            comps=comps,
            renovation_level=item.get("renovation_level", ""),
            settings=settings,
            major_item_evidence=item.get("major_item_evidence", []),
            additional_items=item.get("additional_items", []),
            evaluation_date=item.get("evaluation_date"),
        )
    except Exception as exc:
        raise ApiFailure("VALIDATION_ERROR", "invalid property evaluation request", status_code=422) from exc


def _bind_snapshot_refs(payload: dict, snapshot: SettingsSnapshot) -> dict:
    bound = dict(payload)
    bound["settings_snapshot_id"] = str(snapshot.id)
    bound["settings_content_hash"] = str(snapshot.content_hash)
    return bound


def submit_batch(
    session: Session,
    *,
    tenant_id: str,
    batch_key: str,
    body: dict,
) -> tuple[object, bool, list[dict]]:
    from pydantic import ValidationError

    from ..api.schemas import BatchSubmitRequest

    try:
        request = BatchSubmitRequest(**body)
    except ValidationError as exc:
        raise ApiFailure("VALIDATION_ERROR", "batch must contain 1 to 50 property requests", status_code=422) from exc
    _require_mode(request.candidate_evidence_mode)
    keys = [str(item.idempotency_key).strip() for item in request.evaluations]
    if any(not key for key in keys) or len(set(keys)) != len(keys):
        raise ApiFailure("VALIDATION_ERROR", "each property requires a unique idempotency key", status_code=422)
    try:
        snapshot_in = request.settings.validated_for_durable_use()
    except ValueError as exc:
        raise ApiFailure("VALIDATION_ERROR", "invalid settings snapshot", status_code=422) from exc
    version, content, source = snapshot_store_parts(snapshot_in)
    snapshot = repo.store_settings_snapshot(
        session, tenant_id=tenant_id, snapshot_version=version, content=content, source=source
    )
    session.flush()
    items: list[dict] = []
    for item in request.evaluations:
        typed = _typed_property_request(
            {
                "subject": item.subject,
                "comps": item.comps,
                "renovation_level": item.renovation_level,
                "major_item_evidence": [entry.model_dump(mode="json") for entry in item.major_item_evidence],
                "additional_items": [entry.model_dump(mode="json") for entry in item.additional_items],
                "evaluation_date": item.evaluation_date,
            },
            snapshot_in,
            request.candidate_evidence_mode,
        )
        items.append(
            {
                "idempotency_key": str(item.idempotency_key),
                "payload": typed.model_dump(mode="json"),
            }
        )
    try:
        batch, created = repo.create_batch_with_evaluations(
            session,
            tenant_id=tenant_id,
            idempotency_key=batch_key,
            request_payload={"settings": request.settings.model_dump(mode="json"), "count": len(items)},
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
            select(Evaluation).where(Evaluation.batch_id == batch.id, Evaluation.tenant_id == tenant_id)
        )
        .scalars()
        .all()
    )
    by_key = {row.idempotency_key: row for row in rows}
    summaries: list[dict] = []
    for item in request.evaluations:
        row = by_key[str(item.idempotency_key)]
        summaries.append(
            {
                "evaluation_id": str(row.id),
                "idempotency_key": str(item.idempotency_key),
                "status": execution_status(row.status, row.result_status),
                "created_or_reused": "created" if created else "reused",
            }
        )
    if created:
        _evaluate_inline(session, tenant_id=tenant_id, batch=batch, snapshot=snapshot)
        session.flush()
        refreshed = (
            session.execute(
                select(Evaluation).where(Evaluation.batch_id == batch.id, Evaluation.tenant_id == tenant_id)
            )
            .scalars()
            .all()
        )
        by_key = {row.idempotency_key: row for row in refreshed}
        for summary in summaries:
            row = by_key[summary["idempotency_key"]]
            summary["status"] = execution_status(row.status, row.result_status)
        session.refresh(batch)
    return batch, created, summaries


def _evaluate_inline(session: Session, *, tenant_id: str, batch, snapshot: SettingsSnapshot) -> None:
    provider = NoLiveProvider()
    _ = provider
    rows = (
        session.execute(
            select(Evaluation).where(Evaluation.batch_id == batch.id, Evaluation.tenant_id == tenant_id)
        )
        .scalars()
        .all()
    )
    for row in rows:
        claim = _claim_for_inline(session, tenant_id=tenant_id, evaluation_id=row.id)
        if claim is None:
            continue
        try:
            typed = EvaluationRequestV4(**(row.input_payload or {}))
        except Exception:
            repo.fail_evaluation(
                session, tenant_id=tenant_id, evaluation_id=row.id,
                lease_owner=claim.lease_owner, lease_token=claim.lease_token,
                lease_generation=claim.lease_generation,
                error_code="validation_error", error_detail="invalid stored request",
                result_status="INCOMPLETE",
            )
            continue
        typed = typed.model_copy(update={"settings": typed.settings.model_copy(update={
            "snapshot_id": str(snapshot.id), "content_hash": str(snapshot.content_hash)})})
        result = evaluate_v4(typed)
        bound = _bind_snapshot_refs(result.model_dump(mode="json"), snapshot)
        repo.commit_result(
            session, tenant_id=tenant_id, evaluation_id=row.id,
            lease_owner=claim.lease_owner, lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=snapshot.id,
            status=to_persistence_status(result.status), result_payload=bound,
        )


def _claim_for_inline(session: Session, *, tenant_id: str, evaluation_id: uuid.UUID):
    from sqlalchemy import text
    row = session.execute(
        select(Evaluation).where(Evaluation.id == evaluation_id, Evaluation.tenant_id == tenant_id)
    ).scalar_one()
    if row.status != "queued":
        return None
    token = uuid.uuid4()
    now = datetime.now(timezone.utc)
    updated = session.execute(
        text(
            "UPDATE v4_evaluations SET status='claimed', lease_owner='api-inline', "
            "lease_token=:token, lease_generation=lease_generation+1, "
            "lease_expires_at=:exp, last_heartbeat_at=:now, attempts=attempts+1, "
            "updated_at=:now WHERE id=:id AND tenant_id=:tenant AND status='queued'"
        ),
        {"token": token, "exp": now + repo.LEASE_TTL, "now": now, "id": evaluation_id, "tenant": tenant_id},
    )
    session.flush()
    if not updated.rowcount:
        return None
    session.expire(row)
    fresh = session.execute(
        select(Evaluation)
        .where(Evaluation.id == evaluation_id, Evaluation.tenant_id == tenant_id)
        .execution_options(populate_existing=True)
    ).scalar_one()
    return repo.Claim(
        evaluation_id=fresh.id, tenant_id=tenant_id, lease_owner="api-inline",
        lease_token=fresh.lease_token, lease_generation=int(fresh.lease_generation),
        attempts=int(fresh.attempts),
    )


def read_evaluation(session: Session, *, tenant_id: str, evaluation_id: str) -> dict:
    try:
        parsed = uuid.UUID(str(evaluation_id))
    except ValueError as exc:
        raise ApiFailure("NOT_FOUND", "evaluation not found", status_code=404) from exc
    try:
        row = repo.get_evaluation(session, tenant_id=tenant_id, evaluation_id=parsed)
    except KeyError as exc:
        raise ApiFailure("NOT_FOUND", "evaluation not found", status_code=404) from exc
    latest = (
        session.execute(
            select(EvaluationResult)
            .where(EvaluationResult.evaluation_id == row.id, EvaluationResult.tenant_id == tenant_id)
            .order_by(EvaluationResult.version.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
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
        "result": dict(latest.result_payload) if latest is not None else None,
        "errors": [],
        "incomplete_sections": list((latest.result_payload or {}).get("incomplete_sections", [])) if latest else [],
    }


def read_batch(session: Session, *, tenant_id: str, batch_id: str) -> dict:
    try:
        parsed = uuid.UUID(str(batch_id))
    except ValueError as exc:
        raise ApiFailure("NOT_FOUND", "batch not found", status_code=404) from exc
    try:
        progress = repo.get_batch_progress(session, tenant_id=tenant_id, batch_id=parsed)
    except KeyError as exc:
        raise ApiFailure("NOT_FOUND", "batch not found", status_code=404) from exc
    rows = (
        session.execute(
            select(Evaluation).where(Evaluation.batch_id == parsed, Evaluation.tenant_id == tenant_id)
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


__all__ = ["execution_status", "read_batch", "read_evaluation", "submit_batch"]
