"""Deterministic V4 evaluation orchestration."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.deal import (
    AdjustmentLedgerEntryV4,
    ArvResultV4,
    DealResultV4,
    EvalErrorV4,
    EvaluationRequestV4,
    EvaluationResultV4,
    InvestorCohortResultV4,
    RenovationResultV4,
)
from .adjustments import adjusted_ppsf, apply_comp_adjustments, apply_subject_adjustments, mean
from .deal import evaluate_deal
from .investor import evaluate_investor_cohort
from .renovation import evaluate_major_items, find_cell, map_tier, validate_tiers
from .selection import select_arv_comps


def _result(
    request: EvaluationRequestV4,
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
    snapshot_hash = request.settings.content_hash or request.settings.compute_content_hash()
    return EvaluationResultV4(
        status=status,  # type: ignore[arg-type]
        settings_snapshot_id=request.settings.snapshot_id,
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
    settings = request.settings
    tier_errors = validate_tiers(settings.tiers)
    accepted, decisions, _ = select_arv_comps(
        subject,
        request.comps,
        settings.filters,
        request.evaluation_date,
        settings.transaction_rule,
    )
    ledger: list[AdjustmentLedgerEntryV4] = []
    seen: set[str] = set()
    if tier_errors:
        return _result(
            request,
            "FAILED",
            decisions,
            ledger,
            errors=[EvalErrorV4(code="INVALID_TIERS", section="renovation", message="; ".join(tier_errors))],
            incomplete=["renovation", "deal"],
            arv=ArvResultV4(status="FAILED", limitations=tier_errors),
            investor=InvestorCohortResultV4(status="INSUFFICIENT_INVESTOR_DATA", limitations=tier_errors),
        )
    if len(accepted) < 3:
        investor = evaluate_investor_cohort(
            subject,
            request.comps,
            settings.adjustments,
            request.evaluation_date,
            settings.filters,
            settings.transaction_rule,
            decisions,
        )
        return _result(
            request,
            "INSUFFICIENT_COMPS",
            decisions,
            ledger,
            incomplete=["arv", "renovation", "deal"],
            arv=ArvResultV4(status="INSUFFICIENT_DATA", limitations=["fewer than three accepted comps"]),
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
    if len(usable) < 3:
        investor = evaluate_investor_cohort(
            subject, request.comps, settings.adjustments, request.evaluation_date,
            settings.filters, settings.transaction_rule, decisions,
        )
        return _result(
            request, "INSUFFICIENT_COMPS", decisions, ledger, incomplete=["arv", "renovation", "deal"],
            arv=ArvResultV4(status="INSUFFICIENT_DATA", limitations=["fewer than three calculable comps"]),
            investor=investor,
        )
    for item in usable:
        total, skipped = apply_comp_adjustments(
            subject, item.comp, settings.adjustments, "comp", seen, ledger, calc_limitations
        )
        skipped_notes.extend(skipped)
        price = item.comp.verified_sale_price + total
        value = adjusted_ppsf(price, item.comp.sqft)
        if value is None:
            return _result(
                request, "FAILED", decisions, ledger,
                errors=[EvalErrorV4(code="MISSING_SQFT", section="arv", message=item.comp.comp_id)],
                arv=ArvResultV4(status="FAILED"),
            )
        ppsfs.append(value)
    avg_ppsf = mean(ppsfs)
    if not isinstance(subject.sqft, Decimal) or subject.sqft <= 0:
        return _result(
            request, "FAILED", decisions, ledger,
            errors=[EvalErrorV4(code="MISSING_SUBJECT_SQFT", section="arv", message="subject sqft required")],
            arv=ArvResultV4(status="FAILED"),
        )
    base_arv = avg_ppsf * subject.sqft
    subj_total, _ = apply_subject_adjustments(subject, settings.adjustments, ledger, seen, calc_limitations)
    final_arv = base_arv + subj_total
    arv = ArvResultV4(
        status="COMPLETED",
        accepted_comp_ids=[a.comp.comp_id for a in usable],
        average_adjusted_ppsf=avg_ppsf,
        base_arv=base_arv,
        subject_adjustment_total=subj_total,
        final_arv=final_arv,
        exact_value=format(final_arv, "f"),
        limitations=list(calc_limitations),
        skipped_adjustments=list(skipped_notes),
    )
    tier = map_tier(final_arv, settings.tiers)
    renovation: RenovationResultV4 | None = None
    deal_result: DealResultV4 | None = None
    status = "COMPLETED"
    incomplete: list[str] = []
    if tier is None:
        status = "REVIEW_REQUIRED"
        incomplete = ["renovation", "deal"]
        renovation = RenovationResultV4(
            status="FAILED",
            renovation_level=request.renovation_level,
            preliminary=True,
            limitations=["no tier matched final ARV"],
        )
    else:
        cell = find_cell(tier, request.renovation_level)
        if cell is None:
            status = "REVIEW_REQUIRED"
            incomplete = ["renovation", "deal"]
            renovation = RenovationResultV4(
                status="FAILED",
                tier_key=tier.tier_key,
                renovation_level=request.renovation_level,
                preliminary=True,
                limitations=["unknown renovation level"],
            )
        else:
            items, auto_total, extra_total, major_limits = evaluate_major_items(
                settings.major_items, request.major_item_evidence, request.additional_items, ledger
            )
            base_rehab = subject.sqft * cell.rehab_rate_per_sqft
            total_rehab = base_rehab + auto_total + extra_total
            preliminary = bool(major_limits)
            renovation = RenovationResultV4(
                status="PRELIMINARY" if preliminary else "COMPLETED",
                tier_key=tier.tier_key,
                renovation_level=request.renovation_level,
                base_rehab=base_rehab,
                major_items_total=auto_total,
                additional_total=extra_total,
                total_rehab=total_rehab,
                preliminary=preliminary,
                limitations=major_limits,
                items=items,
            )
            deal_result = evaluate_deal(
                final_arv, total_rehab, settings.deal, cell.flip_profit,
                preliminary=preliminary, limitations=major_limits,
            )
            if preliminary:
                incomplete.append("deal")
    investor = evaluate_investor_cohort(
        subject,
        request.comps,
        settings.adjustments,
        request.evaluation_date,
        settings.filters,
        settings.transaction_rule,
        decisions,
    )
    if investor.status == "INSUFFICIENT_INVESTOR_DATA" and "investor" not in incomplete:
        incomplete.append("investor")
    return _result(request, status, decisions, ledger, incomplete=incomplete, arv=arv, renovation=renovation, deal=deal_result, investor=investor)


__all__ = ["evaluate_v4"]
