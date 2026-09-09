"""Deal, rehab evidence, and result contracts."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .base import DecimalString
from .comps import CompCandidateV4
from .dates import OptionalStrictDate, StrictDate
from .settings import SettingsSnapshotV4
from .subject import SubjectPropertyV4

IsoDate = StrictDate
OptionalIsoDate = OptionalStrictDate

ArvStatus = Literal["ACCEPTED", "REJECTED", "NOT_EXAMINED_FOR_ARV"]
InvestorStatus = Literal["ACCEPTED", "REJECTED", "INSUFFICIENT_EVIDENCE"]
EvalStatus = Literal[
    "COMPLETED",
    "INSUFFICIENT_COMPS",
    "INSUFFICIENT_INVESTOR_DATA",
    "REVIEW_REQUIRED",
    "FAILED",
]
SectionStatus = Literal["COMPLETED", "INSUFFICIENT_DATA", "PRELIMINARY", "FAILED", "NOT_APPLICABLE"]


class RuleOutcomeV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    rule_id: str
    kind: str = ""
    passed: bool = False
    reason: str = ""
    limitation: str = ""


class MajorItemEvidenceV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    system_id: str = Field(min_length=1, max_length=64)
    supported_age_years: DecimalString | None = None
    evidence_date: OptionalIsoDate = None
    permit_scope: str = Field(default="", max_length=256)
    completion_evidence: str = Field(default="", max_length=256)
    source: str = Field(default="", max_length=64)
    conflict_note: str = Field(default="", max_length=256)
    override_provenance: Literal["", "operator", "permit", "inspection"] = ""
    provenance: Literal["auto", "manual"] = "auto"
    manual_cost: DecimalString | None = None
    dedup_group: str = Field(default="", max_length=128)


class AdditionalRenovationItemV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    item_id: str = Field(min_length=1, max_length=128)
    cost: DecimalString
    provenance: str = Field(default="operator", max_length=64)
    source: str = Field(default="", max_length=64)
    dedup_group: str = Field(default="", max_length=128)


class AdditionalItemResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    item_id: str
    included: bool = False
    requested_cost: DecimalString | None = None
    applied_cost: DecimalString | None = None
    provenance: str = ""
    source: str = ""
    dedup_group: str = ""
    winning_item_id: str = ""
    reason: str = ""
    ledger_entry_id: str = ""


class AdjustmentLedgerEntryV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    entry_id: str
    stage: Literal["comp", "subject", "investor_comp", "investor_subject", "major_item"] = "comp"
    target_id: str
    rule_id: str
    signed_amount: DecimalString
    unit: str = ""
    evidence: str = ""
    input_value: str = ""
    duplicate_key: str = ""


class AdjustmentOutcomeV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    rule_id: str
    kind: str = ""
    stage: str = ""
    outcome: Literal["applied", "skipped", "no_difference"] = "skipped"
    reason: str = ""
    signed_amount: DecimalString | None = None


class CompDecisionV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    comp_id: str
    evidence_ref: str = ""
    arv_status: ArvStatus
    investor_status: InvestorStatus = "INSUFFICIENT_EVIDENCE"
    rule_outcomes: list[RuleOutcomeV4] = Field(default_factory=list)
    rejection_reasons: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    duplicate_of: str = ""
    match_percent: DecimalString | None = None
    matched_rule_count: int = 0
    total_rule_count: int = 0
    mismatch_reasons: list[str] = Field(default_factory=list)
    selection_reason: str = ""
    priority_rank: int | None = None
    ranking_details: list[str] = Field(default_factory=list)
    arv_cohort: Literal["unclassified", "upper_half", "lower_half", "not_qualified", "price_review"] = "unclassified"
    arv_weight: DecimalString | None = None
    rule_weight: DecimalString | None = None
    recency_weight: DecimalString | None = None
    condition_classification: Literal["A", "B", "excluded"] | None = None


class EvalErrorV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    code: str
    section: str = ""
    message: str = ""
    retriable: bool = False


class ArvStageTraceV4(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage_id: str
    sale_age_days: int
    year_built_diff: int
    qualified_comp_ids: list[str] = Field(default_factory=list)
    upper_half_comp_ids: list[str] = Field(default_factory=list)
    condition_excluded_comp_ids: list[str] = Field(default_factory=list)
    selected_comp_ids: list[str] = Field(default_factory=list)
    price_review_comp_ids: list[str] = Field(default_factory=list)
    cutoff_price: DecimalString | None = None


class ArvResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    status: SectionStatus = "INSUFFICIENT_DATA"
    accepted_comp_ids: list[str] = Field(default_factory=list)
    average_adjusted_ppsf: DecimalString | None = None
    base_arv: DecimalString | None = None
    subject_adjustment_total: DecimalString | None = None
    final_arv: DecimalString | None = None
    displayed_arv: DecimalString | None = None
    display_rounding_difference: DecimalString | None = None
    exact_value: str = ""
    limitations: list[str] = Field(default_factory=list)
    skipped_adjustments: list[str] = Field(default_factory=list)
    adjustment_outcomes: list[AdjustmentOutcomeV4] = Field(default_factory=list)
    selection_policy: str = "legacy_physical_v1"
    qualified_comp_count: int | None = None
    upper_half_cutoff_price: DecimalString | None = None
    comp_weights: dict[str, DecimalString] = Field(default_factory=dict)
    stage_trace: list[ArvStageTraceV4] = Field(default_factory=list)
    selected_stage: str | None = None


class RenovationItemResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid", validate_default=True)

    system_id: str
    canonical_system_id: str = ""
    provenance: str
    supported_age: DecimalString | None = None
    threshold: DecimalString | None = None
    included: bool = False
    signed_cost: DecimalString = Decimal("0")
    overlap_group: str = ""
    dedup_group: str = ""
    evidence_summary: str = ""
    ledger_entry_id: str = ""


class RenovationResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    status: SectionStatus = "INSUFFICIENT_DATA"
    tier_key: str = ""
    renovation_level: str = ""
    base_rehab: DecimalString | None = None
    major_items_total: DecimalString | None = None
    additional_total: DecimalString | None = None
    total_rehab: DecimalString | None = None
    preliminary: bool = False
    limitations: list[str] = Field(default_factory=list)
    items: list[RenovationItemResultV4] = Field(default_factory=list)
    additional_items: list[AdditionalItemResultV4] = Field(default_factory=list)


class DealResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    status: SectionStatus = "INSUFFICIENT_DATA"
    closing_costs: DecimalString | None = None
    carrying_costs: DecimalString | None = None
    flip_profit: DecimalString | None = None
    investor_purchase_ceiling_exact: DecimalString | None = None
    displayed_buy_price: DecimalString | None = None
    buy_price_rounding_difference: DecimalString | None = None
    seller_contract_ceiling_exact: DecimalString | None = None
    wholesale_fee: DecimalString | None = None
    displayed_mao: DecimalString | None = None
    display_rounding_difference: DecimalString | None = None
    initial_offer_value: DecimalString | None = None
    initial_offer_status: Literal["COMPLETE", "INCOMPLETE"] = "INCOMPLETE"
    initial_offer_reason: str = "no Initial Offer rule mapped; field incomplete by policy"
    preliminary: bool = False
    limitations: list[str] = Field(default_factory=list)


class InvestorCohortResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    method: str = "ENGINEERING_PROPOSAL_v4_separated_bimodal_cohort_v2"
    method_label: str = "ENGINEERING_PROPOSAL"
    status: Literal["COHORT_FOUND", "INSUFFICIENT_INVESTOR_DATA"] = (
        "INSUFFICIENT_INVESTOR_DATA"
    )
    minimum_sample: int = 8
    separation_gap_ppsf: DecimalString | None = None
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
    buyer_label: str = "inferred investor or as-is pricing"
    limitations: list[str] = Field(default_factory=list)


class EvaluationRequestV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    methodology_version: Literal["evaluation-v4"] = "evaluation-v4"
    subject: SubjectPropertyV4
    comps: list[CompCandidateV4] = Field(default_factory=list)
    selected_comp_ids: list[str] | None = Field(default=None, min_length=1, max_length=500)
    renovation_level: str = Field(default="", max_length=64)
    settings: SettingsSnapshotV4
    major_item_evidence: list[MajorItemEvidenceV4] = Field(default_factory=list)
    additional_items: list[AdditionalRenovationItemV4] = Field(default_factory=list)
    evaluation_date: OptionalIsoDate = None

    @field_validator("selected_comp_ids")
    @classmethod
    def validate_selected_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and (len(set(value)) != len(value) or any(not item.strip() for item in value)):
            raise ValueError("manual comparable IDs must be distinct and nonempty")
        return value


class EvaluationResultV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    methodology_version: Literal["evaluation-v4"] = "evaluation-v4"
    settings_schema_version: Literal["evaluation-v4"] = "evaluation-v4"
    status: EvalStatus
    settings_snapshot_id: str = ""
    settings_content_hash: str = ""
    decisions: list[CompDecisionV4] = Field(default_factory=list)
    ledger: list[AdjustmentLedgerEntryV4] = Field(default_factory=list)
    errors: list[EvalErrorV4] = Field(default_factory=list)
    incomplete_sections: list[str] = Field(default_factory=list)
    arv: ArvResultV4 | None = None
    renovation: RenovationResultV4 | None = None
    deal: DealResultV4 | None = None
    investor: InvestorCohortResultV4 | None = None


__all__ = [
    "AdditionalItemResultV4",
    "AdditionalRenovationItemV4",
    "AdjustmentLedgerEntryV4",
    "AdjustmentOutcomeV4",
    "ArvResultV4",
    "ArvStatus",
    "CompDecisionV4",
    "DealResultV4",
    "EvalErrorV4",
    "EvalStatus",
    "EvaluationRequestV4",
    "EvaluationResultV4",
    "InvestorCohortResultV4",
    "InvestorStatus",
    "IsoDate",
    "MajorItemEvidenceV4",
    "OptionalIsoDate",
    "RenovationItemResultV4",
    "RenovationResultV4",
    "RuleOutcomeV4",
    "SectionStatus",
]
