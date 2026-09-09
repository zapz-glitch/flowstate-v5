from datetime import date, timedelta
from decimal import Decimal

import pytest

from eval_engine.contracts.comps import ConditionEvidenceV4, PhysicalSimilarityV4
from eval_engine.domain.evaluate import evaluate_v4
from test_upper_half import request_for


def staged(prices=(300000, 400000)):
    request = request_for(prices)
    request.settings.arv_selection_policy = "provider_authoritative_upper_half_v2"
    return request


def aged(request, age, year=2000):
    for comp in request.comps:
        comp.sale_date = request.evaluation_date - timedelta(days=age)
        comp.year_built = year
    return request


@pytest.mark.parametrize("age,year,stage,count", [
    (180, 1990, "stage_1", 1), (181, 1990, "stage_2", 2),
    (365, 2010, "stage_2", 2), (365, 2015, "stage_3", 3),
    (180, 1985, "stage_3", 3), (366, 2000, None, 3), (180, 1984, None, 3),
])
def test_stage_boundaries(age, year, stage, count):
    result = evaluate_v4(aged(staged(), age, year))
    assert result.arv.selected_stage == stage
    assert len(result.arv.stage_trace) == count
    assert bool(result.arv.accepted_comp_ids) == (stage is not None)


def test_one_automatic_reference_stops_expansion():
    request = aged(staged(), 300)
    request.comps[0].sale_date = request.evaluation_date - timedelta(days=100)
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["0"]
    assert len(result.arv.stage_trace) == 1


def test_high_price_condition_exclusion_never_backfills_lower_half():
    request = staged()
    request.comps[1].condition_evidence = ConditionEvidenceV4(status="unfinished_or_distressed", sale_relevant=True, confidence="high", reason="Sale-date interior photographs show unfinished construction")
    result = evaluate_v4(request)
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.final_arv is None
    for trace in result.arv.stage_trace:
        assert trace.upper_half_comp_ids == ["1"]
        assert trace.condition_excluded_comp_ids == ["1"]
        assert trace.selected_comp_ids == []
        assert trace.cutoff_price == 400000
    assert next(d for d in result.decisions if d.comp_id == "0").arv_cohort == "lower_half"


def test_condition_failure_can_expand_to_older_upper_half_reference():
    request = staged([300000, 400000, 450000])
    request.comps[1].condition_evidence = ConditionEvidenceV4(status="unfinished_or_distressed", sale_relevant=True, confidence="high")
    request.comps[2].sale_date = request.evaluation_date - timedelta(days=220)
    result = evaluate_v4(request)
    assert result.arv.selected_stage == "stage_2"
    assert result.arv.accepted_comp_ids == ["2"]
    assert result.arv.stage_trace[0].condition_excluded_comp_ids == ["1"]
    assert result.arv.stage_trace[1].upper_half_comp_ids == ["1", "2"]


def test_multiple_survivors_stop_without_filling_excluded_upper_half_slot():
    request = staged([300000, 400000, 500000, 600000, 700000])
    request.comps[4].condition_evidence = ConditionEvidenceV4(status="unfinished_or_distressed", sale_relevant=True, confidence="high")
    result = evaluate_v4(request)
    assert set(result.arv.accepted_comp_ids) == {"2", "3"}
    assert len(result.arv.stage_trace) == 1
    assert result.arv.stage_trace[0].upper_half_comp_ids == ["2", "3", "4"]
    assert result.arv.stage_trace[0].condition_excluded_comp_ids == ["4"]


@pytest.mark.parametrize("field,value", [("subdivision", "Other"), ("sqft", Decimal(3000)), ("property_type", "Condominium"), ("building_style", "Ranch")])
def test_expansion_never_relaxes_other_physical_gates(field, value):
    request = aged(staged([300000]), 220, 2012)
    request.subject.property_type = "Single Family"
    request.subject.building_style = "Conventional"
    request.comps[0].property_type = "Single Family"
    request.comps[0].building_style = "Conventional"
    setattr(request.comps[0], field, value)
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == []
    assert len(result.arv.stage_trace) == 3


def test_price_review_precedes_upper_half_split_in_every_stage():
    request = aged(staged([300000, 400000, 500000, 600000, 18178000]), 220)
    result = evaluate_v4(request)
    assert result.arv.selected_stage == "stage_2"
    assert set(result.arv.accepted_comp_ids) == {"2", "3"}
    assert result.arv.stage_trace[-1].price_review_comp_ids == ["4"]
    assert result.arv.stage_trace[-1].qualified_comp_ids == ["0", "1", "2", "3"]


@pytest.mark.parametrize("status,relevant,confidence,label,accepted", [
    ("renovated", True, "high", "A", True),
    ("renovated", False, "high", "B", True),
    ("unfinished_or_distressed", False, "high", "B", True),
    ("unfinished_or_distressed", True, "medium", "B", True),
    ("unknown", True, "high", "B", True),
    ("unfinished_or_distressed", True, "high", "excluded", False),
])
def test_condition_labels_require_sale_relevance_and_high_confidence(status, relevant, confidence, label, accepted):
    request = staged([300000])
    request.comps[0].condition_evidence = ConditionEvidenceV4(status=status, sale_relevant=relevant, confidence=confidence, reason="Condition evidence fixture")
    result = evaluate_v4(request)
    assert bool(result.arv.accepted_comp_ids) == accepted
    assert result.decisions[0].condition_classification == label
    assert any("condition" in detail.lower() or "renovation" in detail.lower() for detail in result.decisions[0].ranking_details)


def test_v2_ignores_vision_phenotype_and_garage_supplementation():
    request = staged([300000])
    request.subject.building_style = "Conventional"
    request.subject.garage_spaces = 2
    request.comps[0].building_style = "Ranch"
    request.comps[0].garage_spaces = 1
    request.comps[0].physical_similarity = PhysicalSimilarityV4(status="match", confidence="high")
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == []
    assert all(o.kind not in {"physical_similarity", "garage_capacity_match"} for o in result.decisions[0].rule_outcomes)


def test_v2_visual_mismatch_cannot_overrule_matching_provider_style():
    request = staged([300000])
    request.subject.building_style = request.comps[0].building_style = "Conventional"
    request.comps[0].physical_similarity = PhysicalSimilarityV4(status="mismatch", confidence="high")
    assert evaluate_v4(request).arv.accepted_comp_ids == ["0"]


def test_manual_condition_override_retains_explicit_audit():
    request = staged([300000])
    request.comps[0].condition_evidence = ConditionEvidenceV4(status="unfinished_or_distressed", sale_relevant=True, confidence="high")
    request.selected_comp_ids = ["0"]
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["0"]
    assert result.decisions[0].condition_classification == "excluded"
    assert "Operator override" in result.decisions[0].limitations[-1]
    assert result.status == "REVIEW_REQUIRED"


def test_non_arv_comp_does_not_receive_inferred_arv_label():
    request = staged([300000, 400000, 500000])
    request.comps[2].subdivision = "Other"
    result = evaluate_v4(request)
    labels = {d.comp_id: d.condition_classification for d in result.decisions}
    assert labels == {"0": None, "1": "B", "2": None}
    request.selected_comp_ids = ["0"]
    manual = evaluate_v4(request)
    selected = next(d for d in manual.decisions if d.comp_id == "0")
    assert selected.condition_classification == "B"
    assert "operator-selected outside" in selected.ranking_details[-1]
    assert next(d for d in manual.decisions if d.comp_id == "1").condition_classification is None


@pytest.mark.parametrize("state,city,age,year,expected_stage", [
    ("AZ", "Phoenix", 100, 2000, "stage_1"),
    ("TX", "Dallas", 220, 2000, "stage_2"),
    ("OH", "Columbus", 220, 2012, "stage_3"),
    ("NC", "Charlotte", 366, 2000, None),
])
def test_synthetic_geographically_varied_stage_contracts(state, city, age, year, expected_stage):
    request = aged(staged([300000, 400000, 500000, 600000]), age, year)
    request.subject.state = state
    request.subject.city = city
    request.subject.address = "Synthetic regional fixture, not a real appraisal"
    result = evaluate_v4(request)
    assert result.arv.selected_stage == expected_stage
    assert set(result.arv.accepted_comp_ids) == ({"2", "3"} if expected_stage else set())
    if expected_stage:
        assert result.arv.final_arv == 550000


def test_prior_policy_hash_and_behavior_do_not_apply_v2_evidence():
    request = request_for([300000, 400000])
    original_hash = request.settings.compute_content_hash()
    request.settings.content_hash = original_hash
    request.comps[1].condition_evidence = ConditionEvidenceV4(status="unfinished_or_distressed", sale_relevant=True, confidence="high")
    result = evaluate_v4(request)
    assert result.settings_content_hash == original_hash
    assert result.arv.accepted_comp_ids == ["1"]
    assert result.arv.stage_trace == []
    assert all(d.condition_classification is None for d in result.decisions)


@pytest.mark.parametrize("address,area,year,subdivision,prices,areas,expected", [
    ("4648 PIEDMONT CT", 1353, 1973, "MALIBU GROVES ELEVENTH ADD", [207500, 275000, 275000], [3814, 1225, 1250], {"1", "2"}),
    ("16049 MAGNOLIA HILL ST", 1697, 2000, "ORANGE TREE PH I SUB", [365000, 380000, 430000], [2199, 1747, 2057], {"1"}),
])
def test_regional_recorded_size_and_price_regressions(address, area, year, subdivision, prices, areas, expected):
    # These physical and price values come from the saved September 2026 local reports.
    request = staged(prices)
    request.subject.address = address
    request.subject.sqft = Decimal(area)
    request.subject.year_built = year
    request.subject.subdivision = subdivision
    for rule in request.settings.filters:
        if rule.kind == "max_sqft_diff":
            rule.value = Decimal(area) / 5
    for comp, sqft in zip(request.comps, areas):
        comp.sqft = Decimal(sqft)
        comp.year_built = year
        comp.subdivision = subdivision
    result = evaluate_v4(request)
    assert set(result.arv.accepted_comp_ids) == expected
    assert result.arv.selected_stage == "stage_1"
    assert abs(sum(result.arv.comp_weights.values()) - 1) < Decimal("1e-25")
