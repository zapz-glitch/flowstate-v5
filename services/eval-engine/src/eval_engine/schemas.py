"""V4 evaluation contracts: legacy aliases plus typed Decimal V4 models."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .contracts import (
    AdditionalItemResultV4,
    AdditionalRenovationItemV4,
    AdjustmentLedgerEntryV4,
    AdjustmentOutcomeV4,
    AppraisalFilterV4,
    ArvResultV4,
    CompAdjustmentRuleV4,
    CompCandidateV4,
    CompDecisionV4,
    DATE_PATTERN,
    DealResultV4,
    DealSettingsV4,
    DecimalString,
    EvalErrorV4,
    EvaluationRequestV4,
    EvaluationResultV4,
    InvestorCohortResultV4,
    MajorItemEvidenceV4,
    MajorItemRuleV4,
    RenovationItemResultV4,
    RenovationResultV4,
    RenovationTierCellV4,
    RenovationTierV4,
    RuleOutcomeV4,
    SectionStatus,
    SettingsSnapshotV4,
    SubjectPropertyV4,
    TransactionRuleV4,
    parse_decimal_string,
    parse_full_date,
    serialize_decimal,
    tier_boundary_problems,
)


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
    "AdditionalItemResultV4",
    "AdditionalRenovationItemV4",
    "AdjustmentLedgerEntryV4",
    "AdjustmentOutcomeV4",
    "AppraisalFilterV4",
    "ArvResultV4",
    "CompAdjustmentRuleV4",
    "CompCandidateV4",
    "CompDecisionV4",
    "Comparable",
    "DATE_PATTERN",
    "DealResultV4",
    "DealSettingsV4",
    "DecisionStep",
    "DecimalString",
    "EvalErrorV4",
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
    "RuleOutcomeV4",
    "SectionStatus",
    "SettingsSnapshotV4",
    "SubjectProperty",
    "SubjectPropertyV4",
    "TransactionRuleV4",
    "parse_decimal_string",
    "parse_full_date",
    "serialize_decimal",
    "tier_boundary_problems",
]
