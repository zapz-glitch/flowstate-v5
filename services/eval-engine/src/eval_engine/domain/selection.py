"""Deterministic first-three ARV comparable selection."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import CompDecisionV4, RuleOutcomeV4
from ..contracts.filters import AppraisalFilterV4, TransactionRuleV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_lower, norm_text, sale_age_days
from .validation import ValidatedComp, sort_for_arv, validate_intrinsic


def apply_filter(
    rule: AppraisalFilterV4,
    subject: SubjectPropertyV4,
    comp: CompCandidateV4,
    evaluation_date: object,
) -> RuleOutcomeV4:
    if not rule.enabled:
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=rule.kind, passed=True, reason="disabled")
    kind = rule.kind
    if kind == "max_sale_age_days":
        if rule.value is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown sale-age threshold")
        age = sale_age_days(comp.sale_date, evaluation_date)
        if age is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown sale date", limitation="unknown sale date")
        if age < 0:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: future sale date")
        if Decimal(age) > rule.value:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: sale age {age}d exceeds {rule.value}d")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="within sale-age threshold")
    if kind == "max_sqft_diff":
        if rule.value is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown sqft threshold")
        if not isinstance(subject.sqft, Decimal) or not isinstance(comp.sqft, Decimal):
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown sqft evidence", limitation="unknown sqft")
        diff = abs(comp.sqft - subject.sqft)
        if diff > rule.value:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: sqft difference {diff} exceeds {rule.value}")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="within sqft threshold")
    if kind == "max_year_built_diff":
        if rule.value is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown year-built threshold")
        if subject.year_built is None or comp.year_built is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown year built", limitation="unknown year built")
        if abs(Decimal(comp.year_built - subject.year_built)) > rule.value:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: year-built difference exceeds {rule.value}")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="within year-built threshold")
    if kind == "max_distance_miles":
        if rule.value is None:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown distance threshold")
        if not isinstance(comp.distance_miles, Decimal):
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown distance", limitation="unknown distance")
        if comp.distance_miles > rule.value:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: distance {comp.distance_miles} exceeds {rule.value}")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="within distance threshold")
    if kind == "property_type_match":
        want = norm_lower(rule.text_value or subject.property_type)
        got = norm_lower(comp.property_type)
        if not want:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown required property type")
        if not got:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown comp property type", limitation="unknown property type")
        if got != want:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: property type {comp.property_type} != {want}")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="property type matches")
    if kind == "subdivision_match":
        want = norm_lower(subject.subdivision)
        got = norm_lower(comp.subdivision)
        if not want:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown subject subdivision")
        if not got:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown comp subdivision", limitation="unknown subdivision")
        if got != want:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: subdivision mismatch")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="subdivision matches")
    return RuleOutcomeV4(rule_id=rule.rule_id, kind=str(kind), passed=False, reason=f"{rule.rule_id}: unsupported filter kind {kind}")


def select_arv_comps(
    subject: SubjectPropertyV4,
    comps: list[CompCandidateV4],
    filters: list[AppraisalFilterV4],
    evaluation_date: object,
    transaction_rule: TransactionRuleV4 | None = None,
) -> tuple[list[ValidatedComp], list[CompDecisionV4], list[ValidatedComp]]:
    valid, invalid = validate_intrinsic(comps, transaction_rule)
    ordered = sort_for_arv(valid)
    decisions: list[CompDecisionV4] = []
    for item in invalid:
        outcomes = [item.tx_outcome] if item.tx_outcome is not None else []
        decisions.append(
            CompDecisionV4(
                comp_id=item.comp.comp_id,
                evidence_ref=item.comp.evidence_ref,
                arv_status="REJECTED",
                rule_outcomes=[o for o in outcomes if o is not None],
                rejection_reasons=list(item.reasons),
                duplicate_of=item.duplicate_of,
            )
        )
    accepted: list[ValidatedComp] = []
    stop_after = 3
    for item in ordered:
        if len(accepted) >= stop_after:
            tx_outcomes = [item.tx_outcome] if item.tx_outcome is not None else []
            decisions.append(
                CompDecisionV4(
                    comp_id=item.comp.comp_id,
                    evidence_ref=item.comp.evidence_ref,
                    arv_status="NOT_EXAMINED_FOR_ARV",
                    rule_outcomes=[o for o in tx_outcomes if o is not None],
                    duplicate_of=item.duplicate_of,
                )
            )
            continue
        outcomes = [apply_filter(rule, subject, item.comp, evaluation_date) for rule in filters]
        if item.tx_outcome is not None:
            outcomes = [item.tx_outcome, *outcomes]
        failures = [o for o in outcomes if not o.passed]
        limitations = [o.limitation for o in outcomes if o.limitation]
        if not isinstance(item.comp.verified_sale_price, Decimal):
            failures.append(
                RuleOutcomeV4(
                    rule_id="calculability",
                    kind="calculability",
                    passed=False,
                    reason="missing verified sale price for ARV math",
                    limitation="unknown sale price",
                )
            )
        if not isinstance(item.comp.sqft, Decimal) or item.comp.sqft <= 0:
            failures.append(
                RuleOutcomeV4(
                    rule_id="calculability",
                    kind="calculability",
                    passed=False,
                    reason="missing comp sqft for ARV math",
                    limitation="unknown sqft",
                )
            )
            limitations.append("unknown sqft")
        if failures:
            decisions.append(
                CompDecisionV4(
                    comp_id=item.comp.comp_id,
                    evidence_ref=item.comp.evidence_ref,
                    arv_status="REJECTED",
                    rule_outcomes=outcomes,
                    rejection_reasons=[o.reason for o in failures if o.reason],
                    limitations=limitations,
                    duplicate_of=item.duplicate_of,
                )
            )
            continue
        accepted.append(item)
        decisions.append(
            CompDecisionV4(
                comp_id=item.comp.comp_id,
                evidence_ref=item.comp.evidence_ref,
                arv_status="ACCEPTED",
                rule_outcomes=outcomes,
                limitations=limitations,
                duplicate_of=item.duplicate_of,
            )
        )
    decisions.sort(key=lambda d: norm_text(d.comp_id).lower())
    return accepted, decisions, ordered


__all__ = ["apply_filter", "select_arv_comps"]
