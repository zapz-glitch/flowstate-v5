"""Deterministic investor cohort, labeled ENGINEERING_PROPOSAL.

Documented method v2: minimum 8 eligible PPSF observations, IQR outlier
exclusion, then a bimodality/separation gate. Smooth unimodal samples
decline with INSUFFICIENT_INVESTOR_DATA. The lower cluster becomes the
cohort only when the gap between sorted middle observations is material
relative to overall spread.
"""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import CompDecisionV4, InvestorCohortResultV4
from ..contracts.filters import AppraisalFilterV4, CompAdjustmentRuleV4, TransactionRuleV4
from ..contracts.subject import SubjectPropertyV4
from .adjustments import apply_comp_adjustments, mean
from .evidence import norm_lower, norm_text
from .selection import apply_filter
from .validation import validate_intrinsic

METHOD = "ENGINEERING_PROPOSAL_v4_separated_bimodal_cohort_v2"
MIN_ELIGIBLE = 8
MIN_SELECTED = 4
MAX_IQR_MULT = Decimal("1.5")
MIN_GAP_RATIO = Decimal("0.25")


def _median(values: list[Decimal]) -> Decimal:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / Decimal(2)


def _quartiles(values: list[Decimal]) -> tuple[Decimal, Decimal]:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 0:
        return _median(ordered[:mid]), _median(ordered[mid:])
    return _median(ordered[:mid]), _median(ordered[mid + 1 :])


def evaluate_investor_cohort(
    subject: SubjectPropertyV4,
    comps: list[CompCandidateV4],
    rules: list[CompAdjustmentRuleV4],
    evaluation_date: object,
    filters: list[AppraisalFilterV4] | None = None,
    transaction_rule: TransactionRuleV4 | None = None,
    decisions: list[CompDecisionV4] | None = None,
) -> InvestorCohortResultV4:
    valid, invalid = validate_intrinsic(comps, transaction_rule)
    invalid_ids = {item.comp.comp_id for item in invalid}
    eligible: list[CompCandidateV4] = []
    screened: list[str] = []
    for item in valid:
        comp = item.comp
        if not isinstance(comp.sqft, Decimal) or comp.sqft <= 0:
            screened.append(f"{comp.comp_id}: missing sqft for investor PPSF")
            continue
        if not isinstance(comp.verified_sale_price, Decimal) or comp.verified_sale_price <= 0:
            screened.append(f"{comp.comp_id}: missing price for investor PPSF")
            continue
        if filters:
            failures = [
                outcome for outcome in
                (apply_filter(rule, subject, comp, evaluation_date) for rule in filters)
                if not outcome.passed
            ]
            if failures:
                screened.append(f"{comp.comp_id}: property filter exclusion")
                continue
        eligible.append(comp)
    if len(eligible) < MIN_ELIGIBLE:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(eligible),
            exclusions=screened,
            limitations=[f"eligible {len(eligible)} below documented minimum {MIN_ELIGIBLE}"],
        )
    raw = sorted(
        ((comp, comp.verified_sale_price / comp.sqft) for comp in eligible),
        key=lambda pair: pair[1],
    )
    values = [p for _, p in raw]
    q1, q3 = _quartiles(values)
    iqr = q3 - q1
    if iqr <= 0:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=screened,
            limitations=["zero-spread sample cannot form a cohort"],
        )
    lower = q1 - MAX_IQR_MULT * iqr
    upper = q3 + MAX_IQR_MULT * iqr
    inliers = [(c, p) for c, p in raw if lower <= p <= upper]
    exclusions = list(screened)
    exclusions.extend(f"{c.comp_id}: outlier PPSF {p}" for c, p in raw if not (lower <= p <= upper))
    if len(inliers) < MIN_ELIGIBLE:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions,
            limitations=["too few inliers after outlier exclusion"],
        )
    ordered = sorted(inliers, key=lambda pair: pair[1])
    spread = ordered[-1][1] - ordered[0][1]
    if spread <= 0:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions,
            limitations=["no spread for separation test"],
        )
    gaps = [
        (ordered[i + 1][1] - ordered[i][1], i) for i in range(len(ordered) - 1)
    ]
    best_gap, best_index = max(gaps, key=lambda item: item[0])
    if best_gap < spread * MIN_GAP_RATIO:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions,
            limitations=[
                "smooth unimodal sample without material separation; no cohort forced"
            ],
        )
    lower_cluster = ordered[: best_index + 1]
    upper_cluster = ordered[best_index + 1 :]
    if len(lower_cluster) < MIN_SELECTED or not upper_cluster:
        _mark_decisions(decisions, eligible, [], invalid_ids)
        return InvestorCohortResultV4(
            minimum_sample=MIN_ELIGIBLE,
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions + ["lower cluster below minimum size"],
            limitations=["no defensible lower-price cohort"],
        )
    seen: set[str] = set()
    ledger_sink: list = []
    adjusted: list[Decimal] = []
    for comp, _ in lower_cluster:
        total, _ = apply_comp_adjustments(subject, comp, rules, "investor_comp", seen, ledger_sink)
        adjusted.append((comp.verified_sale_price + total) / comp.sqft)
    adj_mean = mean(adjusted)
    observed = [p for _, p in lower_cluster]
    subject_value = adj_mean * subject.sqft if isinstance(subject.sqft, Decimal) else None
    selected = [c.comp_id for c, _ in lower_cluster]
    _mark_decisions(decisions, eligible, selected, invalid_ids)
    return InvestorCohortResultV4(
        method=METHOD,
        method_label="ENGINEERING_PROPOSAL",
        status="COHORT_FOUND",
        minimum_sample=MIN_ELIGIBLE,
        separation_gap_ppsf=best_gap,
        eligible_count=len(raw),
        selected_count=len(lower_cluster),
        selected_comp_ids=sorted(selected),
        exclusions=exclusions,
        observed_mean=mean(observed),
        observed_median=_median(observed),
        observed_min=min(observed),
        observed_max=max(observed),
        adjusted_mean_ppsf=adj_mean,
        subject_investor_value=subject_value,
        buyer_label="inferred investor or as-is pricing",
        limitations=[f"method {METHOD} requires owner approval before production use"],
    )


def _mark_decisions(
    decisions: list[CompDecisionV4] | None,
    eligible: list[CompCandidateV4],
    selected: list[str],
    invalid_ids: set[str],
) -> None:
    if decisions is None:
        return
    eligible_ids = {c.comp_id for c in eligible}
    selected_ids = set(selected)
    for decision in decisions:
        if decision.comp_id in invalid_ids:
            decision.investor_status = "INSUFFICIENT_EVIDENCE"
        elif decision.comp_id in selected_ids:
            decision.investor_status = "ACCEPTED"
        elif decision.comp_id in eligible_ids:
            decision.investor_status = "REJECTED"
        else:
            decision.investor_status = "INSUFFICIENT_EVIDENCE"


__all__ = ["METHOD", "MIN_ELIGIBLE", "MIN_SELECTED", "evaluate_investor_cohort"]
