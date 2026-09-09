from decimal import Decimal

from ..contracts.comps import CompCandidateV4
from ..contracts.deal import ArvStageTraceV4, CompDecisionV4
from ..contracts.filters import AppraisalFilterV4, TransactionRuleV4
from ..contracts.subject import SubjectPropertyV4
from .selection import select_arv_comps
from .validation import ValidatedComp


STAGES = (("stage_1", 180, 10), ("stage_2", 365, 10), ("stage_3", 365, 15))


def _stage_filters(filters: list[AppraisalFilterV4], age: int, year: int) -> list[AppraisalFilterV4]:
    limits = {"max_sale_age_days": age, "max_year_built_diff": year}
    rules = [rule.model_copy(update={"enabled": True, "value": Decimal(limits[rule.kind])})
             if rule.kind in limits else rule for rule in filters]
    for kind, value in limits.items():
        if not any(rule.kind == kind for rule in rules):
            rules.append(AppraisalFilterV4(rule_id=kind, kind=kind, value=Decimal(value)))
    return rules


def _condition_decisions(comps: list[CompCandidateV4], decisions: list[CompDecisionV4], manual: bool = False) -> set[str]:
    by_id = {comp.comp_id: comp for comp in comps}
    excluded: set[str] = set()
    for decision in decisions:
        if decision.arv_cohort != "upper_half" and not (manual and decision.arv_status == "ACCEPTED"):
            continue
        evidence = by_id[decision.comp_id].condition_evidence
        supported = evidence is not None and evidence.sale_relevant and evidence.confidence == "high"
        if decision.arv_status != "ACCEPTED" and not (supported and evidence.status == "unfinished_or_distressed"):
            continue
        if supported and evidence.status == "unfinished_or_distressed":
            decision.condition_classification = "excluded"
            reason = f"Sale-relevant unfinished or distressed condition: {evidence.reason}"
            if decision.arv_cohort == "upper_half":
                excluded.add(decision.comp_id)
            if decision.arv_status == "ACCEPTED":
                if manual:
                    decision.limitations.append("Operator override of condition exclusion; review required")
                else:
                    decision.arv_status = "REJECTED"
                    decision.selection_reason = reason
                    decision.rejection_reasons.append(reason)
        elif supported and evidence.status == "renovated":
            decision.condition_classification = "A"
            reason = f"A: sale-relevant visible renovation evidence; {evidence.reason}"
        else:
            decision.condition_classification = "B"
            reason = "B: price-inferred ARV reference; condition evidence missing, uncertain or not tied to the sale"
        if manual and decision.arv_cohort != "upper_half":
            reason += "; operator-selected outside the automatic ARV cohort"
        decision.ranking_details.append(reason)
    return excluded


def select_staged_arv_comps(
    subject: SubjectPropertyV4, comps: list[CompCandidateV4], filters: list[AppraisalFilterV4],
    evaluation_date: object, transaction_rule: TransactionRuleV4 | None = None,
    selected_comp_ids: list[str] | None = None,
) -> tuple[list[ValidatedComp], list[CompDecisionV4], list[ValidatedComp], list[ArvStageTraceV4], str]:
    traces: list[ArvStageTraceV4] = []
    for stage_id, age, year in STAGES:
        stage_filters = _stage_filters(filters, age, year)
        accepted, decisions, candidates = select_arv_comps(
            subject, comps, stage_filters, evaluation_date, transaction_rule,
            selection_policy="provider_authoritative_upper_half_v2",
        )
        excluded = _condition_decisions(comps, decisions)
        accepted = [item for item in accepted if item.comp.comp_id not in excluded]
        upper = {decision.comp_id for decision in decisions if decision.arv_cohort == "upper_half"}
        prices = [comp.verified_sale_price for comp in comps if comp.comp_id in upper]
        traces.append(ArvStageTraceV4(
            stage_id=stage_id, sale_age_days=age, year_built_diff=year,
            qualified_comp_ids=[d.comp_id for d in decisions if d.arv_cohort in {"upper_half", "lower_half"}],
            upper_half_comp_ids=sorted(upper), condition_excluded_comp_ids=sorted(excluded),
            selected_comp_ids=[item.comp.comp_id for item in accepted],
            price_review_comp_ids=[d.comp_id for d in decisions if d.arv_cohort == "price_review"],
            cutoff_price=min(prices) if prices else None,
        ))
        # A lower-half sale never replaces an excluded upper-half sale within the same stage.
        if accepted:
            break
    if selected_comp_ids is not None:
        accepted, decisions, candidates = select_arv_comps(
            subject, comps, stage_filters, evaluation_date, transaction_rule, selected_comp_ids,
            selection_policy="provider_authoritative_upper_half_v2",
        )
        _condition_decisions(comps, decisions, manual=True)
    return accepted, decisions, candidates, traces, stage_id
