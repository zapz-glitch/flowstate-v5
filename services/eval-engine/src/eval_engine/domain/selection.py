"""Deterministic first-three ARV comparable selection."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import CompDecisionV4
from ..contracts.filters import AppraisalFilterV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_lower, norm_text, sale_age_days
from .validation import ValidatedComp, sort_for_arv, validate_intrinsic


def _subject_sqft(subject: SubjectPropertyV4) -> Decimal | None:
    return subject.sqft if isinstance(subject.sqft, Decimal) else None


def apply_filter(
    rule: AppraisalFilterV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
    evaluation_date: str,
) -> tuple[bool, str | None, str | None]:
    if not rule.enabled:
        return True, None, None
    kind = rule.kind
    if kind == "max_sale_age_days":
        if rule.value is None:
            return False, f"{rule.rule_id}: unknown sale-age threshold", None
        age = sale_age_days(comp.sale_date, evaluation_date)
        if age is None:
            return False, f"{rule.rule_id}: unknown sale date", "unknown sale date"
        if age < 0:
            return False, f"{rule.rule_id}: future sale date", None
        if Decimal(age) > rule.value:
            return False, f"{rule.rule_id}: sale age {age}d exceeds {rule.value}d", None
        return True, None, None
    if kind == "max_sqft_diff":
        if rule.value is None:
            return False, f"{rule.rule_id}: unknown sqft threshold", None
        if not isinstance(subject.sqft, Decimal) or not isinstance(comp.sqft, Decimal):
            return False, f"{rule.rule_id}: unknown sqft evidence", "unknown sqft"
        if abs(comp.sqft - subject.sqft) > rule.value:
            return (
                False,
                f"{rule.rule_id}: sqft difference {abs(comp.sqft - subject.sqft)} exceeds {rule.value}",
                None,
            )
        return True, None, None
    if kind == "max_year_built_diff":
        if rule.value is None:
            return False, f"{rule.rule_id}: unknown year-built threshold", None
        if subject.year_built is None or comp.year_built is None:
            return False, f"{rule.rule_id}: unknown year built", "unknown year built"
        if abs(Decimal(comp.year_built - subject.year_built)) > rule.value:
            return False, f"{rule.rule_id}: year-built difference exceeds {rule.value}", None
        return True, None, None
    if kind == "max_distance_miles":
        if rule.value is None:
            return False, f"{rule.rule_id}: unknown distance threshold", None
        if not isinstance(comp.distance_miles, Decimal):
            return False, f"{rule.rule_id}: unknown distance", "unknown distance"
        if comp.distance_miles > rule.value:
            return False, f"{rule.rule_id}: distance {comp.distance_miles} exceeds {rule.value}", None
        return True, None, None
    if kind == "property_type_match":
        want = norm_lower(rule.text_value or subject.property_type)
        got = norm_lower(comp.property_type)
        if not want:
            return False, f"{rule.rule_id}: unknown required property type", None
        if not got:
            return False, f"{rule.rule_id}: unknown comp property type", "unknown property type"
        if got != want:
            return False, f"{rule.rule_id}: property type {comp.property_type} != {want}", None
        return True, None, None
    if kind == "subdivision_match":
        want = norm_lower(subject.subdivision)
        got = norm_lower(comp.subdivision)
        if not want:
            return False, f"{rule.rule_id}: unknown subject subdivision", None
        if not got:
            return False, f"{rule.rule_id}: unknown comp subdivision", "unknown subdivision"
        if got != want:
            return False, f"{rule.rule_id}: subdivision mismatch", None
        return True, None, None
    return False, f"{rule.rule_id}: unsupported filter kind {kind}", None


def select_arv_comps(
    subject: SubjectPropertyV4,
    comps: list[CompCandidateV4],
    filters: list[AppraisalFilterV4],
    evaluation_date: str,
) -> tuple[list[ValidatedComp], list[CompDecisionV4], list[ValidatedComp]]:
    valid, invalid = validate_intrinsic(comps)
    ordered = sort_for_arv(valid)
    decisions: list[CompDecisionV4] = []
    for item in invalid:
        decisions.append(
            CompDecisionV4(
                comp_id=item.comp.comp_id,
                evidence_ref=item.comp.evidence_ref,
                arv_status="REJECTED",
                rejection_reasons=list(item.reasons),
            )
        )
    accepted: list[ValidatedComp] = []
    examined = 0
    stop_after = 3
    decided_ids = {d.comp_id for d in decisions}
    for item in ordered:
        if len(accepted) >= stop_after:
            decisions.append(
                CompDecisionV4(
                    comp_id=item.comp.comp_id,
                    evidence_ref=item.comp.evidence_ref,
                    arv_status="NOT_EXAMINED_FOR_ARV",
                )
            )
            continue
        examined += 1
        reasons: list[str] = []
        limitations: list[str] = []
        for rule in filters:
            passed, reason, limitation = apply_filter(
                rule, subject, item.comp, evaluation_date
            )
            if not passed and reason:
                reasons.append(reason)
            if limitation:
                limitations.append(limitation)
        if reasons:
            decisions.append(
                CompDecisionV4(
                    comp_id=item.comp.comp_id,
                    evidence_ref=item.comp.evidence_ref,
                    arv_status="REJECTED",
                    rejection_reasons=reasons,
                    limitations=limitations,
                )
            )
            decided_ids.add(item.comp.comp_id)
            continue
        accepted.append(item)
        decisions.append(
            CompDecisionV4(
                comp_id=item.comp.comp_id,
                evidence_ref=item.comp.evidence_ref,
                arv_status="ACCEPTED",
                limitations=limitations,
            )
        )
        decided_ids.add(item.comp.comp_id)
        if len(accepted) >= stop_after:
            continue
    _ = examined
    _ = _subject_sqft(subject)
    order = {c.comp_id: i for i, c in enumerate(comps)}
    decisions.sort(key=lambda d: order.get(d.comp_id, 10**9))
    return accepted, decisions, ordered


__all__ = ["apply_filter", "select_arv_comps"]
