"""Comparable candidate evidence contract."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .base import DecimalString
from .dates import OptionalStrictDate


class PhysicalSimilarityV4(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["match", "mismatch", "unknown"] = "unknown"
    confidence: Literal["high", "medium", "low"] = "low"
    reason: str = Field(default="", max_length=2000)


class ConditionEvidenceV4(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["renovated", "unfinished_or_distressed", "unknown"] = "unknown"
    sale_relevant: bool = False
    confidence: Literal["high", "medium", "low"] = "low"
    reason: str = Field(default="", max_length=2000)


class CompCandidateV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    comp_id: str = Field(min_length=1, max_length=128)
    provider_property_id: str = Field(default="", max_length=128)
    address: str = Field(default="", max_length=256)
    verified_sale_price: DecimalString | None = None
    sale_date: OptionalStrictDate = None
    sqft: DecimalString | None = None
    lot_sqft: DecimalString | None = None
    beds: DecimalString | None = None
    baths: DecimalString | None = None
    year_built: int | None = Field(default=None, ge=1600, le=2100)
    property_type: str = Field(default="", max_length=64)
    building_style: str = Field(default="", max_length=128)
    garage_spaces: int | None = Field(default=None, ge=0, le=100)
    physical_similarity: PhysicalSimilarityV4 | None = None
    condition_evidence: ConditionEvidenceV4 | None = None
    distance_miles: DecimalString | None = None
    transaction_code: str = Field(default="", max_length=64)
    transaction_type: str = Field(default="", max_length=64)
    evidence_ref: str = Field(default="", max_length=128)
    duplicate_of: str = Field(default="", max_length=128)
    is_sale: bool | None = None
    subdivision: str = Field(default="", max_length=128)


__all__ = ["CompCandidateV4"]
