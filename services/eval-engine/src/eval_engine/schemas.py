"""V4 evaluation contracts: legacy aliases plus typed Decimal V4 models."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .contracts.base import DecimalString, parse_decimal_string, serialize_decimal
from .contracts.comps import CompCandidateV4
from .contracts.deal import (
    AdditionalRenovationItemV4,
    AdjustmentLedgerEntryV4,
    ArvResultV4,
    CompDecisionV4,
    DealResultV4,
    EvaluationRequestV4,
    EvaluationResultV4,
    InvestorCohortResultV4,
    MajorItemEvidenceV4,
    RenovationItemResultV4,
    RenovationResultV4,
)
from .contracts.filters import AppraisalFilterV4, CompAdjustmentRuleV4
from .contracts.settings import (
    DealSettingsV4,
    MajorItemRuleV4,
    RenovationTierCellV4,
    RenovationTierV4,
    SettingsSnapshotV4,
)
from .contracts.subject import SubjectPropertyV4


class SubjectProperty(BaseModel):
    address: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    beds: float | None = None
    baths: float | None = None
    sqft: float | None = None
    lot_sqft: float | None = None
    year_built: int | None = None
    property_type: str = ""


class Comparable(BaseModel):
    address: str = ""
    sale_price: float | None = None
    sale_date: str = ""
    beds: float | None = None
    baths: float | None = None
    sqft: float | None = None
    distance_miles: float | None = None


class EvaluateRequest(BaseModel):
    subject: SubjectProperty
    comps: list[Comparable] = Field(default_factory=list)


class DecisionStep(BaseModel):
    node: str
    outcome: str
    detail: str = ""


class EvaluateResponse(BaseModel):
    estimated_value: float
    confidence: str = "unknown"
    decision_path: list[DecisionStep] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "eval-engine-v4"


__all__ = [
    "AdditionalRenovationItemV4",
    "AdjustmentLedgerEntryV4",
    "AppraisalFilterV4",
    "ArvResultV4",
    "CompAdjustmentRuleV4",
    "CompCandidateV4",
    "CompDecisionV4",
    "Comparable",
    "DealResultV4",
    "DealSettingsV4",
    "DecisionStep",
    "DecimalString",
    "EvaluateRequest",
    "EvaluateRequestV4",
    "EvaluateResponse",
    "EvaluationResultV4",
    "HealthResponse",
    "InvestorCohortResultV4",
    "MajorItemEvidenceV4",
    "MajorItemRuleV4",
    "RenovationItemResultV4",
    "RenovationResultV4",
    "RenovationTierCellV4",
    "RenovationTierV4",
    "SettingsSnapshotV4",
    "SubjectProperty",
    "SubjectPropertyV4",
    "parse_decimal_string",
    "serialize_decimal",
]
