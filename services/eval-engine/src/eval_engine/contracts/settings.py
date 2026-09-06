"""Immutable settings snapshot contract."""

from __future__ import annotations

from decimal import Decimal
from hashlib import sha256
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .base import DecimalString
from .filters import AppraisalFilterV4, CompAdjustmentRuleV4, TransactionRuleV4


class RenovationTierCellV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    renovation_level: str = Field(min_length=1, max_length=64)
    rehab_rate_per_sqft: DecimalString
    flip_profit: DecimalString
    included_systems: list[str] = Field(default_factory=list, max_length=64)
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)

    @field_validator("included_systems", mode="after")
    @classmethod
    def _normalize_systems(cls, value: list[str]) -> list[str]:
        seen: list[str] = []
        for raw in value:
            key = str(raw or "").strip().lower()
            if key and key not in seen:
                seen.append(key)
        return seen


class RenovationTierV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    tier_key: str = Field(min_length=1, max_length=64)
    lower_inclusive: DecimalString
    lower_inclusive_flag: bool = True
    upper_inclusive: DecimalString | None = None
    upper_exclusive: DecimalString | None = None
    upper_bound_inclusive: bool | None = None
    cells: list[RenovationTierCellV4] = Field(default_factory=list)
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)


class DealSettingsV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid", validate_default=True)

    closing_cost_percent: DecimalString = Decimal("0")
    closing_cost_base: Literal["final_arv"] = "final_arv"
    carrying_cost_percent: DecimalString = Decimal("0")
    carrying_cost_base: Literal["final_arv"] = "final_arv"
    wholesale_fee: DecimalString = Decimal("0")
    rounding_increment: DecimalString = Decimal("1000")
    rounding_mode: Literal["half_up"] = "half_up"
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)


class MajorItemRuleV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid", validate_default=True)

    system_id: str = Field(min_length=1, max_length=64)
    enabled: bool = True
    age_threshold_years: DecimalString = Decimal("0")
    replacement_cost: DecimalString = Decimal("0")
    inclusion_category: Literal["initial_auto", "operator_additional"] = "initial_auto"
    source: str = Field(default="", max_length=64)
    precedence: str = Field(default="", max_length=64)
    version: str = Field(default="", max_length=32)


class SettingsSnapshotV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    snapshot_id: str = Field(default="", max_length=128)
    schema_version: Literal["evaluation-v4"] = "evaluation-v4"
    content_hash: str = Field(default="", max_length=128)
    source_timestamps: dict[str, str] = Field(default_factory=dict)
    filters: list[AppraisalFilterV4] = Field(default_factory=list)
    adjustments: list[CompAdjustmentRuleV4] = Field(default_factory=list)
    transaction_rule: TransactionRuleV4 = Field(default_factory=TransactionRuleV4)
    tiers: list[RenovationTierV4] = Field(default_factory=list)
    deal: DealSettingsV4 = Field(default_factory=DealSettingsV4)
    major_items: list[MajorItemRuleV4] = Field(default_factory=list)

    def canonical_payload(self) -> dict:
        return self.model_dump(mode="json", exclude={"content_hash"})

    def compute_content_hash(self) -> str:
        import json

        return sha256(json.dumps(self.canonical_payload(), sort_keys=True).encode()).hexdigest()

    def validated_for_durable_use(self) -> SettingsSnapshotV4:
        if not self.snapshot_id.strip():
            raise ValueError("settings snapshot_id is required at the durable contract boundary")
        expected = self.compute_content_hash()
        if self.content_hash and self.content_hash != expected:
            raise ValueError("supplied settings content_hash does not match canonical payload")
        if not self.content_hash:
            return self.model_copy(update={"content_hash": expected})
        return self


__all__ = [
    "DealSettingsV4",
    "MajorItemRuleV4",
    "RenovationTierCellV4",
    "RenovationTierV4",
    "SettingsSnapshotV4",
]
