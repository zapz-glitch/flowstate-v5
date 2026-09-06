"""Deterministic V4 evaluation orchestration."""

from __future__ import annotations

from decimal import Decimal

from ..contracts.deal import (
    AdjustmentLedgerEntryV4,
    ArvResultV4,
    DealResultV4,
    EvaluationRequestV4,
    EvaluationResultV4,
    InvestorCohortResultV4,
    RenovationResultV4,
)
from .adjustments import adjusted_ppsf, apply_comp_adjustments, mean
from .deal import evaluate_deal
from .investor import evaluate_investor_cohort
from .renovation import evaluate_major_items, find_cell, map_tier, validate_tiers
from .selection import select_arv_comps


def evaluate_v4(request: EvaluationRequestV4) -> EvaluationResultV4:
    subject = request.subject
    settings = request.settings
    tier_errors = validate_tiers(settings.tiers)
    accepted, decisions, _ = select_arv_comps(
        subject, request.comps, settings.filters, request.evaluation_date
    )
    ledger: list[AdjustmentLedgerEntryV4] = []
    seen: set[str] = set()
    if tier_errors:
        arv = ArvResultV4(status="FAILED")
        return EvaluationResultV4(
            status="FAILED",
            decisions=decisions,
            ledger=ledger,
            arv=arv,
            investor=InvestorCohortResultV4(
                status="INSUFFICIENT_INVESTOR_DATA",
                limitations=tier_errors,
            ),
        )
    if len(accepted) < 3:
        arv = ArvResultV4(status="INSUFFICIENT_COMPS")
        investor = evaluate_investor_cohort(
            subject, request.comps, settings.adjustments, request.evaluation_date
        )
        return EvaluationResultV4(
            status="INSUFFICIENT_COMPS",
            decisions=decisions,
            ledger=ledger,
            arv=arv,
            investor=investor,
        )
    ppsfs: list[Decimal] = []
    comp_adj_totals: dict[str, Decimal] = {}
    skipped_notes: list[str] = []
    for item in accepted:
        total, skipped = apply_comp_adjustments(
            subject, item.comp, settings.adjustments, "comp", seen, ledger
        )
        skipped_notes.extend(skipped)
        comp_adj_totals[item.comp.comp_id] = total
        price = item.comp.verified_sale_price + total
        value = adjusted_ppsf(price, item.comp.sqft)
        if value is None:
            arv = ArvResultV4(status="FAILED")
            return EvaluationResultV4(
                status="FAILED", decisions=decisions, ledger=ledger, arv=arv
            )
        ppsfs.append(value)
    avg_ppsf = mean(ppsfs)
    if not isinstance(subject.sqft, Decimal) or subject.sqft <= 0:
        arv = ArvResultV4(status="FAILED")
        return EvaluationResultV4(
            status="FAILED", decisions=decisions, ledger=ledger, arv=arv
        )
    base_arv = avg_ppsf * subject.sqft
    subj_total, subj_skipped = apply_comp_adjustments(
        subject, accepted[0].comp, settings.adjustments, "subject", seen, ledger
    )
    _ = subj_skipped
    final_arv = base_arv + subj_total
    arv = ArvResultV4(
        status="COMPLETED",
        accepted_comp_ids=[a.comp.comp_id for a in accepted],
        average_adjusted_ppsf=avg_ppsf,
        base_arv=base_arv,
        final_arv=final_arv,
        exact_value=format(final_arv, "f"),
    )
    tier = map_tier(final_arv, settings.tiers)
    renovation: RenovationResultV4 | None = None
    deal_result: DealResultV4 | None = None
    status: str = "COMPLETED"
    if tier is None:
        status = "REVIEW_REQUIRED"
        renovation = RenovationResultV4(
            renovation_level=request.renovation_level,
            preliminary=True,
            limitations=["no tier matched final ARV"],
        )
    else:
        cell = find_cell(tier, request.renovation_level)
        if cell is None:
            status = "REVIEW_REQUIRED"
            renovation = RenovationResultV4(
                tier_key=tier.tier_key,
                renovation_level=request.renovation_level,
                preliminary=True,
                limitations=["unknown renovation level"],
            )
        else:
            items, auto_total, extra_total, major_limits = evaluate_major_items(
                settings.major_items, request.major_item_evidence, request.additional_items
            )
            base_rehab = subject.sqft * cell.rehab_rate_per_sqft
            total_rehab = base_rehab + auto_total + extra_total
            preliminary = bool(major_limits)
            if preliminary and status == "COMPLETED":
                status = "COMPLETED"
            renovation = RenovationResultV4(
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
            deal_result = evaluate_deal(final_arv, total_rehab, settings.deal, cell.flip_profit)
    investor = evaluate_investor_cohort(
        subject, request.comps, settings.adjustments, request.evaluation_date
    )
    return EvaluationResultV4(
        status=status,  # type: ignore[arg-type]
        decisions=decisions,
        ledger=ledger,
        arv=arv,
        renovation=renovation,
        deal=deal_result,
        investor=investor,
    )


__all__ = ["evaluate_v4"]
