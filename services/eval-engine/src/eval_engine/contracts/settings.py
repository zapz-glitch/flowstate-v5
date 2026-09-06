"""Immutable settings snapshot contract."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .base import DecimalString, canonical_hash
from .filters import AppraisalFilterV4, CompAdjustmentRuleV4, TransactionRuleV4


_CANONICAL_TIER_ORDER = ("under500k", "500k_to_under1m", "1m_to_3m", "over3m")
_CANONICAL_ENDPOINTS: dict[str, tuple[str | None, str | None, str | None, str | None]] = {
    "under500k": ("0", None, None, "500000"),
    "500k_to_under1m": ("500000", None, None, "1000000"),
    "1m_to_3m": ("1000000", None, "3000000", None),
    "over3m": (None, "3000000", None, None),
}


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
    lower_inclusive: DecimalString | None = None
    lower_exclusive: DecimalString | None = None
    upper_inclusive: DecimalString | None = None
    upper_exclusive: DecimalString | None = None
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


# V4-104 domain -> persistence status mapping. The typed domain uses
# COMPLETED for a fully valued result; the durable result contract uses
# VALUED. All other durable statuses are spelled identically in both
# layers, so only COMPLETED needs translation.
DOMAIN_TO_PERSISTENCE_STATUS: dict[str, str] = {
    "COMPLETED": "VALUED",
    "REVIEW_REQUIRED": "REVIEW_REQUIRED",
    "INSUFFICIENT_COMPS": "INSUFFICIENT_COMPS",
    "INSUFFICIENT_INVESTOR_DATA": "INSUFFICIENT_INVESTOR_DATA",
    "INCOMPLETE": "INCOMPLETE",
    "FAILED": "FAILED",
}


def to_persistence_status(domain_status: str) -> str:
    """Map a typed domain result status to the durable result status."""
    try:
        return DOMAIN_TO_PERSISTENCE_STATUS[domain_status]
    except KeyError as exc:
        raise ValueError(f"unknown domain status {domain_status!r}") from exc


def settings_envelope(snapshot: SettingsSnapshotV4) -> dict:
    """Build the one canonical settings snapshot envelope.

    The envelope is the single hashed identity shared by the typed
    domain, persisted canonicalization, and the result
    ``settings_content_hash``. Generated identifiers (``snapshot_id``,
    ``content_hash``) are excluded. Everything material is included:

    - ``version``: the schema/snapshot version (``schema_version``),
    - ``content``: values (filters, adjustments, transaction rule, tiers,
      deal, major items),
    - ``source``: provenance/source/timestamps (``source_timestamps``
      plus per-rule ``source``/``precedence``/``version`` fields, which
      already live inside the content rules and are therefore preserved
      verbatim in ``content`` rather than duplicated).
    """
    payload = snapshot.model_dump(mode="python")
    payload.pop("snapshot_id", None)
    payload.pop("content_hash", None)
    version = payload.pop("schema_version", "evaluation-v4")
    source_timestamps = payload.pop("source_timestamps", {})
    return {
        "version": version,
        "content": payload,
        "source": {"source_timestamps": source_timestamps},
    }


def snapshot_store_parts(snapshot: SettingsSnapshotV4) -> tuple[str, dict, dict]:
    """Split a snapshot into persistence store parts.

    Returns ``(version, content, source)`` suitable for
    ``store_settings_snapshot`` so the persistence identity input
    (``{"version", "content", "source"}``) is exactly the envelope that
    the domain hashes. Stored JSON is the canonicalized form of those
    same parts, so ``hash(stored) == hash(input)``.
    """
    envelope = settings_envelope(snapshot)
    return envelope["version"], envelope["content"], envelope["source"]


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
        return settings_envelope(self)

    def compute_content_hash(self) -> str:
        return canonical_hash(settings_envelope(self))

    def validated_for_durable_use(self) -> SettingsSnapshotV4:
        if not self.snapshot_id.strip():
            raise ValueError("settings snapshot_id is required at the durable contract boundary")
        tier_problems = tier_boundary_problems(self.tiers)
        if tier_problems:
            raise ValueError("invalid tier boundaries: " + "; ".join(tier_problems))
        expected = self.compute_content_hash()
        if self.content_hash and self.content_hash != expected:
            raise ValueError("supplied settings content_hash does not match canonical payload")
        if not self.content_hash:
            return self.model_copy(update={"content_hash": expected})
        return self


def tier_boundary_problems(tiers: list[RenovationTierV4]) -> list[str]:
    errors: list[str] = []
    if len(tiers) != 4:
        return [f"expected 4 tiers, got {len(tiers)}"]
    keys = [t.tier_key for t in tiers]
    if keys != list(_CANONICAL_TIER_ORDER):
        errors.append(f"tiers must be ordered {list(_CANONICAL_TIER_ORDER)}, got {keys}")
    for tier in tiers:
        expected = _CANONICAL_ENDPOINTS.get(tier.tier_key)
        if expected is None:
            errors.append(f"unknown tier key {tier.tier_key}")
            continue
        lower_incl, lower_excl, upper_incl, upper_excl = expected
        lowers = [v for v in (tier.lower_inclusive, tier.lower_exclusive) if v is not None]
        uppers = [v for v in (tier.upper_inclusive, tier.upper_exclusive) if v is not None]
        if len(lowers) != 1:
            errors.append(f"{tier.tier_key}: exactly one lower bound required")
        if tier.tier_key == "over3m":
            if len(uppers) != 0:
                errors.append(f"{tier.tier_key}: must be open-ended (no upper bound)")
        elif len(uppers) != 1:
            errors.append(f"{tier.tier_key}: exactly one upper bound required")
        if lower_incl is not None and tier.lower_inclusive != Decimal(lower_incl):
            errors.append(f"{tier.tier_key}: lower_inclusive must be {lower_incl}")
        if lower_excl is not None and tier.lower_exclusive != Decimal(lower_excl):
            errors.append(f"{tier.tier_key}: lower_exclusive must be {lower_excl}")
        if lower_incl is None and tier.lower_inclusive is not None:
            errors.append(f"{tier.tier_key}: lower_inclusive must be absent")
        if lower_excl is None and tier.lower_exclusive is not None:
            errors.append(f"{tier.tier_key}: lower_exclusive must be absent")
        if upper_incl is not None and tier.upper_inclusive != Decimal(upper_incl):
            errors.append(f"{tier.tier_key}: upper_inclusive must be {upper_incl}")
        if upper_excl is not None and tier.upper_exclusive != Decimal(upper_excl):
            errors.append(f"{tier.tier_key}: upper_exclusive must be {upper_excl}")
        if upper_incl is None and tier.upper_inclusive is not None:
            errors.append(f"{tier.tier_key}: upper_inclusive must be absent")
        if upper_excl is None and tier.upper_exclusive is not None:
            errors.append(f"{tier.tier_key}: upper_exclusive must be absent")
    ordered = {t.tier_key: t for t in tiers}
    try:
        if ordered["under500k"].upper_exclusive != ordered["500k_to_under1m"].lower_inclusive:
            errors.append("gap/overlap at 500000")
        if ordered["500k_to_under1m"].upper_exclusive != ordered["1m_to_3m"].lower_inclusive:
            errors.append("gap/overlap at 1000000")
        if ordered["1m_to_3m"].upper_inclusive != ordered["over3m"].lower_exclusive:
            errors.append("gap/overlap at 3000000")
    except KeyError:
        errors.append("missing canonical tier for continuity check")
    return errors


__all__ = [
    "DOMAIN_TO_PERSISTENCE_STATUS",
    "DealSettingsV4",
    "MajorItemRuleV4",
    "RenovationTierCellV4",
    "RenovationTierV4",
    "SettingsSnapshotV4",
    "settings_envelope",
    "snapshot_store_parts",
    "tier_boundary_problems",
    "to_persistence_status",
]
