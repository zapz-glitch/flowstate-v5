"""Deterministic V4 evaluation orchestration."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

from ..contracts.deal import (
    AdjustmentLedgerEntryV4,
    AdjustmentOutcomeV4,
    ArvResultV4,
    DealResultV4,
    EvalErrorV4,
    EvaluationRequestV4,
    EvaluationResultV4,
    InvestorCohortResultV4,
    RenovationResultV4,
)
from .adjustments import adjusted_ppsf, apply_comp_adjustments, apply_subject_adjustments, mean
from .deal import evaluate_deal, round_display
from .evidence import sale_age_days
from .investor import evaluate_investor_cohort
from .renovation import evaluate_major_items, find_cell, map_tier, validate_tiers
from .selection import select_arv_comps
from .stage_selection import select_staged_arv_comps


def _result(
    request: EvaluationRequestV4,
    snapshot_id: str,
    snapshot_hash: str,
    status: str,
    decisions: list,
    ledger: list[AdjustmentLedgerEntryV4],
    errors: list[EvalErrorV4] | None = None,
    incomplete: list[str] | None = None,
    arv: ArvResultV4 | None = None,
    renovation: RenovationResultV4 | None = None,
    deal: DealResultV4 | None = None,
    investor: InvestorCohortResultV4 | None = None,
) -> EvaluationResultV4:
    return EvaluationResultV4(
        status=status,  # type: ignore[arg-type]
        settings_snapshot_id=snapshot_id,
        settings_content_hash=snapshot_hash,
        decisions=decisions,
        ledger=ledger,
        errors=errors or [],
        incomplete_sections=incomplete or [],
        arv=arv,
        renovation=renovation,
        deal=deal,
        investor=investor,
    )


def evaluate_v4(request: EvaluationRequestV4) -> EvaluationResultV4:
    subject = request.subject
    try:
        settings = request.settings.validated_for_durable_use()
    except ValueError as exc:
        return EvaluationResultV4(
            status="FAILED",  # type: ignore[arg-type]
            settings_snapshot_id=request.settings.snapshot_id,
            settings_content_hash=request.settings.content_hash,
            decisions=[],
            ledger=[],
            errors=[EvalErrorV4(code="INVALID_SNAPSHOT", section="settings", message=str(exc))],
            incomplete_sections=["arv", "renovation", "deal", "investor"],
            arv=ArvResultV4(status="FAILED", limitations=[str(exc)]),
        )
    snapshot_id = settings.snapshot_id
    snapshot_hash = settings.content_hash or settings.compute_content_hash()
    tier_errors = validate_tiers(settings.tiers)
    stage_trace = []
    selected_stage = None
    if settings.arv_selection_policy == "provider_authoritative_upper_half_v2":
        accepted, decisions, _, stage_trace, selected_stage = select_staged_arv_comps(
            subject, request.comps, settings.filters, request.evaluation_date, settings.transaction_rule,
            request.selected_comp_ids,
        )
    else:
        accepted, decisions, _ = select_arv_comps(
            subject, request.comps, settings.filters, request.evaluation_date, settings.transaction_rule,
            request.selected_comp_ids,
            settings.arv_selection_policy,
        )
    experimental = settings.arv_selection_policy in {"upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"}
    cohort_ids = {d.comp_id for d in decisions if d.arv_cohort in {"upper_half", "lower_half"}}
    upper_ids = {d.comp_id for d in decisions if d.arv_cohort == "upper_half"}
    upper_prices = [c.verified_sale_price for c in request.comps if c.comp_id in upper_ids]
    selection_metadata = {
        "selection_policy": settings.arv_selection_policy,
        "qualified_comp_count": len(cohort_ids) if experimental else None,
        "upper_half_cutoff_price": min(upper_prices) if upper_prices else None,
        "stage_trace": stage_trace,
        "selected_stage": selected_stage if accepted else None,
    }
    adjustment_outcomes: list[AdjustmentOutcomeV4] = []
    ledger: list[AdjustmentLedgerEntryV4] = []
    seen: set[str] = set()
    investor_subject_seen: set[str] = set()
    if tier_errors:
        return _result(
            request, snapshot_id, snapshot_hash, "FAILED", decisions, ledger,
            errors=[EvalErrorV4(code="INVALID_TIERS", section="renovation", message="; ".join(tier_errors))],
            incomplete=["renovation", "deal"],
            arv=ArvResultV4(status="FAILED", limitations=tier_errors),
            investor=InvestorCohortResultV4(status="INSUFFICIENT_INVESTOR_DATA", limitations=tier_errors),
        )
    if not accepted:
        investor = evaluate_investor_cohort(
            subject, request.comps, settings.adjustments, request.evaluation_date,
            settings.filters, settings.transaction_rule, decisions, ledger,
            investor_subject_seen, adjustment_outcomes,
        )
        preserved = [a.comp.comp_id for a in accepted]
        return _result(
            request, snapshot_id, snapshot_hash, "INSUFFICIENT_COMPS", decisions, ledger,
            incomplete=["arv", "renovation", "deal"],
            arv=ArvResultV4(
                status="INSUFFICIENT_DATA", accepted_comp_ids=preserved,
                limitations=["no accepted verified comps"],
                **selection_metadata,
            ),
            investor=investor,
        )
    ppsfs: list[Decimal] = []
    skipped_notes: list[str] = []
    calc_limitations: list[str] = []
    usable: list = []
    for item in accepted:
        if not isinstance(item.comp.verified_sale_price, Decimal):
            decisions_by_id = {d.comp_id: d for d in decisions}
            bad = decisions_by_id.get(item.comp.comp_id)
            if bad is not None:
                bad.arv_status = "REJECTED"
                bad.rejection_reasons.append("missing verified sale price for ARV math")
            continue
        if not isinstance(item.comp.sqft, Decimal) or item.comp.sqft <= 0:
            decisions_by_id = {d.comp_id: d for d in decisions}
            bad = decisions_by_id.get(item.comp.comp_id)
            if bad is not None:
                bad.arv_status = "REJECTED"
                bad.rejection_reasons.append("missing comp sqft for ARV math")
            continue
        usable.append(item)
    if not usable:
        investor = evaluate_investor_cohort(
            subject, request.comps, settings.adjustments, request.evaluation_date,
            settings.filters, settings.transaction_rule, decisions, ledger,
            investor_subject_seen, adjustment_outcomes,
        )
        preserved = [a.comp.comp_id for a in usable]
        return _result(
            request, snapshot_id, snapshot_hash, "INSUFFICIENT_COMPS", decisions, ledger,
            incomplete=["arv", "renovation", "deal"],
            arv=ArvResultV4(
                status="INSUFFICIENT_DATA", accepted_comp_ids=preserved,
                limitations=["no calculable verified comps"],
                **selection_metadata,
            ),
            investor=investor,
        )
    for item in usable:
        total, skipped = apply_comp_adjustments(
            subject, item.comp, settings.adjustments, "comp", seen, ledger,
            calc_limitations, adjustment_outcomes,
        )
        skipped_notes.extend(skipped)
        price = item.comp.verified_sale_price + total
        value = adjusted_ppsf(price, item.comp.sqft)
        if value is None:
            return _result(
                request, snapshot_id, snapshot_hash, "FAILED", decisions, ledger,
                errors=[EvalErrorV4(code="MISSING_SQFT", section="arv", message=item.comp.comp_id)],
                arv=ArvResultV4(status="FAILED"),
            )
        ppsfs.append(value)
    comp_weights: dict[str, Decimal] = {}
    if experimental:
        by_id = {decision.comp_id: decision for decision in decisions}
        raw_weights = []
        for item in usable:
            decision = by_id[item.comp.comp_id]
            decision.rule_weight = max(decision.match_percent or Decimal(0), Decimal(1)) / Decimal(100)
            age = sale_age_days(item.comp.sale_date, request.evaluation_date)
            decision.recency_weight = Decimal(180) / (Decimal(180) + Decimal(age))
            raw_weights.append(Fraction(decision.rule_weight) * Fraction(180, 180 + age))
        weight_total = sum(raw_weights, Fraction(0))
        weighted_ppsf = sum((Fraction(value) * weight for value, weight in zip(ppsfs, raw_weights)), Fraction(0)) / weight_total
        avg_ppsf = Decimal(weighted_ppsf.numerator) / Decimal(weighted_ppsf.denominator)
        for item, weight in zip(usable, raw_weights):
            fraction = weight / weight_total
            normalized = Decimal(fraction.numerator) / Decimal(fraction.denominator)
            comp_weights[item.comp.comp_id] = normalized
            by_id[item.comp.comp_id].arv_weight = normalized
    else:
        avg_ppsf = mean(ppsfs)
    if not isinstance(subject.sqft, Decimal) or subject.sqft <= 0:
        return _result(
            request, snapshot_id, snapshot_hash, "FAILED", decisions, ledger,
            errors=[EvalErrorV4(code="MISSING_SUBJECT_SQFT", section="arv", message="subject sqft required")],
            arv=ArvResultV4(status="FAILED"),
        )
    base_arv = avg_ppsf * subject.sqft
    subj_total, _ = apply_subject_adjustments(
        subject, settings.adjustments, ledger, seen, calc_limitations, adjustment_outcomes, stage="subject",
    )
    missing_evidence = [
        o for o in adjustment_outcomes
        if o.outcome == "skipped" and o.reason.startswith("SKIPPED_UNKNOWN_EVIDENCE")
    ]
    no_policy = [
        o for o in adjustment_outcomes
        if o.outcome == "skipped" and o.reason.startswith("SKIPPED_NO_POLICY")
    ]
    for outcome in no_policy:
        calc_limitations.append(f"{outcome.rule_id}: investor limitation; no policy adjustment")
    final_arv = base_arv + subj_total
    displayed_arv = round_display(final_arv, settings.deal.rounding_increment, settings.deal.rounding_mode)
    arv_status = "COMPLETED"
    status = "COMPLETED"
    if experimental:
        arv_status = "PRELIMINARY"
        status = "REVIEW_REQUIRED"
        calc_limitations.append("experimental upper-half sale-price classification; adjusted PPSF weighted by rule match times 180/(180+sale age in days); price is not verified condition")
        if any(d.arv_cohort == "price_review" for d in decisions):
            calc_limitations.append("one or more sale prices require review and were excluded from automatic ARV")
    if request.selected_comp_ids is not None:
        arv_status = "PRELIMINARY"
        status = "REVIEW_REQUIRED"
        calc_limitations.append("operator-selected ARV comparables; " + ("rule-match-weighted" if experimental else "arithmetic mean of") + " adjusted PPSF; review required")
    selected_ids = {item.comp.comp_id for item in usable}
    selected_decisions = [d for d in decisions if d.comp_id in selected_ids]
    if any(d.match_percent is None or d.match_percent < 100 for d in selected_decisions):
        arv_status = "PRELIMINARY"
        status = "REVIEW_REQUIRED"
        calc_limitations.append("selected physical reference has a rule match below 100% or is unscored; review subject-rule mismatches")
        for decision in selected_decisions:
            calc_limitations.extend(f"{decision.comp_id}: {reason}" for reason in decision.mismatch_reasons)
    if len(usable) < 3:
        arv_status = "PRELIMINARY"
        status = "REVIEW_REQUIRED"
        calc_limitations.append(
            f"limited comparable evidence: {len(usable)} qualifying verified comp(s); valuation is preliminary"
        )
    if missing_evidence:
        arv_status = "PRELIMINARY"
        status = "REVIEW_REQUIRED"
        calc_limitations.append("absent enabled adjustment evidence; ARV preliminary")
    arv = ArvResultV4(
        status=arv_status,  # type: ignore[arg-type]
        accepted_comp_ids=[a.comp.comp_id for a in usable],
        average_adjusted_ppsf=avg_ppsf,
        base_arv=base_arv,
        subject_adjustment_total=subj_total,
        final_arv=final_arv,
        displayed_arv=displayed_arv,
        display_rounding_difference=displayed_arv - final_arv,
        exact_value=format(final_arv, "f"),
        limitations=list(calc_limitations),
        skipped_adjustments=list(skipped_notes),
        adjustment_outcomes=list(adjustment_outcomes),
        comp_weights=comp_weights,
        **selection_metadata,
    )
    tier = map_tier(final_arv, settings.tiers)
    renovation: RenovationResultV4 | None = None
    deal_result: DealResultV4 | None = None
    incomplete: list[str] = []
    if status == "REVIEW_REQUIRED":
        incomplete.append("arv")
    if tier is None:
        status = "REVIEW_REQUIRED"
        incomplete.extend(["renovation", "deal"])
        renovation = RenovationResultV4(
            status="FAILED", renovation_level=request.renovation_level,
            preliminary=True, limitations=["no tier matched final ARV"],
        )
    else:
        cell = find_cell(tier, request.renovation_level)
        if cell is None:
            status = "REVIEW_REQUIRED"
            incomplete.extend(["renovation", "deal"])
            renovation = RenovationResultV4(
                status="FAILED", tier_key=tier.tier_key,
                renovation_level=request.renovation_level,
                preliminary=True, limitations=["unknown renovation level"],
            )
        else:
            items, auto_total, extra_total, major_limits, additional_results = evaluate_major_items(
                settings.major_items, request.major_item_evidence,
                request.additional_items, ledger, list(cell.included_systems),
            )
            base_rehab = subject.sqft * cell.rehab_rate_per_sqft
            total_rehab = base_rehab + auto_total + extra_total
            preliminary = bool(major_limits) or status == "REVIEW_REQUIRED"
            if status == "REVIEW_REQUIRED":
                preliminary = True
            renovation = RenovationResultV4(
                status="PRELIMINARY" if preliminary else "COMPLETED",
                tier_key=tier.tier_key, renovation_level=request.renovation_level,
                base_rehab=base_rehab, major_items_total=auto_total,
                additional_total=extra_total, total_rehab=total_rehab,
                preliminary=preliminary, limitations=major_limits, items=items,
                additional_items=additional_results,
            )
            deal_result = evaluate_deal(
                final_arv, total_rehab, settings.deal, cell.flip_profit,
                preliminary=preliminary, limitations=major_limits,
            )
            if preliminary:
                incomplete.append("deal")
    investor = evaluate_investor_cohort(
        subject, request.comps, settings.adjustments, request.evaluation_date,
        settings.filters, settings.transaction_rule, decisions, ledger,
        investor_subject_seen, adjustment_outcomes,
    )
    if investor.status == "INSUFFICIENT_INVESTOR_DATA" and "investor" not in incomplete:
        incomplete.append("investor")
    return _result(
        request, snapshot_id, snapshot_hash, status, decisions, ledger,
        incomplete=incomplete, arv=arv, renovation=renovation,
        deal=deal_result, investor=investor,
    )


__all__ = ["evaluate_v4"]
