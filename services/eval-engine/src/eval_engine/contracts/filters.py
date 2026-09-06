"""Appraisal filter, adjustment, and transaction rule contracts."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .base import DecimalString

FilterKind = Literal[
    "max_sale_age_days",
    "max_sqft_diff",
    "max_year_built_diff",
    "max_distance_miles",
    "property_type_match",
    "subdivision_match",
]

AdjustmentKind = Literal[
    "bedroom",
    "bathroom",
    "feature",
    "proximity",
    "sqft",
    "sale_age",
]

SKIPPED_APPLIES_TO = "SKIPPED_APPLIES_TO"
SKIPPED_DUPLICATE = "SKIPPED_DUPLICATE"
SKIPPED_UNKNOWN_EVIDENCE = "SKIPPED_UNKNOWN_EVIDENCE"
SKIPPED_UNKNOWN_AMOUNT = "SKIPPED_UNKNOWN_AMOUNT"
SKIPPED_NO_POLICY = "SKIPPED_NO_POLICY"
SKIPPED_UNSUPPORTED = "SKIPPED_UNSUPPORTED"

RuleSource = Literal["request_override", "zip", "city_state", "state", "user_default", "system_default", ""]
RulePrecedence = Literal["request_override", "zip", "city_state", "state", "user_default", "system_default", ""]


class AppraisalFilterV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid", validate_default=True)

    rule_id: str = Field(min_length=1, max_length=128)
    kind: FilterKind
    enabled: bool = True
    value: DecimalString | None = None
    text_value: str = Field(default="", max_length=256)
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    unit: str = Field(default="", max_length=32)
    version: str = Field(default="", max_length=32)


class CompAdjustmentRuleV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid", validate_default=True)

    rule_id: str = Field(min_length=1, max_length=128)
    kind: AdjustmentKind
    enabled: bool = True
    signed_amount: DecimalString = Decimal("0")
    per_unit_amount: DecimalString | None = None
    unit: str = Field(default="", max_length=32)
    applies_to: Literal["comp", "subject", "both"] = "comp"
    subject_evidence_field: str = Field(default="", max_length=64)
    comp_evidence_field: str = Field(default="", max_length=64)
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)
    evidence_field: str = Field(default="", max_length=64)

    @property
    def resolved_subject_field(self) -> str:
        return self.subject_evidence_field or self.evidence_field

    @property
    def resolved_comp_field(self) -> str:
        return self.comp_evidence_field or self.evidence_field


class TransactionRuleV4(BaseModel):
    """Explicit configured transaction eligibility.

    Presence and membership are separate. Unknown codes/types only fail
    when ``require_known_code``/``require_known_type`` is set; otherwise an
    optional ``unknown_code_limitation``/``unknown_type_limitation`` records
    the evidence gap without failing. Denial always wins over allowance.
    ``is_sale=True`` is required; intrinsic ``is_sale=False`` always fails.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    rule_id: str = Field(default="transaction_eligibility", max_length=128)
    enabled: bool = True
    require_sale_flag: bool = True
    allowed_codes: list[str] = Field(default_factory=list, max_length=256)
    denied_codes: list[str] = Field(default_factory=list, max_length=256)
    allowed_types: list[str] = Field(default_factory=list, max_length=256)
    denied_types: list[str] = Field(default_factory=list, max_length=256)
    require_known_code: bool = False
    require_known_type: bool = False
    unknown_code_limitation: str = Field(default="unknown transaction code", max_length=256)
    unknown_type_limitation: str = Field(default="unknown transaction type", max_length=256)
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)


__all__ = [
    "AdjustmentKind",
    "AppraisalFilterV4",
    "CompAdjustmentRuleV4",
    "FilterKind",
    "RulePrecedence",
    "RuleSource",
    "SKIPPED_APPLIES_TO",
    "SKIPPED_DUPLICATE",
    "SKIPPED_NO_POLICY",
    "SKIPPED_UNKNOWN_AMOUNT",
    "SKIPPED_UNKNOWN_EVIDENCE",
    "SKIPPED_UNSUPPORTED",
    "TransactionRuleV4",
]
