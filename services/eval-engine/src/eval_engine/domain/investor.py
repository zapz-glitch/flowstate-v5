"""Deterministic investor cohort, explicitly labeled ENGINEERING_PROPOSAL."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import InvestorCohortResultV4
from ..contracts.subject import SubjectPropertyV4
from .adjustments import apply_comp_adjustments, mean
from .evidence import norm_text
from .validation import validate_intrinsic

METHOD = "ENGINEERING_PROPOSAL_v4_robust_local_cohort_v1"
MIN_ELIGIBLE = 6
MIN_SELECTED = 4
MAX_IQR_MULT = Decimal("1.5")


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


def _ppsf(price: Decimal, sqft: Decimal | None) -> Decimal | None:
    if sqft is None or sqft <= 0:
        return None
    return price / sqft


def evaluate_investor_cohort(
    subject: SubjectPropertyV4,
    comps: list[CompCandidateV4],
    rules: list,
    evaluation_date: str,
) -> InvestorCohortResultV4:
    _ = evaluation_date
    valid, _ = validate_intrinsic(comps)
    eligible = [v.comp for v in valid if isinstance(v.comp.sqft, Decimal) and v.comp.sqft > 0]
    if len(eligible) < MIN_ELIGIBLE:
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(eligible),
            limitations=[f"eligible {len(eligible)} below minimum {MIN_ELIGIBLE}"],
        )
    raw = []
    for comp in eligible:
        ppsf = _ppsf(comp.verified_sale_price, comp.sqft)
        if ppsf is not None:
            raw.append((comp, ppsf))
    if len(raw) < MIN_ELIGIBLE:
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            limitations=["insufficient measurable PPSF evidence"],
        )
    values = [p for _, p in raw]
    q1, q3 = _quartiles(values)
    iqr = q3 - q1
    if iqr <= 0:
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            limitations=["unimodal or zero-spread sample"],
        )
    lower = q1 - MAX_IQR_MULT * iqr
    upper = q3 + MAX_IQR_MULT * iqr
    inliers = [(c, p) for c, p in raw if lower <= p <= upper]
    exclusions = [
        f"{c.comp_id}: outlier PPSF {p}" for c, p in raw if not (lower <= p <= upper)
    ]
    if len(inliers) < MIN_ELIGIBLE:
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions,
            limitations=["too few inliers after robust outlier exclusion"],
        )
    med = _median([p for _, p in inliers])
    spread = max(p for _, p in inliers) - min(p for _, p in inliers)
    if spread <= (q3 - q1) / Decimal(2):
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions,
            limitations=["unimodal sample without defensible lower cohort"],
        )
    cohort = [(c, p) for c, p in inliers if p <= med]
    if len(cohort) < MIN_SELECTED:
        return InvestorCohortResultV4(
            status="INSUFFICIENT_INVESTOR_DATA",
            eligible_count=len(raw),
            exclusions=exclusions + ["lower cohort below minimum size"],
            limitations=["no defensible lower-price cohort"],
        )
    seen: set[str] = set()
    adjusted: list[Decimal] = []
    selected_ids: list[str] = []
    ledger_note: list = []
    for comp, _ in sorted(cohort, key=lambda t: t[1]):
        total, _ = apply_comp_adjustments(
            subject, comp, rules, "investor_comp", seen, ledger_note
        )
        adjusted.append((comp.verified_sale_price + total) / comp.sqft)
        selected_ids.append(comp.comp_id)
    adj_mean = mean(adjusted)
    observed = [p for _, p in cohort]
    subject_value = adj_mean * subject.sqft if isinstance(subject.sqft, Decimal) else None
    if subject_value is not None:
        subj_total = Decimal(0)
        for rule in rules:
            if getattr(rule, "applies_to", "") == "subject" and getattr(rule, "enabled", False):
                subj_total += getattr(rule, "signed_amount", Decimal(0))
        subject_value += subj_total
    return InvestorCohortResultV4(
        method=METHOD,
        method_label="ENGINEERING_PROPOSAL",
        status="COHORT_FOUND",
        eligible_count=len(raw),
        selected_count=len(cohort),
        selected_comp_ids=sorted(selected_ids),
        exclusions=exclusions,
        observed_mean=mean(observed),
        observed_median=_median(observed),
        observed_min=min(observed),
        observed_max=max(observed),
        adjusted_mean_ppsf=adj_mean,
        subject_investor_value=subject_value,
        limitations=[f"method {METHOD} requires owner approval before production use"],
    )


__all__ = ["METHOD", "evaluate_investor_cohort"]
