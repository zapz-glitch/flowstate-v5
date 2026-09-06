"""Typed durable API schemas: batch submission, reads, and machine errors."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..contracts import (
    AdditionalRenovationItemV4,
    EvaluationRequestV4,
    MajorItemEvidenceV4,
    SettingsSnapshotV4,
)


class ApiError(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    code: Literal[
        "AUTH_MISSING",
        "AUTH_INVALID",
        "AUTH_EXPIRED",
        "MALFORMED_JSON",
        "INVALID_SHAPE",
        "VALIDATION_ERROR",
        "IDEMPOTENCY_CONFLICT",
        "NOT_FOUND",
        "PROVIDER_PENDING",
        "LEASE_CONFLICT",
        "DOMAIN_ERROR",
        "INTERNAL_ERROR",
    ]
    message: str = ""
    section: str = ""
    retriable: bool = False


class PropertyEvaluationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=256)
    subject: dict[str, Any]
    comps: list[dict[str, Any]] = Field(default_factory=list)
    renovation_level: str = Field(default="", max_length=64)
    major_item_evidence: list[MajorItemEvidenceV4] = Field(default_factory=list)
    additional_items: list[AdditionalRenovationItemV4] = Field(default_factory=list)
    evaluation_date: str | None = None


class BatchSubmitRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    evaluations: list[PropertyEvaluationRequest] = Field(min_length=1, max_length=50)
    settings: SettingsSnapshotV4
    candidate_evidence_mode: Literal["preloaded", "provider_pending"] = "preloaded"


class EvaluationSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    evaluation_id: str
    idempotency_key: str
    status: str
    created_or_reused: Literal["created", "reused"] = "created"


class BatchSubmitResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    batch_id: str
    status: str
    created_or_reused: Literal["created", "reused"] = "created"
    evaluations: list[EvaluationSummary] = Field(default_factory=list)


class EvaluationReadResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    evaluation_id: str
    batch_id: str
    tenant_id: str
    status: str
    result_status: str | None = None
    attempts: int = 0
    error_code: str | None = None
    error_detail: str = ""
    retriable: bool = True
    progress: str = ""
    result: dict[str, Any] | None = None
    errors: list[ApiError] = Field(default_factory=list)
    incomplete_sections: list[str] = Field(default_factory=list)


class BatchReadResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    batch_id: str
    tenant_id: str
    status: str
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    evaluations: list[EvaluationSummary] = Field(default_factory=list)


__all__ = [
    "ApiError",
    "BatchReadResponse",
    "BatchSubmitRequest",
    "BatchSubmitResponse",
    "EvaluationReadResponse",
    "EvaluationRequestV4",
    "EvaluationSummary",
    "PropertyEvaluationRequest",
]
