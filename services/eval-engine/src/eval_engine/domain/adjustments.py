"""Evidence-driven signed adjustments with duplicate prevention and ARV math."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import AdjustmentLedgerEntryV4
from ..contracts.filters import CompAdjustmentRuleV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_text


def comp_difference(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str]:
    kind = rule.kind
    if kind == "bedroom":
        if subject.beds is None or comp.beds is None:
            return None, "unknown bedroom evidence"
        field = rule.evidence_field or "beds"
        return Decimal(subject.beds) - Decimal(comp.beds), field
    if kind == "bathroom":
        if subject.baths is None or comp.baths is None:
            return None, "unknown bathroom evidence"
        field = rule.evidence_field or "baths"
        return Decimal(subject.baths) - Decimal(comp.baths), field
    if kind == "sqft":
        if subject.sqft is None or comp.sqft is None:
            return None, "unknown sqft evidence"
        field = rule.evidence_field or "sqft"
        return Decimal(subject.sqft) - Decimal(comp.sqft), field
    return None, f"unsupported per-unit kind {kind}"


def signed_adjustment(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str, str, str]:
    if not rule.enabled:
        return Decimal(0), "disabled rule contributes zero", "0", "skipped_disabled"
    kind = rule.kind
    if kind in {"bedroom", "bathroom", "sqft"}:
        diff, field = comp_difference(rule, subject, comp)
        if diff is None:
            return None, field, "", "skipped_unknown_evidence"
        per_unit = rule.per_unit_amount if rule.per_unit_amount is not None else rule.signed_amount
        if per_unit is None:
            return None, "unknown per-unit amount", "", "skipped_unknown_amount"
        if diff == 0:
            return Decimal(0), f"{kind} no difference ({field})", "0", "no_difference"
        return per_unit * diff, f"{kind} diff {diff} x {per_unit} ({field})", str(diff), "applied"
    if kind in {"feature", "proximity"}:
        return rule.signed_amount, f"configured signed amount {rule.signed_amount}", "", "applied"
    if kind == "sale_age":
        return None, "sale_age adjustments require explicit evidence-driven policy", "", "skipped_no_policy"
    return None, f"unsupported adjustment kind {kind}", "", "skipped_unsupported"


def apply_comp_adjustments(
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
    rules: list[CompAdjustmentRuleV4],
    stage: str,
    seen_keys: set[str],
    ledger: list[AdjustmentLedgerEntryV4],
    limitations: list[str] | None = None,
) -> tuple[Decimal, list[str]]:
    if stage not in {"comp", "investor_comp"}:
        raise ValueError("apply_comp_adjustments handles comp stages only")
    total = Decimal(0)
    skipped: list[str] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.applies_to != "comp":
            skipped.append(f"{rule.rule_id}: skipped (applies_to={rule.applies_to})")
            continue
        key = f"{stage}:{comp.comp_id}:{rule.rule_id}"
        if key in seen_keys:
            skipped.append(f"{rule.rule_id}: duplicate application prevented")
            continue
        amount, evidence, input_value, _ = signed_adjustment(rule, subject, comp)
        if amount is None:
            skipped.append(f"{rule.rule_id}: {evidence}")
            if limitations is not None:
                limitations.append(f"{comp.comp_id}:{rule.rule_id}: {evidence}")
            continue
        seen_keys.add(key)
        total += amount
        ledger.append(
            AdjustmentLedgerEntryV4(
                entry_id=f"{key}:{len(ledger) + 1}",
                stage=stage,  # type: ignore[arg-type]
                target_id=comp.comp_id,
                rule_id=rule.rule_id,
                signed_amount=amount,
                unit=rule.unit,
                evidence=evidence,
                input_value=input_value or norm_text(rule.signed_amount),
                duplicate_key=key,
            )
        )
    return total, skipped


def apply_subject_adjustments(
    subject: SubjectPropertyV4,
    rules: list[CompAdjustmentRuleV4],
    ledger: list[AdjustmentLedgerEntryV4],
    seen_keys: set[str] | None = None,
    limitations: list[str] | None = None,
) -> tuple[Decimal, list[str]]:
    owned = set() if seen_keys is None else seen_keys
    total = Decimal(0)
    skipped: list[str] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.applies_to != "subject":
            continue
        key = f"subject:subject:{rule.rule_id}"
        if key in owned:
            skipped.append(f"{rule.rule_id}: duplicate subject application prevented")
            continue
        owned.add(key)
        total += rule.signed_amount
        ledger.append(
            AdjustmentLedgerEntryV4(
                entry_id=f"{key}:{len(ledger) + 1}",
                stage="subject",
                target_id="subject",
                rule_id=rule.rule_id,
                signed_amount=rule.signed_amount,
                unit=rule.unit,
                evidence=f"subject adjustment {rule.rule_id}",
                input_value=format(rule.signed_amount, "f"),
                duplicate_key=key,
            )
        )
    if limitations is not None and skipped:
        limitations.extend(skipped)
    return total, skipped


def adjusted_ppsf(price: Decimal, sqft: Decimal | None) -> Decimal | None:
    if sqft is None or sqft <= 0:
        return None
    return price / sqft


def mean(values: list[Decimal]) -> Decimal:
    total = sum(values, Decimal(0))
    return total / Decimal(len(values))


__all__ = [
    "adjusted_ppsf",
    "apply_comp_adjustments",
    "apply_subject_adjustments",
    "comp_difference",
    "mean",
    "signed_adjustment",
]
