"""Evidence-driven signed adjustments with typed outcomes."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import AdjustmentLedgerEntryV4, AdjustmentOutcomeV4
from ..contracts.filters import CompAdjustmentRuleV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_text

_NUMERIC_FIELDS = {"beds", "baths", "sqft", "lot_sqft", "distance_miles"}
_TEXT_FIELDS = {"subdivision", "property_type", "address"}


def _numeric_evidence(holder: object, field: str) -> tuple[Decimal | None, str]:
    if not field:
        return None, "missing evidence_field mapping"
    if field in _TEXT_FIELDS:
        return None, f"text field {field!r} has no numeric difference"
    raw = getattr(holder, field, None)
    if raw is None:
        return None, f"unknown {field} evidence"
    if isinstance(raw, Decimal):
        return raw, field
    return None, f"non-decimal {field} evidence"


def _typed_difference(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str, str]:
    kind = rule.kind
    if kind == "bedroom":
        subject_field = rule.resolved_subject_field or "beds"
        comp_field = rule.resolved_comp_field or "beds"
        subject_value, _ = _numeric_evidence(subject, subject_field)
        comp_value, _ = _numeric_evidence(comp, comp_field)
        if subject_value is None or comp_value is None:
            return None, "unknown bedroom evidence", f"{subject_field}/{comp_field}"
        return subject_value - comp_value, f"{subject_field}/{comp_field}", f"subject.{subject_field}-comp.{comp_field}"
    if kind == "bathroom":
        subject_field = rule.resolved_subject_field or "baths"
        comp_field = rule.resolved_comp_field or "baths"
        subject_value, _ = _numeric_evidence(subject, subject_field)
        comp_value, _ = _numeric_evidence(comp, comp_field)
        if subject_value is None or comp_value is None:
            return None, "unknown bathroom evidence", f"{subject_field}/{comp_field}"
        return subject_value - comp_value, f"{subject_field}/{comp_field}", f"subject.{subject_field}-comp.{comp_field}"
    if kind == "sqft":
        subject_field = rule.resolved_subject_field or "sqft"
        comp_field = rule.resolved_comp_field or "sqft"
        subject_value, _ = _numeric_evidence(subject, subject_field)
        comp_value, _ = _numeric_evidence(comp, comp_field)
        if subject_value is None or comp_value is None:
            return None, "unknown sqft evidence", f"{subject_field}/{comp_field}"
        return subject_value - comp_value, f"{subject_field}/{comp_field}", f"subject.{subject_field}-comp.{comp_field}"
    if kind in {"feature", "proximity"}:
        subject_field = rule.resolved_subject_field
        comp_field = rule.resolved_comp_field
        if not subject_field and not comp_field:
            return Decimal(0), "flat", "flat"
        subject_value, subject_note = _numeric_evidence(subject, subject_field) if subject_field else (Decimal(0), "")
        comp_value, comp_note = _numeric_evidence(comp, comp_field) if comp_field else (Decimal(0), "")
        if subject_value is None:
            return None, subject_note or "unknown subject evidence", f"{subject_field}/{comp_field}"
        if comp_value is None:
            return None, comp_note or "unknown comp evidence", f"{subject_field}/{comp_field}"
        return subject_value - comp_value, f"{subject_field}/{comp_field}", f"subject.{subject_field}-comp.{comp_field}"
    return None, f"unsupported per-unit kind {kind}", ""


def comp_difference(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str]:
    diff, label, _ = _typed_difference(rule, subject, comp)
    return diff, label


def signed_adjustment(
    rule: CompAdjustmentRuleV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
) -> tuple[Decimal | None, str, str, str]:
    if not rule.enabled:
        return Decimal(0), "disabled rule contributes zero", "0", "skipped_disabled"
    kind = rule.kind
    if kind in {"bedroom", "bathroom", "sqft", "feature", "proximity"}:
        diff, label, provenance = _typed_difference(rule, subject, comp)
        if diff is None:
            return None, label, "", "skipped_unknown_evidence"
        per_unit = rule.per_unit_amount if rule.per_unit_amount is not None else rule.signed_amount
        if per_unit is None:
            return None, "unknown per-unit amount", "", "skipped_unknown_amount"
        if kind in {"feature", "proximity"} and label == "flat":
            return rule.signed_amount, f"configured signed amount {rule.signed_amount}", "", "applied"
        if diff == 0:
            return Decimal(0), f"{kind} no difference ({label}; {provenance})", "0", "no_difference"
        return per_unit * diff, f"{kind} diff {diff} x {per_unit} ({label}; {provenance})", str(diff), "applied"
    if kind == "sale_age":
        return None, "sale_age adjustments require explicit evidence-driven policy", "", "skipped_no_policy"
    return None, f"unsupported adjustment kind {kind}", "", "skipped_unsupported"


def _record(
    ledger: list[AdjustmentLedgerEntryV4],
    stage: str,
    target_id: str,
    rule: CompAdjustmentRuleV4,
    amount: Decimal,
    evidence: str,
    input_value: str,
    duplicate_key: str,
) -> None:
    ledger.append(
        AdjustmentLedgerEntryV4(
            entry_id=f"{duplicate_key}:{len(ledger) + 1}",
            stage=stage,  # type: ignore[arg-type]
            target_id=target_id,
            rule_id=rule.rule_id,
            signed_amount=amount,
            unit=rule.unit,
            evidence=evidence,
            input_value=input_value or norm_text(rule.signed_amount),
            duplicate_key=duplicate_key,
        )
    )


def apply_comp_adjustments(
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
    rules: list[CompAdjustmentRuleV4],
    stage: str,
    seen_keys: set[str],
    ledger: list[AdjustmentLedgerEntryV4],
    limitations: list[str] | None = None,
    outcomes: list[AdjustmentOutcomeV4] | None = None,
) -> tuple[Decimal, list[str]]:
    if stage not in {"comp", "investor_comp"}:
        raise ValueError("apply_comp_adjustments handles comp stages only")
    total = Decimal(0)
    skipped: list[str] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.applies_to not in {"comp", "both"}:
            skipped.append(f"{rule.rule_id}: skipped (applies_to={rule.applies_to})")
            if outcomes is not None:
                outcomes.append(AdjustmentOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, stage=stage, outcome="skipped", reason=f"applies_to={rule.applies_to}"))
            continue
        key = f"{stage}:{comp.comp_id}:{rule.rule_id}"
        if key in seen_keys:
            skipped.append(f"{rule.rule_id}: duplicate application prevented")
            if outcomes is not None:
                outcomes.append(AdjustmentOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, stage=stage, outcome="skipped", reason="duplicate application prevented"))
            continue
        amount, evidence, input_value, status = signed_adjustment(rule, subject, comp)
        if amount is None:
            skipped.append(f"{rule.rule_id}: {evidence}")
            if limitations is not None:
                limitations.append(f"{comp.comp_id}:{rule.rule_id}: {evidence}")
            if outcomes is not None:
                outcomes.append(AdjustmentOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, stage=stage, outcome="skipped", reason=evidence))
            continue
        seen_keys.add(key)
        total += amount
        _record(ledger, stage, comp.comp_id, rule, amount, evidence, input_value, key)
        if outcomes is not None:
            outcomes.append(
                AdjustmentOutcomeV4(
                    rule_id=rule.rule_id, kind=rule.kind, stage=stage,
                    outcome="applied" if status == "applied" else "no_difference",
                    reason=evidence, signed_amount=amount,
                )
            )
    return total, skipped


def apply_subject_adjustments(
    subject: SubjectPropertyV4,
    rules: list[CompAdjustmentRuleV4],
    ledger: list[AdjustmentLedgerEntryV4],
    seen_keys: set[str] | None = None,
    limitations: list[str] | None = None,
    outcomes: list[AdjustmentOutcomeV4] | None = None,
    stage: str = "subject",
) -> tuple[Decimal, list[str]]:
    if stage not in {"subject", "investor_subject"}:
        raise ValueError("subject adjustments support subject stages only")
    owned = set() if seen_keys is None else seen_keys
    total = Decimal(0)
    skipped: list[str] = []
    for rule in rules:
        if not rule.enabled:
            continue
        if rule.applies_to not in {"subject", "both"}:
            continue
        key = f"{stage}:subject:{rule.rule_id}"
        if key in owned:
            skipped.append(f"{rule.rule_id}: duplicate subject application prevented")
            if outcomes is not None:
                outcomes.append(AdjustmentOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, stage=stage, outcome="skipped", reason="duplicate subject application prevented"))
            continue
        owned.add(key)
        total += rule.signed_amount
        _record(ledger, stage, "subject", rule, rule.signed_amount, f"subject adjustment {rule.rule_id}", format(rule.signed_amount, "f"), key)
        if outcomes is not None:
            outcomes.append(AdjustmentOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, stage=stage, outcome="applied", reason=f"subject adjustment {rule.rule_id}", signed_amount=rule.signed_amount))
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
