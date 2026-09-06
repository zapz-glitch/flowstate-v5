"""Signed adjustment application with duplicate prevention and ARV math."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import AdjustmentLedgerEntryV4
from ..contracts.filters import CompAdjustmentRuleV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_text


def _as_decimal(value: object) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except (InvalidOperation, ValueError, AttributeError):
            return None
    return None


def comp_difference(rule: CompAdjustmentRuleV4, subject: SubjectPropertyV4, comp: CompCandidateV4) -> Decimal | None:
    kind = rule.kind
    if kind == "bedroom":
        if subject.beds is None or comp.beds is None:
            return None
        return Decimal(subject.beds) - Decimal(comp.beds)
    if kind == "bathroom":
        if subject.baths is None or comp.baths is None:
            return None
        return Decimal(subject.baths) - Decimal(comp.baths)
    if kind == "sqft":
        if subject.sqft is None or comp.sqft is None:
            return None
        return Decimal(subject.sqft) - Decimal(comp.sqft)
    return None


def signed_adjustment(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str, str]:
    if not rule.enabled:
        return Decimal(0), "disabled rule contributes zero", "0"
    kind = rule.kind
    if kind in {"bedroom", "bathroom", "sqft"}:
        diff = comp_difference(rule, subject, comp)
        if diff is None:
            return None, "unknown bedroom/bathroom/sqft evidence", ""
        per_unit = rule.per_unit_amount if rule.per_unit_amount is not None else rule.signed_amount
        if per_unit is None:
            return None, "unknown per-unit amount", ""
        return per_unit * diff, f"{kind} diff {diff} x {per_unit}", str(diff)
    if kind in {"feature", "proximity", "sale_age"}:
        return rule.signed_amount, f"configured signed amount {rule.signed_amount}", ""
    return None, f"unsupported adjustment kind {kind}", ""


def apply_comp_adjustments(
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
    rules: list[CompAdjustmentRuleV4],
    stage: str,
    seen_keys: set[str],
    ledger: list[AdjustmentLedgerEntryV4],
    limitations: list[str] | None = None,
) -> tuple[Decimal, list[str]]:
    total = Decimal(0)
    skipped: list[str] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.applies_to == "subject" and stage == "comp":
            continue
        if rule.applies_to == "comp" and stage == "subject":
            continue
        key = f"{stage}:{comp.comp_id if stage != 'subject' else 'subject'}:{rule.rule_id}"
        if key in seen_keys:
            skipped.append(f"{rule.rule_id}: duplicate application prevented")
            continue
        amount, evidence, input_value = signed_adjustment(rule, subject, comp)
        if amount is None:
            skipped.append(f"{rule.rule_id}: {evidence}")
            if limitations is not None:
                limitations.append(evidence)
            continue
        seen_keys.add(key)
        total += amount
        ledger.append(
            AdjustmentLedgerEntryV4(
                entry_id=f"{key}:{len(ledger) + 1}",
                stage=stage,  # type: ignore[arg-type]
                target_id=comp.comp_id if stage != "subject" else "subject",
                rule_id=rule.rule_id,
                signed_amount=amount,
                unit=rule.unit,
                evidence=evidence,
                input_value=input_value or norm_text(rule.signed_amount),
                duplicate_key=key,
            )
        )
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
    "comp_difference",
    "mean",
    "signed_adjustment",
]
