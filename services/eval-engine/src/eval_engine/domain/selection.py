"""Physical-priority reference selection with separate rule-match reporting."""

from __future__ import annotations

from decimal import Decimal
from statistics import median

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import CompDecisionV4, RuleOutcomeV4
from ..contracts.filters import AppraisalFilterV4, TransactionRuleV4
from ..contracts.subject import SubjectPropertyV4
from .evidence import norm_lower, norm_text, sale_age_days
from .validation import ValidatedComp, sort_for_arv, sort_key, validate_intrinsic


def property_type_key(value: str) -> str:
    key = "".join(character for character in value.casefold() if character.isalnum())
    if key in {"", "unknown", "na", "notavailable", "none", "null", "residential", "other"}:
        return ""
    if key in {"sfr", "singlefamily", "singlefamilyresidential", "singlefamilyresidence", "residentialsinglefamily", "singlefamilydetached"}:
        return "singlefamily"
    return key


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
    if kind == "building_style_match":
        want = " ".join(subject.building_style.casefold().split())
        got = " ".join(comp.building_style.casefold().split())
        unknown = {"", "unknown", "n/a", "na", "not available", "not applicable", "none", "null", "-"}
        if want in unknown:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown subject building style", limitation="unknown subject building style")
        if got in unknown:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: unknown comp building style", limitation="unknown comp building style")
        if got != want:
            return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=False, reason=f"{rule.rule_id}: building style {comp.building_style} != {subject.building_style}")
        return RuleOutcomeV4(rule_id=rule.rule_id, kind=kind, passed=True, reason="building style matches subject")
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


def similarity_priority(subject: SubjectPropertyV4, comp: CompCandidateV4) -> tuple[tuple, list[str]]:
    unknown = {"", "unknown", "n/a", "na", "not available", "not applicable", "none", "null", "-"}

    def text_priority(left: str, right: str) -> tuple[int, str]:
        want, got = " ".join(left.casefold().split()), " ".join(right.casefold().split())
        if want in unknown or got in unknown:
            return 2, "unknown"
        return (0, "match") if want == got else (1, "mismatch")

    def difference(left: object, right: object, relative: bool = False) -> Decimal:
        if left is None or right is None:
            return Decimal("Infinity")
        left_value, right_value = Decimal(left), Decimal(right)
        if left_value <= 0 or right_value <= 0:
            return Decimal("Infinity")
        return abs(left_value - right_value) / left_value if relative else abs(left_value - right_value)

    subdivision, subdivision_note = text_priority(subject.subdivision, comp.subdivision)
    year = difference(subject.year_built, comp.year_built)
    sqft = difference(subject.sqft, comp.sqft, True)
    lot = difference(subject.lot_sqft, comp.lot_sqft, True)
    style, style_note = text_priority(subject.building_style, comp.building_style)
    details = [f"subdivision: {subdivision_note}"]
    for label, value in [("year-built difference", year), ("relative sqft difference", sqft), ("relative lot-area difference", lot)]:
        details.append(f"{label}: {format(value, 'f') if value.is_finite() else 'unknown'}")
    details.append(f"physical style: {style_note}")
    return (subdivision, year, sqft, lot, style), details


def select_arv_comps(
    subject: SubjectPropertyV4,
    comps: list[CompCandidateV4],
    filters: list[AppraisalFilterV4],
    evaluation_date: object,
    transaction_rule: TransactionRuleV4 | None = None,
    selected_comp_ids: list[str] | None = None,
    selection_policy: str = "legacy_physical_v1",
) -> tuple[list[ValidatedComp], list[CompDecisionV4], list[ValidatedComp]]:
    provider_authoritative = selection_policy == "provider_authoritative_upper_half_v2"
    experimental = selection_policy in {"upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"}
    valid, invalid = validate_intrinsic(comps, transaction_rule)
    decisions: list[CompDecisionV4] = []
    candidates: list[tuple[ValidatedComp, CompDecisionV4, tuple]] = []
    enabled = [rule for rule in filters if rule.enabled]
    invalid_objects = {id(item) for item in invalid}
    for item in [*invalid, *sort_for_arv(valid)]:
        outcomes = [apply_filter(rule, subject, item.comp, evaluation_date) for rule in enabled]
        if experimental and not any(rule.kind == "property_type_match" for rule in enabled):
            want, got = property_type_key(subject.property_type), property_type_key(item.comp.property_type)
            if want:
                outcomes.append(RuleOutcomeV4(
                    rule_id="property_type_match", kind="property_type_match",
                    passed=bool(got) and want == got,
                    reason="property type matches" if want == got else ("unknown comparable property type" if not got else f"property type mismatch: {item.comp.property_type} != {subject.property_type}"),
                    limitation="unknown comparable property type" if not got else "",
                ))
        if experimental and not provider_authoritative and subject.garage_spaces is not None:
            garage = item.comp.garage_spaces
            outcomes.append(RuleOutcomeV4(
                rule_id="garage_capacity_match", kind="garage_capacity_match",
                passed=garage == subject.garage_spaces,
                reason="garage capacity matches" if garage == subject.garage_spaces else ("unknown comparable garage capacity" if garage is None else "garage capacity differs from subject"),
                limitation="unknown comparable garage capacity" if garage is None else "",
            ))
        matched = sum(outcome.passed for outcome in outcomes)
        total_checks = len(outcomes)
        score = Decimal(matched) * Decimal(100) / Decimal(total_checks) if total_checks else None
        visual = item.comp.physical_similarity if experimental and not provider_authoritative else None
        if visual is not None:
            outcomes.append(RuleOutcomeV4(
                rule_id="physical_similarity", kind="physical_similarity",
                passed=visual.status == "match" and visual.confidence == "high",
                reason=f"visual physical comparison: {visual.status}, {visual.confidence} confidence; {visual.reason}",
                limitation="visual physical comparison uncertain" if visual.status == "unknown" or visual.confidence != "high" else "",
            ))
        mismatches = [o.reason for o in outcomes if not o.passed]
        hard_failures = list(item.reasons)
        if not isinstance(item.comp.sqft, Decimal) or item.comp.sqft <= 0:
            hard_failures.append("missing or non-positive comp sqft for ARV math")
        if item.comp.is_sale is not True:
            hard_failures.append("verified sale flag required")
        age = sale_age_days(item.comp.sale_date, evaluation_date)
        if age is None or age < 0:
            hard_failures.append("missing or future verified sale date")
        priority, ranking_details = similarity_priority(subject, item.comp)
        decision = CompDecisionV4(
            comp_id=item.comp.comp_id, evidence_ref=item.comp.evidence_ref,
            arv_status="REJECTED",
            rule_outcomes=([item.tx_outcome] if item.tx_outcome is not None else []) + outcomes,
            rejection_reasons=hard_failures,
            limitations=[o.limitation for o in outcomes if o.limitation],
            duplicate_of=item.duplicate_of,
            match_percent=score, matched_rule_count=matched, total_rule_count=total_checks,
            mismatch_reasons=mismatches,
            ranking_details=ranking_details,
            selection_reason="Excluded: invalid sale evidence" if hard_failures or id(item) in invalid_objects else "",
        )
        decisions.append(decision)
        if not hard_failures and id(item) not in invalid_objects:
            candidates.append((item, decision, priority))
    upper_ids: set[str] = set()
    if experimental:
        qualified = []
        for entry in candidates:
            item, decision, _priority = entry
            visual = item.comp.physical_similarity if not provider_authoritative else None
            visual_match = visual is not None and visual.status == "match" and visual.confidence == "high"
            failures = [o for o in decision.rule_outcomes if not o.passed
                and o.kind not in {"garage_capacity_match", "physical_similarity"}
                and not (o.kind == "property_type_match" and o.limitation.startswith("unknown"))
                and not (o.kind == "building_style_match" and (o.limitation.startswith("unknown") or visual_match))]
            if visual is not None and visual.status == "mismatch" and visual.confidence == "high":
                failures.extend(o for o in decision.rule_outcomes if o.kind == "physical_similarity")
            if failures:
                decision.arv_cohort = "not_qualified"
                decision.selection_reason = "Not ARV-qualified: " + "; ".join(o.reason for o in failures)
            else:
                qualified.append(entry)
        if len(qualified) >= 4:
            median_ppsf = median([entry[0].comp.verified_sale_price / entry[0].comp.sqft for entry in qualified])
            screened = []
            for entry in qualified:
                item, decision, _priority = entry
                if item.comp.verified_sale_price / item.comp.sqft > median_ppsf * 3:
                    decision.arv_cohort = "price_review"
                    decision.selection_reason = "Price requires review: sale PPSF exceeds 3 times the qualified cohort median; excluded from automatic ARV"
                    decision.limitations.append(decision.selection_reason)
                else:
                    screened.append(entry)
            qualified = screened
        qualified.sort(key=lambda entry: sort_key(entry[0].comp))
        if qualified:
            cutoff = qualified[(len(qualified) - 1) // 2][0].comp.verified_sale_price
            for item, decision, _priority in qualified:
                if item.comp.verified_sale_price >= cutoff:
                    upper_ids.add(item.comp.comp_id)
                    decision.arv_cohort = "upper_half"
                else:
                    decision.arv_cohort = "lower_half"
                    decision.selection_reason = "Excluded from automatic ARV: lower-priced half of qualified sales; not verified as-is condition"
        candidates.sort(key=lambda entry: (
            {"upper_half": 0, "lower_half": 1}.get(entry[1].arv_cohort, 2),
            sale_age_days(entry[0].comp.sale_date, evaluation_date) if entry[1].arv_cohort == "upper_half" else 0,
            sort_key(entry[0].comp),
        ))
    else:
        candidates.sort(key=lambda entry: (entry[2], sort_key(entry[0].comp)))
    manual = set(selected_comp_ids) if selected_comp_ids is not None else None
    if manual is not None:
        eligible_ids = {entry[0].comp.comp_id for entry in candidates}
        if not manual or len(manual) != len(selected_comp_ids) or not manual.issubset(eligible_ids):
            raise ValueError("manual selection contains empty, duplicate, unknown, or ineligible comparable IDs")
    accepted: list[ValidatedComp] = []
    for rank, (item, decision, _priority) in enumerate(candidates, start=1):
        decision.priority_rank = rank
        selected = item.comp.comp_id in manual if manual is not None else (item.comp.comp_id in upper_ids if experimental else rank == 1)
        if selected:
            accepted.append(item)
            decision.arv_status = "ACCEPTED"
            decision.selection_reason = "Selected explicitly by operator; verified sale gates retained; preliminary" if manual is not None else (
                "Selected in the upper-priced half of qualified sales, including cutoff ties; experimental ARV reference, not verified condition"
                if experimental else "Selected closest physical reference: subdivision, year built, sqft, lot area, physical style; preliminary"
            )
        else:
            decision.selection_reason = "Not selected by operator" if manual is not None else (decision.selection_reason or f"Not selected: physical similarity priority rank {rank}")
            decision.rejection_reasons = [decision.selection_reason]
    decisions.sort(key=lambda d: norm_text(d.comp_id).lower())
    return accepted, decisions, [entry[0] for entry in candidates]


__all__ = ["apply_filter", "select_arv_comps"]
