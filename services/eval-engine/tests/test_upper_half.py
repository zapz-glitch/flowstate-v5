from decimal import Decimal
from datetime import date

import pytest

from eval_engine.contracts.base import canonical_hash
from eval_engine.contracts.comps import PhysicalSimilarityV4
from eval_engine.contracts.filters import AppraisalFilterV4
from eval_engine.domain.evaluate import evaluate_v4
from test_evaluation import make_comp, make_request, make_settings


def request_for(prices, **kwargs):
    settings = make_settings(filters=[
        AppraisalFilterV4(rule_id="subdivision", kind="subdivision_match"),
        AppraisalFilterV4(rule_id="year", kind="max_year_built_diff", value="10"),
        AppraisalFilterV4(rule_id="sqft", kind="max_sqft_diff", value="400"),
        AppraisalFilterV4(rule_id="age", kind="max_sale_age_days", value="180"),
        AppraisalFilterV4(rule_id="style", kind="building_style_match"),
    ]).model_copy(update={"arv_selection_policy": "upper_half_rule_weighted_v1"})
    comps = [make_comp(str(index), str(price), subdivision="Test", year_built=2000, **kwargs)
             for index, price in enumerate(prices)]
    request = make_request(comps=comps, settings=settings)
    return request.model_copy(update={"subject": request.subject.model_copy(update={"subdivision": "Test", "year_built": 2000})})


@pytest.mark.parametrize("prices,expected", [
    ([300000], {"0"}),
    ([300000, 400000], {"1"}),
    ([300000, 400000, 500000], {"1", "2"}),
    ([300000, 400000, 500000, 600000], {"2", "3"}),
    ([300000, 400000, 400000, 500000], {"1", "2", "3"}),
    ([400000, 400000, 400000, 400000], {"0", "1", "2", "3"}),
])
def test_upper_half_count_and_boundary_ties(prices, expected):
    result = evaluate_v4(request_for(prices))
    assert set(result.arv.accepted_comp_ids) == expected
    assert result.arv.qualified_comp_count == len(prices)
    assert result.arv.upper_half_cutoff_price == min(Decimal(prices[int(key)]) for key in expected)
    assert result.status == "REVIEW_REQUIRED"
    assert abs(sum(result.arv.comp_weights.values()) - 1) < Decimal("1e-25")


def test_joint_physical_gates_precede_price_split():
    request = request_for([300000, 400000, 900000, 1000000, 1100000])
    request.comps[2].subdivision = "Other"
    request.comps[3].year_built = 2020
    request.comps[4].sqft = Decimal(3000)
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["1"]
    assert result.arv.qualified_comp_count == 2
    assert all(d.arv_cohort == "not_qualified" for d in result.decisions if d.comp_id in {"2", "3", "4"})


def test_existing_sale_age_gate_is_not_silently_expanded():
    request = request_for([300000, 400000])
    request.comps[1].sale_date = date(2026, 2, 1)
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["0"]
    assert next(d for d in result.decisions if d.comp_id == "1").arv_cohort == "not_qualified"


def test_known_style_mismatch_excluded_unknown_allowed():
    request = request_for([300000, 400000])
    request.subject.building_style = "Conventional"
    request.comps[1].building_style = "Ranch"
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["0"]
    assert next(d for d in result.decisions if d.comp_id == "0").match_percent == 80


def test_verified_sale_gates_and_future_dates_remain_hard():
    request = request_for([300000, 400000, 500000])
    request.comps[1].sale_date = date(2027, 1, 1)
    request.comps[2].is_sale = False
    assert evaluate_v4(request).arv.accepted_comp_ids == ["0"]


def test_anomalous_ppsf_quarantined_before_split():
    result = evaluate_v4(request_for([300000, 400000, 500000, 600000, 18178000]))
    assert set(result.arv.accepted_comp_ids) == {"2", "3"}
    assert result.arv.qualified_comp_count == 4
    anomaly = next(d for d in result.decisions if d.comp_id == "4")
    assert anomaly.arv_cohort == "price_review"
    assert "requires review" in anomaly.selection_reason


def test_adjusted_ppsf_weighted_by_match_not_sale_price():
    request = request_for([300000, 400000, 500000, 600000])
    request.subject.garage_spaces = 2
    request.comps[2].garage_spaces = 2
    request.comps[3].garage_spaces = 1
    result = evaluate_v4(request)
    assert abs(result.arv.comp_weights["2"] - Decimal(5) / 9) < Decimal("1e-25")
    assert abs(result.arv.comp_weights["3"] - Decimal(4) / 9) < Decimal("1e-25")
    assert abs(result.arv.final_arv - Decimal(4900000) / 9) < Decimal("1e-20")


def test_manual_lower_half_override_remains_explicit_and_weighted():
    request = request_for([300000, 400000, 500000, 600000])
    request.selected_comp_ids = ["0", "3"]
    result = evaluate_v4(request)
    assert set(result.arv.accepted_comp_ids) == {"0", "3"}
    assert result.arv.final_arv == 450000
    assert next(d for d in result.decisions if d.comp_id == "0").arv_cohort == "lower_half"
    assert any("operator-selected" in limitation for limitation in result.arv.limitations)


def test_zero_qualified_returns_no_invented_arv():
    request = request_for([300000])
    request.comps[0].subdivision = "Other"
    result = evaluate_v4(request)
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.final_arv is None
    assert result.arv.qualified_comp_count == 0


def test_no_enabled_checks_has_positive_equal_weights():
    request = request_for([300000, 400000, 500000])
    request.settings.filters = []
    result = evaluate_v4(request)
    assert result.arv.comp_weights == {"2": Decimal("0.5"), "1": Decimal("0.5")}


def test_legacy_snapshot_hash_and_single_selection_unchanged():
    request = request_for([300000, 400000, 500000])
    request.settings.arv_selection_policy = "legacy_physical_v1"
    raw = request.settings.model_dump(mode="python")
    raw.pop("arv_selection_policy")
    raw.pop("snapshot_id")
    raw.pop("content_hash")
    version = raw.pop("schema_version")
    timestamps = raw.pop("source_timestamps")
    old_hash = canonical_hash({"version": version, "content": raw, "source": {"source_timestamps": timestamps}})
    assert request.settings.compute_content_hash() == old_hash
    request.settings.content_hash = old_hash
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["2"]
    assert result.arv.comp_weights == {}


@pytest.mark.parametrize("status,confidence,selected", [
    ("match", "high", True), ("match", "medium", False),
    ("unknown", "high", False), ("mismatch", "high", False),
])
def test_visual_evidence_can_resolve_label_mismatch_without_changing_raw_rule(status, confidence, selected):
    request = request_for([300000])
    request.subject.building_style = "Conventional"
    request.comps[0].building_style = "Ranch"
    request.comps[0].physical_similarity = PhysicalSimilarityV4(status=status, confidence=confidence, reason="Evidence fixture")
    result = evaluate_v4(request)
    assert bool(result.arv.accepted_comp_ids) == selected
    style = next(o for o in result.decisions[0].rule_outcomes if o.kind == "building_style_match")
    assert not style.passed


def test_high_confidence_visual_mismatch_overrides_matching_label():
    request = request_for([300000])
    request.subject.building_style = request.comps[0].building_style = "Conventional"
    request.comps[0].physical_similarity = PhysicalSimilarityV4(status="mismatch", confidence="high")
    assert evaluate_v4(request).arv.accepted_comp_ids == []


def test_recency_weights_recent_upper_half_sale_more_without_admitting_lower_half():
    request = request_for([300000, 400000, 500000, 600000])
    request.comps[0].sale_date = date(2026, 9, 1)
    request.comps[2].sale_date = date(2026, 8, 1)
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["2", "3"]
    decisions = {d.comp_id: d for d in result.decisions}
    assert decisions["2"].recency_weight == Decimal(180) / 211
    assert decisions["3"].recency_weight == Decimal(180) / 272
    assert result.arv.comp_weights["2"] > result.arv.comp_weights["3"]
    assert result.arv.final_arv < 550000
    assert decisions["0"].arv_cohort == "lower_half"


@pytest.mark.parametrize("comp_type,eligible", [
    ("SFR", True), ("Single Family Residential", True), ("Single-Family Detached", True),
    ("Condominium", False), ("Townhouse", False), ("", True), ("Residential", True),
])
def test_known_property_type_mismatch_cannot_enter_automatic_arv(comp_type, eligible):
    request = request_for([300000])
    request.subject.property_type = "Single Family"
    request.comps[0].property_type = comp_type
    result = evaluate_v4(request)
    assert bool(result.arv.accepted_comp_ids) == eligible
    outcome = next(o for o in result.decisions[0].rule_outcomes if o.kind == "property_type_match")
    if comp_type in {"", "Residential"}:
        assert not outcome.passed
        assert outcome.limitation.startswith("unknown")
