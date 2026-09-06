"""Renovation tier mapping, strict boundary validation, and major items."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.deal import (
    AdditionalRenovationItemV4,
    AdjustmentLedgerEntryV4,
    MajorItemEvidenceV4,
    RenovationItemResultV4,
)
from ..contracts.settings import MajorItemRuleV4, RenovationTierV4

CANONICAL_TIERS = ("under500k", "500k_to_under1m", "1m_to_3m", "over3m")
CANONICAL_LEVELS = (
    "lipstick",
    "light_cosmetic",
    "full_cosmetic",
    "heavy_rehab",
    "full_gut",
)
EXPECTED_ENDPOINTS: dict[str, tuple[str, str | None, str | None]] = {
    "under500k": ("0", None, "500000"),
    "500k_to_under1m": ("500000", None, "1000000"),
    "1m_to_3m": ("1000000", "3000000", None),
    "over3m": ("3000000", None, None),
}
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
ELECTRICAL_GROUP = "electrical"
BASE_OVERLAP_SYSTEMS = {"roof", "hvac", "plumbing", "rewiring", "electrical_panel"}


def canonical_system(system_id: str) -> str:
    key = str(system_id or "").strip().lower()
    return CANONICAL_ALIASES.get(key, key)


def overlap_group(system: str, dedup_group: str) -> str:
    if dedup_group:
        return dedup_group.strip()
    if system in {"electrical_panel", "rewiring"}:
        return ELECTRICAL_GROUP
    if system in BASE_OVERLAP_SYSTEMS:
        return f"base_overlap:{system}"
    return f"auto:{system}"


def validate_tiers(tiers: list[RenovationTierV4]) -> list[str]:
    errors: list[str] = []
    if len(tiers) != 4:
        errors.append(f"expected 4 tiers, got {len(tiers)}")
        return errors
    keys = [t.tier_key for t in tiers]
    if keys != list(CANONICAL_TIERS):
        errors.append(f"tiers must be ordered {list(CANONICAL_TIERS)}, got {keys}")
    if len(set(keys)) != len(keys):
        errors.append("duplicate tier keys")
    for tier in tiers:
        expected = EXPECTED_ENDPOINTS.get(tier.tier_key)
        if expected is None:
            errors.append(f"unknown tier key {tier.tier_key}")
            continue
        lower, upper_incl, upper_excl = expected
        if tier.lower_inclusive != Decimal(lower):
            errors.append(f"{tier.tier_key}: lower_inclusive must be {lower}")
        if upper_incl is None and tier.upper_inclusive is not None:
            errors.append(f"{tier.tier_key}: upper_inclusive must be absent")
        if upper_incl is not None and tier.upper_inclusive != Decimal(upper_incl):
            errors.append(f"{tier.tier_key}: upper_inclusive must be {upper_incl}")
        if upper_excl is None and tier.upper_exclusive is not None:
            errors.append(f"{tier.tier_key}: upper_exclusive must be absent")
        if upper_excl is not None and tier.upper_exclusive != Decimal(upper_excl):
            errors.append(f"{tier.tier_key}: upper_exclusive must be {upper_excl}")
        if tier.upper_inclusive is not None and tier.upper_exclusive is not None:
            errors.append(f"{tier.tier_key}: only one upper bound allowed")
        levels = [c.renovation_level.strip().lower().replace(" ", "_") for c in tier.cells]
        if len(levels) != 5 or sorted(levels) != sorted(CANONICAL_LEVELS):
            errors.append(f"tier {tier.tier_key} must define all five renovation levels once")
        if len(set(levels)) != len(levels):
            errors.append(f"tier {tier.tier_key} has duplicate renovation cells")
    ordered = {t.tier_key: t for t in tiers}
    try:
        if ordered["under500k"].upper_exclusive != ordered["500k_to_under1m"].lower_inclusive:
            errors.append("gap/overlap at 500000")
        if ordered["500k_to_under1m"].upper_exclusive != ordered["1m_to_3m"].lower_inclusive:
            errors.append("gap/overlap at 1000000")
        if ordered["1m_to_3m"].upper_inclusive != ordered["over3m"].lower_inclusive:
            errors.append("gap/overlap at 3000000")
    except KeyError:
        errors.append("missing canonical tier for continuity check")
    return errors


def map_tier(final_arv: Decimal, tiers: list[RenovationTierV4]) -> RenovationTierV4 | None:
    by_key = {t.tier_key: t for t in tiers}
    if final_arv < Decimal(500000):
        return by_key.get("under500k")
    if Decimal(500000) <= final_arv < Decimal(1000000):
        return by_key.get("500k_to_under1m")
    if Decimal(1000000) <= final_arv <= Decimal(3000000):
        return by_key.get("1m_to_3m")
    if final_arv > Decimal(3000000):
        return by_key.get("over3m")
    return None


def find_cell(tier: RenovationTierV4, renovation_level: str) -> object | None:
    want = str(renovation_level or "").strip().lower().replace(" ", "_")
    for cell in tier.cells:
        if cell.renovation_level.strip().lower().replace(" ", "_") == want:
            return cell
    return None


def _reconcile_evidence(
    system: str, records: list[MajorItemEvidenceV4]
) -> tuple[MajorItemEvidenceV4 | None, list[str]]:
    notes: list[str] = []
    if not records:
        return None, notes
    ordered = sorted(
        records,
        key=lambda e: (
            str(e.evidence_date or ""),
            str(e.source or ""),
            str(e.system_id or ""),
        ),
    )
    chosen = ordered[-1]
    ages = {str(r.supported_age_years) for r in records if r.supported_age_years is not None}
    if len(ages) > 1:
        notes.append(f"{system}: conflicting age evidence reconciled deterministically")
    if any(r.conflict_note for r in records):
        notes.append(f"{system}: conflict note preserved")
    if any(r.override_provenance == "operator" for r in records):
        notes.append(f"{system}: operator override provenance preserved")
    return chosen, notes


def evaluate_major_items(
    rules: list[MajorItemRuleV4],
    evidence: list[MajorItemEvidenceV4],
    additional: list[AdditionalRenovationItemV4],
    ledger: list[AdjustmentLedgerEntryV4] | None = None,
) -> tuple[list[RenovationItemResultV4], Decimal, Decimal, list[str]]:
    limitations: list[str] = []
    items: list[RenovationItemResultV4] = []
    auto_total = Decimal(0)
    grouped: dict[str, list[MajorItemEvidenceV4]] = {}
    for record in evidence:
        grouped.setdefault(canonical_system(record.system_id), []).append(record)
    seen_groups: set[str] = set()
    ordered_rules = sorted(rules, key=lambda r: canonical_system(r.system_id))
    for rule in ordered_rules:
        system = canonical_system(rule.system_id)
        records = grouped.get(system, [])
        chosen, notes = _reconcile_evidence(system, records)
        limitations.extend(notes)
        explicit_group = chosen.dedup_group.strip() if chosen and chosen.dedup_group else ""
        group = overlap_group(system, explicit_group)
        summary = ""
        if chosen:
            summary = "; ".join(
                part
                for part in [
                    f"scope={chosen.permit_scope}" if chosen.permit_scope else "",
                    f"completion={chosen.completion_evidence}" if chosen.completion_evidence else "",
                    f"date={chosen.evidence_date}" if chosen.evidence_date else "",
                    f"source={chosen.source}" if chosen.source else "",
                ]
                if part
            )
        if group in seen_groups:
            limitations.append(f"{system}: duplicate overlap group {group}")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="manual" if chosen and chosen.provenance == "manual" else "auto",
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                    evidence_summary=summary or "duplicate overlap suppressed",
                )
            )
            continue
        seen_groups.add(group)
        if not rule.enabled:
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="manual" if chosen and chosen.provenance == "manual" else "auto",
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                    evidence_summary=summary,
                )
            )
            continue
        if system not in INITIAL_AUTO_SYSTEMS:
            limitations.append(f"{system}: available only as explicit operator item")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="manual" if chosen and chosen.provenance == "manual" else "auto",
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                    evidence_summary=summary,
                )
            )
            continue
        if chosen is None or chosen.supported_age_years is None:
            limitations.append(f"{system}: unknown or conflicting evidence")
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                    evidence_summary=summary or "no usable age evidence",
                )
            )
            continue
        if chosen.override_provenance == "operator" and chosen.manual_cost is not None:
            auto_total += chosen.manual_cost
            entry_id = f"major:{system}:{group}:{len(ledger) + 1}" if ledger is not None else ""
            if ledger is not None:
                ledger.append(
                    AdjustmentLedgerEntryV4(
                        entry_id=entry_id,
                        stage="major_item",
                        target_id=f"major:{system}",
                        rule_id=f"major:{system}",
                        signed_amount=chosen.manual_cost,
                        unit="usd",
                        evidence=summary or "operator override",
                        input_value=format(chosen.supported_age_years, "f"),
                        duplicate_key=f"major:{group}",
                    )
                )
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="manual",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=True,
                    signed_cost=chosen.manual_cost,
                    dedup_group=group,
                    evidence_summary=summary or "operator override",
                    ledger_entry_id=entry_id,
                )
            )
            continue
        scope_ok = bool(chosen.permit_scope and chosen.completion_evidence)
        if not scope_ok:
            limitations.append(f"{system}: permit scope/completion insufficient")
        if chosen.supported_age_years > rule.age_threshold_years and scope_ok:
            auto_total += rule.replacement_cost
            entry_id = f"major:{system}:{group}:{len(ledger) + 1}" if ledger is not None else ""
            if ledger is not None:
                ledger.append(
                    AdjustmentLedgerEntryV4(
                        entry_id=entry_id,
                        stage="major_item",
                        target_id=f"major:{system}",
                        rule_id=f"major:{system}",
                        signed_amount=rule.replacement_cost,
                        unit="usd",
                        evidence=summary,
                        input_value=format(chosen.supported_age_years, "f"),
                        duplicate_key=f"major:{group}",
                    )
                )
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=True,
                    signed_cost=rule.replacement_cost,
                    dedup_group=group,
                    evidence_summary=summary,
                    ledger_entry_id=entry_id,
                )
            )
        else:
            items.append(
                RenovationItemResultV4(
                    system_id=system,
                    provenance="auto",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years,
                    included=False,
                    signed_cost=Decimal(0),
                    dedup_group=group,
                    evidence_summary=summary or "age or scope below replacement bar",
                )
            )
    extra_total = Decimal(0)
    for extra in sorted(additional, key=lambda e: (e.dedup_group or "", e.item_id)):
        group = (extra.dedup_group or f"manual:{extra.item_id}").strip()
        if group in seen_groups:
            limitations.append(f"{extra.item_id}: duplicate additional group {group}")
            continue
        seen_groups.add(group)
        extra_total += extra.cost
        if ledger is not None:
            entry_id = f"major:{extra.item_id}:{group}:{len(ledger) + 1}"
            ledger.append(
                AdjustmentLedgerEntryV4(
                    entry_id=entry_id,
                    stage="major_item",
                    target_id=f"additional:{extra.item_id}",
                    rule_id=f"additional:{extra.item_id}",
                    signed_amount=extra.cost,
                    unit="usd",
                    evidence=f"operator additional item {extra.item_id}",
                    input_value=format(extra.cost, "f"),
                    duplicate_key=f"major:{group}",
                )
            )
    return items, auto_total, extra_total, limitations


__all__ = [
    "BASE_OVERLAP_SYSTEMS",
    "CANONICAL_LEVELS",
    "CANONICAL_TIERS",
    "ELECTRICAL_GROUP",
    "EXPECTED_ENDPOINTS",
    "INITIAL_AUTO_SYSTEMS",
    "canonical_system",
    "evaluate_major_items",
    "find_cell",
    "map_tier",
    "overlap_group",
    "validate_tiers",
]
