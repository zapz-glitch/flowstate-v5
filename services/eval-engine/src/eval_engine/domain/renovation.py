"""Renovation tier mapping, explicit boundary semantics, and major items.

Canonical identity is independent of overlap groups: ``canonical_system``
maps aliases to one key. Auto-first precedence resolves competing auto
claims for one canonical system deterministically; base-covered systems go
to a reserve result instead of being dropped. Overlap groups cover only
triggering candidates. Panel/rewiring share electrical coverage; nonagents
never reserve groups.
"""

from __future__ import annotations

from decimal import Decimal

from ..contracts.deal import (
    AdditionalItemResultV4,
    AdditionalRenovationItemV4,
    AdjustmentLedgerEntryV4,
    MajorItemEvidenceV4,
    RenovationItemResultV4,
)
from ..contracts.settings import MajorItemRuleV4, RenovationTierV4, tier_boundary_problems

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
    "electrical panel": "electrical_panel",
    "panel": "electrical_panel",
    "replumb": "plumbing",
    "re-plumb": "plumbing",
    "rewire": "rewiring",
    "re-wire": "rewiring",
    "water heater": "water_heater",
    "waterheater": "water_heater",
}
MANUAL_ALIASES = {
    "down to stud": "full_gut",
    "down_to_stud": "full_gut",
}
ELECTRICAL_GROUP = "electrical"
LEVEL_ALIASES = {
    "down to stud": "full_gut",
    "down_to_stud": "full_gut",
    "full gut": "full_gut",
}


def canonical_system(system_id: str) -> str:
    key = str(system_id or "").strip().lower().replace("_", " ").strip()
    normalized = " ".join(key.split())
    if normalized in CANONICAL_ALIASES:
        return CANONICAL_ALIASES[normalized]
    compact = normalized.replace(" ", "_")
    return CANONICAL_ALIASES.get(compact, compact)


def canonical_level(level: str) -> str:
    key = str(level or "").strip().lower().replace("_", " ").strip()
    normalized = " ".join(key.split())
    if normalized in LEVEL_ALIASES:
        return LEVEL_ALIASES[normalized]
    return normalized.replace(" ", "_")


def overlap_group(system: str, dedup_group: str) -> str:
    if dedup_group:
        return dedup_group.strip()
    if system in {"electrical_panel", "rewiring"}:
        return ELECTRICAL_GROUP
    if system in INITIAL_AUTO_SYSTEMS:
        return f"base_overlap:{system}"
    return f"auto:{system}"


def tier_inclusivity(tier: RenovationTierV4) -> str:
    lower = f"[{tier.lower_inclusive}" if tier.lower_inclusive is not None else f"({tier.lower_exclusive}"
    if tier.upper_inclusive is not None:
        return f"{lower}..{tier.upper_inclusive}]"
    if tier.upper_exclusive is not None:
        return f"{lower}..{tier.upper_exclusive})"
    return f"{lower}..open)"


def validate_tiers(tiers: list[RenovationTierV4]) -> list[str]:
    errors = tier_boundary_problems(tiers)
    if len(tiers) != 4:
        return errors
    for tier in tiers:
        levels = [canonical_level(c.renovation_level) for c in tier.cells]
        if len(levels) != 5 or sorted(levels) != sorted(CANONICAL_LEVELS):
            errors.append(f"tier {tier.tier_key} must define all five renovation levels once")
        if len(set(levels)) != len(levels):
            errors.append(f"tier {tier.tier_key} has duplicate renovation cells")
        for cell in tier.cells:
            for raw in cell.included_systems:
                if canonical_system(raw) == "":
                    errors.append(f"{tier.tier_key}: empty included system")
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
    want = canonical_level(renovation_level)
    for cell in tier.cells:
        if canonical_level(cell.renovation_level) == want:
            return cell
    manual = MANUAL_ALIASES.get(str(renovation_level or "").strip().lower())
    if manual:
        for cell in tier.cells:
            if canonical_level(cell.renovation_level) == manual:
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
    tier_cell_systems: list[str] | None = None,
) -> tuple[list[RenovationItemResultV4], Decimal, Decimal, list[str], list[AdditionalItemResultV4]]:
    limitations: list[str] = []
    items: list[RenovationItemResultV4] = []
    auto_total = Decimal(0)
    grouped: dict[str, list[MajorItemEvidenceV4]] = {}
    for record in evidence:
        grouped.setdefault(canonical_system(record.system_id), []).append(record)
    cell_systems = {canonical_system(s) for s in (tier_cell_systems or [])}
    candidates: list[tuple[MajorItemRuleV4, str, str, MajorItemEvidenceV4 | None, str, str]] = []
    ordered_rules = sorted(rules, key=lambda r: (canonical_system(r.system_id), r.system_id))
    for rule in ordered_rules:
        system = canonical_system(rule.system_id)
        records = grouped.get(system, [])
        chosen, notes = _reconcile_evidence(system, records)
        limitations.extend(notes)
        explicit_group = chosen.dedup_group.strip() if chosen and chosen.dedup_group else ""
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
        candidates.append((rule, rule.system_id, system, chosen, explicit_group, summary))
    triggering: set[str] = set()
    for rule, _raw, system, chosen, _group, _summary in candidates:
        if not rule.enabled or system not in INITIAL_AUTO_SYSTEMS:
            continue
        if chosen is None or chosen.supported_age_years is None:
            continue
        if chosen.override_provenance == "operator" and chosen.manual_cost is not None:
            triggering.add(system)
        elif chosen.supported_age_years > rule.age_threshold_years and chosen.permit_scope and chosen.completion_evidence:
            triggering.add(system)
    winner_by_group: dict[str, str] = {}
    for system in sorted(triggering):
        member_rules = [(rule, raw, chosen, explicit) for rule, raw, sys, chosen, explicit, _ in candidates if sys == system]
        member_rules.sort(key=lambda t: (0 if t[0].inclusion_category == "initial_auto" else 1, t[1]))
        winner = member_rules[0]
        explicit = winner[3].dedup_group.strip() if winner[2] and winner[2].dedup_group else winner[3]
        group = overlap_group(system, explicit)
        winner_by_group[group] = system
    reserved_groups: set[str] = set()
    for rule, raw_id, system, chosen, explicit_group, summary in candidates:
        provenance = "manual" if chosen and chosen.provenance == "manual" else "auto"
        group = overlap_group(system, explicit_group)
        if system in triggering:
            winner = winner_by_group.get(group)
            if winner is not None and winner != system:
                limitations.append(f"{system}: covered by {winner} in {group}; reserve")
                items.append(
                    RenovationItemResultV4(
                        system_id=raw_id, canonical_system_id=system, provenance=provenance,
                        supported_age=chosen.supported_age_years if chosen else None,
                        threshold=rule.age_threshold_years, included=False,
                        signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                        evidence_summary=(summary + f"; covered by {winner}" if summary else f"covered by {winner}"),
                    )
                )
                continue
            if system in cell_systems:
                limitations.append(f"{system}: base rehab overlap; base-covered reserve")
                reserved_groups.add(group)
                items.append(
                    RenovationItemResultV4(
                        system_id=raw_id, canonical_system_id=system, provenance=provenance,
                        supported_age=chosen.supported_age_years if chosen else None,
                        threshold=rule.age_threshold_years, included=False,
                        signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                        evidence_summary=(summary + "; base-covered reserve" if summary else "base-covered reserve"),
                    )
                )
                continue
            if group in reserved_groups:
                limitations.append(f"{system}: duplicate overlap group {group}")
                items.append(
                    RenovationItemResultV4(
                        system_id=raw_id, canonical_system_id=system, provenance=provenance,
                        supported_age=chosen.supported_age_years if chosen else None,
                        threshold=rule.age_threshold_years, included=False,
                        signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                        evidence_summary=summary or "duplicate overlap suppressed",
                    )
                )
                continue
            reserved_groups.add(group)
        if not rule.enabled:
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance=provenance,
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years, included=False,
                    signed_cost=Decimal(0), overlap_group=group, dedup_group=group, evidence_summary=summary,
                )
            )
            continue
        if system not in INITIAL_AUTO_SYSTEMS:
            limitations.append(f"{system}: available only as explicit operator item")
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance=provenance,
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years, included=False,
                    signed_cost=Decimal(0), overlap_group=group, dedup_group=group, evidence_summary=summary,
                )
            )
            continue
        if chosen is None or chosen.supported_age_years is None:
            limitations.append(f"{system}: unknown or conflicting evidence")
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance="auto",
                    supported_age=chosen.supported_age_years if chosen else None,
                    threshold=rule.age_threshold_years, included=False,
                    signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                    evidence_summary=summary or "no usable age evidence",
                )
            )
            continue
        if chosen.override_provenance == "operator" and chosen.manual_cost is not None:
            if system not in triggering:
                items.append(
                    RenovationItemResultV4(
                        system_id=raw_id, canonical_system_id=system, provenance="manual",
                        supported_age=chosen.supported_age_years,
                        threshold=rule.age_threshold_years, included=False,
                        signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                        evidence_summary=summary or "operator override",
                    )
                )
                continue
            auto_total += chosen.manual_cost
            entry_id = f"major:{system}:{group}:{len(ledger) + 1}" if ledger is not None else ""
            if ledger is not None:
                ledger.append(
                    AdjustmentLedgerEntryV4(
                        entry_id=entry_id, stage="major_item", target_id=f"major:{system}",
                        rule_id=f"major:{system}", signed_amount=chosen.manual_cost, unit="usd",
                        evidence=summary or "operator override",
                        input_value=format(chosen.supported_age_years, "f"),
                        duplicate_key=f"major:{group}",
                    )
                )
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance="manual",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years, included=True,
                    signed_cost=chosen.manual_cost, overlap_group=group, dedup_group=group,
                    evidence_summary=summary or "operator override", ledger_entry_id=entry_id,
                )
            )
            continue
        scope_ok = bool(chosen.permit_scope and chosen.completion_evidence)
        if not scope_ok:
            limitations.append(f"{system}: permit scope/completion insufficient")
        if system in triggering:
            auto_total += rule.replacement_cost
            entry_id = f"major:{system}:{group}:{len(ledger) + 1}" if ledger is not None else ""
            if ledger is not None:
                ledger.append(
                    AdjustmentLedgerEntryV4(
                        entry_id=entry_id, stage="major_item", target_id=f"major:{system}",
                        rule_id=f"major:{system}", signed_amount=rule.replacement_cost, unit="usd",
                        evidence=summary, input_value=format(chosen.supported_age_years, "f"),
                        duplicate_key=f"major:{group}",
                    )
                )
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance="auto",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years, included=True,
                    signed_cost=rule.replacement_cost, overlap_group=group, dedup_group=group,
                    evidence_summary=summary, ledger_entry_id=entry_id,
                )
            )
        else:
            items.append(
                RenovationItemResultV4(
                    system_id=raw_id, canonical_system_id=system, provenance="auto",
                    supported_age=chosen.supported_age_years,
                    threshold=rule.age_threshold_years, included=False,
                    signed_cost=Decimal(0), overlap_group=group, dedup_group=group,
                    evidence_summary=summary or "age or scope below replacement bar",
                )
            )
    extra_total = Decimal(0)
    additional_results: list[AdditionalItemResultV4] = []
    by_group: dict[str, list[AdditionalRenovationItemV4]] = {}
    for extra in additional:
        group = (extra.dedup_group or f"manual:{extra.item_id}").strip()
        by_group.setdefault(group, []).append(extra)
    if reserved_groups:
        pass
    for group in sorted(by_group):
        members = sorted(by_group[group], key=lambda e: e.item_id)
        if group in reserved_groups:
            for member in members:
                additional_results.append(
                    AdditionalItemResultV4(
                        item_id=member.item_id, included=False,
                        requested_cost=member.cost, applied_cost=Decimal(0),
                        provenance=member.provenance, source=member.source,
                        dedup_group=group, winning_item_id="",
                        reason=f"explicit conflict: group {group} already covered",
                    )
                )
            limitations.append(f"additional group {group}: explicit conflict with covered major group")
            continue
        if len(members) > 1:
            costs = {str(m.cost) for m in members}
            if len(costs) > 1:
                for member in members:
                    additional_results.append(
                        AdditionalItemResultV4(
                            item_id=member.item_id, included=False,
                            requested_cost=member.cost, applied_cost=Decimal(0),
                            provenance=member.provenance, source=member.source,
                            dedup_group=group, winning_item_id="",
                            reason=f"explicit conflict: duplicate additional group {group} with differing costs",
                        )
                    )
                limitations.append(f"additional group {group}: explicit conflict; differing costs")
                continue
            winner = members[0]
            extra_total += winner.cost
            entry_id = ""
            if ledger is not None:
                entry_id = f"major:{winner.item_id}:{group}:{len(ledger) + 1}"
                ledger.append(
                    AdjustmentLedgerEntryV4(
                        entry_id=entry_id, stage="major_item",
                        target_id=f"additional:{winner.item_id}",
                        rule_id=f"additional:{winner.item_id}",
                        signed_amount=winner.cost, unit="usd",
                        evidence=f"operator additional item {winner.item_id}",
                        input_value=format(winner.cost, "f"), duplicate_key=f"major:{group}",
                    )
                )
            for member in members:
                additional_results.append(
                    AdditionalItemResultV4(
                        item_id=member.item_id, included=member.item_id == winner.item_id,
                        requested_cost=member.cost,
                        applied_cost=winner.cost if member.item_id == winner.item_id else Decimal(0),
                        provenance=member.provenance, source=member.source,
                        dedup_group=group, winning_item_id=winner.item_id,
                        reason="included" if member.item_id == winner.item_id else f"duplicate of {winner.item_id}",
                        ledger_entry_id=entry_id if member.item_id == winner.item_id else "",
                    )
                )
            reserved_groups.add(group)
            continue
        member = members[0]
        extra_total += member.cost
        entry_id = ""
        if ledger is not None:
            entry_id = f"major:{member.item_id}:{group}:{len(ledger) + 1}"
            ledger.append(
                AdjustmentLedgerEntryV4(
                    entry_id=entry_id, stage="major_item",
                    target_id=f"additional:{member.item_id}",
                    rule_id=f"additional:{member.item_id}",
                    signed_amount=member.cost, unit="usd",
                    evidence=f"operator additional item {member.item_id}",
                    input_value=format(member.cost, "f"), duplicate_key=f"major:{group}",
                )
            )
        additional_results.append(
            AdditionalItemResultV4(
                item_id=member.item_id, included=True,
                requested_cost=member.cost, applied_cost=member.cost,
                provenance=member.provenance, source=member.source,
                dedup_group=group, winning_item_id=member.item_id,
                reason="included", ledger_entry_id=entry_id,
            )
        )
        reserved_groups.add(group)
    return items, auto_total, extra_total, limitations, additional_results


__all__ = [
    "CANONICAL_LEVELS",
    "CANONICAL_TIERS",
    "ELECTRICAL_GROUP",
    "INITIAL_AUTO_SYSTEMS",
    "canonical_level",
    "canonical_system",
    "evaluate_major_items",
    "find_cell",
    "map_tier",
    "overlap_group",
    "tier_inclusivity",
    "validate_tiers",
]
