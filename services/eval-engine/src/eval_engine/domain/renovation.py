"""Renovation tier mapping, boundary validation, and major-item rules."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.deal import (
    AdditionalRenovationItemV4,
    MajorItemEvidenceV4,
    RenovationItemResultV4,
)
from ..contracts.settings import MajorItemRuleV4, RenovationTierV4, SettingsSnapshotV4

CANONICAL_TIERS = ("under500k", "500k_to_under1m", "1m_to_3m", "over3m")
CANONICAL_LEVELS = (
    "lipstick",
    "light_cosmetic",
    "full_cosmetic",
    "heavy_rehab",
    "full_gut",
)
INITIAL_AUTO_SYSTEMS = {
    "roof",
    "hvac",
    "water_heater",
    "electrical_panel",
    "plumbing",
    "rewiring",
}
CANONICAL_ALIASES = {
    "electric_panel": "electrical_panel",
    "replumb": "plumbing",
    "rewire": "rewiring",
}


def canonical_system(system_id: str) -> str:
    key = str(system_id or "").strip().lower()
    return CANONICAL_ALIASES.get(key, key)


def validate_tiers(tiers: list[RenovationTierV4]) -> list[str]:
    errors: list[str] = []
    if len(tiers) != 4:
        errors.append(f"expected 4 tiers, got {len(tiers)}")
    keys = [t.tier_key for t in tiers]
    if sorted(keys) != sorted(CANONICAL_TIERS):
        errors.append(f"tiers must match canonical keys {CANONICAL_TIERS}")
    if len(set(keys)) != len(keys):
        errors.append("duplicate tier keys")
    bounds: dict[str, RenovationTierV4] = {t.tier_key: t for t in tiers}
    try:
        under = bounds.get("under500k")
        mid = bounds.get("500k_to_under1m")
        high = bounds.get("1m_to_3m")
        over = bounds.get("over3m")
        if under and (under.upper_exclusive != Decimal(500000) or under.upper_inclusive is not None):
            errors.append("under500k must be ARV < 500000")
        if mid and (
            mid.lower_inclusive != Decimal(500000)
            or mid.upper_exclusive != Decimal(1000000)
            or mid.upper_inclusive is not None
        ):
            errors.append("500k_to_under1m must be 500000 inclusive to 1000000 exclusive")
        if high and (
            high.lower_inclusive != Decimal(1000000)
            or high.upper_inclusive != Decimal(3000000)
            or high.upper_exclusive is not None
        ):
            errors.append("1m_to_3m must be 1000000 through 3000000 inclusive")
        if over and (over.lower_inclusive != Decimal(3000000) or over.upper_inclusive is not None or over.upper_exclusive is not None):
            errors.append("over3m must be ARV > 3000000")
    except (KeyError, AttributeError, TypeError):
        errors.append("invalid tier boundary values")
    for tier in tiers:
        levels = [c.renovation_level.strip().lower() for c in tier.cells]
        if sorted(levels) != sorted(CANONICAL_LEVELS):
            errors.append(f"tier {tier.tier_key} must define all five renovation levels")
    return errors


def map_tier(final_arv: Decimal, tiers: list[RenovationTierV4]) -> RenovationTierV4 | None:
    for tier in tiers:
        key = tier.tier_key
        if key == "under500k" and final_arv < Decimal(500000):
            return tier
        if key == "500k_to_under1m" and Decimal(500000) <= final_arv < Decimal(1000000):
            return tier
        if key == "1m_to_3m" and Decimal(1000000) <= final_arv <= Decimal(3000000):
            return tier
        if key == "over3m" and final_arv > Decimal(3000000):
            return tier
    return None


def find_cell(tier: RenovationTierV4, renovation_level: str) -> object | None:
    want = str(renovation_level or "").strip().lower().replace(" ", "_")
    for cell in tier.cells:
        if cell.renovation_level.strip().lower().replace(" ", "_") == want:
            return cell
    return None


def evaluate_major_items(
    rules: list[MajorItemRuleV4],
    evidence: list[MajorItemEvidenceV4],
    additional: list[AdditionalRenovationItemV4],
) -> tuple[list[RenovationItemResultV4], Decimal, Decimal, list[str]]:
    limitations: list[str] = []
    items: list[RenovationItemResultV4] = []
    auto_total = Decimal(0)
    by_system: dict[str, MajorItemEvidenceV4] = {}
    for ev in evidence:
        by_system.setdefault(canonical_system(ev.system_id), ev)
    seen_groups: set[str] = set()
    for rule in rules:
        system = canonical_system(rule.system_id)
        ev = by_system.get(system)
        group = (ev.dedup_group if ev and ev.dedup_group else f"auto:{system}").strip()
        if group in seen_groups:
            limitations.append(f"{system}: duplicate evidence group {group}")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years if ev else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                )
            )
            continue
        seen_groups.add(group)
        if not rule.enabled:
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years if ev else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                )
            )
            continue
        if ev is None or ev.supported_age_years is None:
            limitations.append(f"{system}: unknown or conflicting evidence")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years if ev else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                )
            )
            continue
        if system not in INITIAL_AUTO_SYSTEMS:
            limitations.append(f"{system}: not in initial automatic pathway")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                )
            )
            continue
        if ev.supported_age_years > rule.age_threshold_years:
            auto_total += rule.replacement_cost
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=True,
                    signed_cost=rule.replacement_cost,
                    dedup_group=group,
                )
            )
        else:
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=ev.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                )
            )
    extra_total = Decimal(0)
    for extra in additional:
        group = (extra.dedup_group or f"manual:{extra.item_id}").strip()
        if group in seen_groups:
            limitations.append(f"{extra.item_id}: duplicate additional group {group}")
            continue
        seen_groups.add(group)
        extra_total += extra.cost
    return items, auto_total, extra_total, limitations


__all__ = [
    "CANONICAL_LEVELS",
    "CANONICAL_TIERS",
    "INITIAL_AUTO_SYSTEMS",
    "canonical_system",
    "evaluate_major_items",
    "find_cell",
    "map_tier",
    "validate_tiers",
]
