"""Immutable settings snapshot contract."""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from .base import DecimalString
from .filters import AppraisalFilterV4, CompAdjustmentRuleV4


class RenovationTierCellV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    renovation_level: str
    rehab_rate_per_sqft: DecimalString
    flip_profit: DecimalString


class RenovationTierV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tier_key: str
    lower_inclusive: DecimalString
    upper_inclusive: DecimalString | None = None
    upper_exclusive: DecimalString | None = None
    cells: list[RenovationTierCellV4] = Field(default_factory=list)


class DealSettingsV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, validate_default=True)

    closing_cost_percent: DecimalString = Decimal("0")
    closing_cost_base: str = "final_arv"
    carrying_cost_percent: DecimalString = Decimal("0")
    carrying_cost_base: str = "final_arv"
    wholesale_fee: DecimalString = Decimal("0")
    rounding_increment: DecimalString = Decimal("1000")
    rounding_mode: str = "half_up"


class MajorItemRuleV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, validate_default=True)

    system_id: str
    enabled: bool = True
    age_threshold_years: DecimalString = Decimal("0")
    replacement_cost: DecimalString = Decimal("0")
    inclusion_category: str = "initial_auto"
    source: str = ""
    precedence: str = ""


class SettingsSnapshotV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    snapshot_id: str = ""
    schema_version: str = "evaluation-v4"
    content_hash: str = ""
    filters: list[AppraisalFilterV4] = Field(default_factory=list)
    adjustments: list[CompAdjustmentRuleV4] = Field(default_factory=list)
    tiers: list[RenovationTierV4] = Field(default_factory=list)
    deal: DealSettingsV4 = Field(default_factory=DealSettingsV4)
    major_items: list[MajorItemRuleV4] = Field(default_factory=list)


__all__ = [
    "DealSettingsV4",
    "MajorItemRuleV4",
    "RenovationTierCellV4",
    "RenovationTierV4",
    "SettingsSnapshotV4",
]
