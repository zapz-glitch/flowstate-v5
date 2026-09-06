"""Appraisal filter and adjustment rule contracts."""

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


class AppraisalFilterV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, validate_default=True)

    rule_id: str
    kind: FilterKind
    enabled: bool = True
    value: DecimalString | None = None
    text_value: str = ""
    source: str = ""
    precedence: str = ""


class CompAdjustmentRuleV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, validate_default=True)

    rule_id: str
    kind: AdjustmentKind
    enabled: bool = True
    signed_amount: DecimalString = Decimal("0")
    per_unit_amount: DecimalString | None = None
    unit: str = ""
    applies_to: Literal["comp", "subject"] = "comp"
    source: str = ""
    precedence: str = ""


__all__ = ["AdjustmentKind", "AppraisalFilterV4", "CompAdjustmentRuleV4", "FilterKind"]
