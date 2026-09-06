"""Deal, rehab evidence, and result contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from decimal import Decimal

from .base import DecimalString
from .comps import CompCandidateV4
from .settings import SettingsSnapshotV4
from .subject import SubjectPropertyV4

ArvStatus = Literal["ACCEPTED", "REJECTED", "NOT_EXAMINED_FOR_ARV"]
InvestorStatus = Literal["ACCEPTED", "REJECTED", "INSUFFICIENT_EVIDENCE"]
EvalStatus = Literal[
    "COMPLETED",
    "INSUFFICIENT_COMPS",
    "INSUFFICIENT_INVESTOR_DATA",
    "REVIEW_REQUIRED",
    "FAILED",
]


class MajorItemEvidenceV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    system_id: str
    supported_age_years: DecimalString | None = None
    evidence_date: str = ""
    provenance: Literal["auto", "manual"] = "auto"
    manual_cost: DecimalString | None = None
    dedup_group: str = ""


class AdditionalRenovationItemV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    item_id: str
    cost: DecimalString
    provenance: str = "operator"
    dedup_group: str = ""


class AdjustmentLedgerEntryV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    entry_id: str
    stage: Literal["comp", "subject", "investor_comp", "investor_subject"] = "comp"
    target_id: str
    rule_id: str
    signed_amount: DecimalString
    unit: str = ""
    evidence: str = ""
    input_value: str = ""
    duplicate_key: str = ""


class CompDecisionV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    comp_id: str
    evidence_ref: str = ""
    arv_status: ArvStatus
    investor_status: InvestorStatus = "INSUFFICIENT_EVIDENCE"
    rejection_reasons: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class ArvResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: EvalStatus
    accepted_comp_ids: list[str] = Field(default_factory=list)
    average_adjusted_ppsf: DecimalString | None = None
    base_arv: DecimalString | None = None
    final_arv: DecimalString | None = None
    exact_value: str = ""


class RenovationItemResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, validate_default=True)

    system_id: str
    provenance: str
    supported_age: DecimalString | None = None
    threshold: DecimalString | None = None
    included: bool = False
    signed_cost: DecimalString = Decimal("0")
    dedup_group: str = ""


class RenovationResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tier_key: str = ""
    renovation_level: str = ""
    base_rehab: DecimalString | None = None
    major_items_total: DecimalString | None = None
    additional_total: DecimalString | None = None
    total_rehab: DecimalString | None = None
    preliminary: bool = False
    limitations: list[str] = Field(default_factory=list)
    items: list[RenovationItemResultV4] = Field(default_factory=list)


class DealResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    closing_costs: DecimalString | None = None
    carrying_costs: DecimalString | None = None
    flip_profit: DecimalString | None = None
    investor_purchase_ceiling_exact: DecimalString | None = None
    seller_contract_ceiling_exact: DecimalString | None = None
    wholesale_fee: DecimalString | None = None
    displayed_mao: DecimalString | None = None
    display_rounding_difference: DecimalString | None = None
    initial_offer_status: str = "INCOMPLETE"


class InvestorCohortResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    method: str = "ENGINEERING_PROPOSAL_v4_robust_local_cohort_v1"
    method_label: str = "ENGINEERING_PROPOSAL"
    status: Literal["COHORT_FOUND", "INSUFFICIENT_INVESTOR_DATA"] = (
        "INSUFFICIENT_INVESTOR_DATA"
    )
    eligible_count: int = 0
    selected_count: int = 0
    selected_comp_ids: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)
    observed_mean: DecimalString | None = None
    observed_median: DecimalString | None = None
    observed_min: DecimalString | None = None
    observed_max: DecimalString | None = None
    adjusted_mean_ppsf: DecimalString | None = None
    subject_investor_value: DecimalString | None = None
    limitations: list[str] = Field(default_factory=list)


class EvaluationRequestV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    subject: SubjectPropertyV4
    comps: list[CompCandidateV4] = Field(default_factory=list)
    renovation_level: str = ""
    settings: SettingsSnapshotV4
    major_item_evidence: list[MajorItemEvidenceV4] = Field(default_factory=list)
    additional_items: list[AdditionalRenovationItemV4] = Field(default_factory=list)
    evaluation_date: str = ""


class EvaluationResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: EvalStatus
    decisions: list[CompDecisionV4] = Field(default_factory=list)
    ledger: list[AdjustmentLedgerEntryV4] = Field(default_factory=list)
    arv: ArvResultV4 | None = None
    renovation: RenovationResultV4 | None = None
    deal: DealResultV4 | None = None
    investor: InvestorCohortResultV4 | None = None


__all__ = [
    "AdditionalRenovationItemV4",
    "AdjustmentLedgerEntryV4",
    "ArvResultV4",
    "ArvStatus",
    "CompDecisionV4",
    "DealResultV4",
    "EvalStatus",
    "EvaluationRequestV4",
    "EvaluationResultV4",
    "InvestorCohortResultV4",
    "InvestorStatus",
    "MajorItemEvidenceV4",
    "RenovationItemResultV4",
    "RenovationResultV4",
]
