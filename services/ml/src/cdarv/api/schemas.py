"""Request schemas for the CDARV internal API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class SubmissionIn(BaseModel):
    report_id: str = Field(min_length=1, max_length=128)
    user_id: str = Field(min_length=1, max_length=128)
    created_at: str = Field(min_length=1, max_length=64)
    job_id: str | None = Field(default=None, max_length=128)
    address: str | None = Field(default=None, max_length=512)
    report_json: dict[str, Any]
    submitted_by: str = Field(min_length=1, max_length=128)


class OpenReviewIn(BaseModel):
    snapshot_id: str = Field(min_length=1, max_length=36)
    reviewer_id: str = Field(min_length=1, max_length=128)


class CompLabelIn(BaseModel):
    comp_id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=32)
    reasons: list[str] = Field(default_factory=list)
    note: str | None = Field(default=None, max_length=4000)
    transaction_key: str | None = Field(default=None, max_length=256)


class SetLabelsIn(BaseModel):
    labels: list[CompLabelIn] = Field(max_length=500)


class PreferenceIn(BaseModel):
    preferred_comp_id: str = Field(min_length=1, max_length=128)
    over_comp_id: str = Field(min_length=1, max_length=128)
    reasons: list[str] = Field(default_factory=list)
    note: str | None = Field(default=None, max_length=4000)


class ExternalCompIn(BaseModel):
    source: str = Field(min_length=1, max_length=64)
    transaction: dict[str, Any]
    availability_date: str = Field(min_length=1, max_length=32)
    note: str | None = Field(default=None, max_length=4000)


class DecideIn(BaseModel):
    action: Literal["approve", "needs_more_evidence", "exclude"]
    reviewer_id: str = Field(min_length=1, max_length=128)
    comp_ranking: bool = False
    valuation_benchmark: bool = False
    gold_standard: bool = False
    gold_standard_evidence: str | None = Field(default=None, max_length=4000)
    note: str | None = Field(default=None, max_length=4000)


class BuildDatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    created_by: str = Field(min_length=1, max_length=128)
    scope: Literal["comp_ranking", "valuation_benchmark"] = "comp_ranking"
    test_fraction: float = Field(default=0.2, ge=0.0, le=0.5)
    val_fraction: float = Field(default=0.2, ge=0.0, le=0.5)
    seed: int = 42


class TrainIn(BaseModel):
    dataset_id: str = Field(min_length=1, max_length=36)
    name: str = Field(default="baseline", max_length=128)


class ActivateShadowIn(BaseModel):
    model_id: str = Field(min_length=1, max_length=36)
    activated_by: str = Field(min_length=1, max_length=128)


class ScoreShadowIn(BaseModel):
    snapshot_id: str = Field(min_length=1, max_length=36)


class GuidanceIn(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    body: str = Field(min_length=1)
    examples: list[dict[str, Any]] = Field(default_factory=list)
    created_by: str = Field(min_length=1, max_length=128)


__all__ = [
    "ActivateShadowIn", "BuildDatasetIn", "CompLabelIn", "DecideIn",
    "ExternalCompIn", "GuidanceIn", "OpenReviewIn", "PreferenceIn",
    "ScoreShadowIn", "SetLabelsIn", "SubmissionIn", "TrainIn",
]
