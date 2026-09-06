"""Durable v1 routes: submit batch, read evaluation, read batch."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..application.service import read_batch, read_evaluation, submit_batch
from ..persistence.repositories import IdempotencyConflict, LeaseMismatch, TerminalReplay
from .deps import get_session, require_principal
from .errors import ApiFailure
from .schemas import BatchReadResponse, BatchSubmitResponse, EvaluationReadResponse

router = APIRouter(prefix="/v1")


@router.post("/evaluations", response_model=BatchSubmitResponse, status_code=202)
def post_evaluations(
    request: Request,
    principal=Depends(require_principal),
    session: Session = Depends(get_session),
) -> BatchSubmitResponse:
    key = request.headers.get("Idempotency-Key", "")
    if not key.strip():
        raise ApiFailure("VALIDATION_ERROR", "Idempotency-Key header is required", status_code=422)
    raw = getattr(request.state, "raw_body", b"")
    try:
        body = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiFailure("MALFORMED_JSON", "request body must be valid JSON", status_code=400) from exc
    if not isinstance(body, dict):
        raise ApiFailure("INVALID_SHAPE", "request body must be a JSON object", status_code=422)
    committed = False
    try:
        batch, created, summaries = submit_batch(
            session, tenant_id=principal.tenant_id,
            requested_by_user_id=principal.user_id,
            batch_key=key.strip(), body=body,
        )
        session.commit()
        committed = True
    except ApiFailure:
        raise
    except (IdempotencyConflict, LeaseMismatch, TerminalReplay, ValueError, KeyError):
        raise
    except Exception as exc:
        raise ApiFailure("INTERNAL_ERROR", "request could not be completed", status_code=500) from exc
    finally:
        if not committed:
            session.rollback()
    return BatchSubmitResponse(
        batch_id=str(batch.id),
        status=str(batch.status).upper(),
        created_or_reused="created" if created else "reused",
        evaluations=[
            {
                "evaluation_id": item["evaluation_id"],
                "idempotency_key": item["idempotency_key"],
                "status": item["status"],
                "created_or_reused": item["created_or_reused"],
            }
            for item in summaries
        ],
    )


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationReadResponse)
def get_evaluation(
    evaluation_id: str,
    principal=Depends(require_principal),
    session: Session = Depends(get_session),
) -> EvaluationReadResponse:
    try:
        payload = read_evaluation(
            session, tenant_id=principal.tenant_id,
            requested_by_user_id=principal.user_id, evaluation_id=evaluation_id,
        )
    except ApiFailure:
        raise
    except Exception as exc:
        raise ApiFailure("INTERNAL_ERROR", "request could not be completed", status_code=500) from exc
    finally:
        session.rollback()
    return EvaluationReadResponse(**payload)


@router.get("/evaluation-batches/{batch_id}", response_model=BatchReadResponse)
def get_batch(
    batch_id: str,
    principal=Depends(require_principal),
    session: Session = Depends(get_session),
) -> BatchReadResponse:
    try:
        payload = read_batch(
            session, tenant_id=principal.tenant_id,
            requested_by_user_id=principal.user_id, batch_id=batch_id,
        )
    except ApiFailure:
        raise
    except Exception as exc:
        raise ApiFailure("INTERNAL_ERROR", "request could not be completed", status_code=500) from exc
    finally:
        session.rollback()
    return BatchReadResponse(**payload)


__all__ = ["router"]
