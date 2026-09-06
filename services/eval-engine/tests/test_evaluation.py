"""Backend-owned deterministic V4 evaluation tests."""

from __future__ import annotations

from decimal import Decimal

from eval_engine.contracts import (
    CompCandidateV4,
    EvaluationRequestV4,
    SettingsSnapshotV4,
    SubjectPropertyV4,
)
from eval_engine.contracts.deal import AdditionalRenovationItemV4, MajorItemEvidenceV4
from eval_engine.contracts.filters import AppraisalFilterV4, CompAdjustmentRuleV4
from eval_engine.contracts.settings import (
    DealSettingsV4,
    MajorItemRuleV4,
    RenovationTierCellV4,
    RenovationTierV4,
)
from eval_engine.domain.deal import round_display
from eval_engine.domain.evaluate import evaluate_v4
from eval_engine.domain.renovation import map_tier, validate_tiers

LEVELS = ["lipstick", "light_cosmetic", "full_cosmetic", "heavy_rehab", "full_gut"]


def make_tiers(rate="100", profit="50000"):
    return [
        RenovationTierV4(
            tier_key="under500k",
            lower_inclusive="0",
            upper_exclusive="500000",
            cells=[
                RenovationTierCellV4(
                    renovation_level=level,
                    rehab_rate_per_sqft=rate,
                    flip_profit=profit,
                )
                for level in LEVELS
            ],
        ),
        RenovationTierV4(
            tier_key="500k_to_under1m",
            lower_inclusive="500000",
            upper_exclusive="1000000",
            cells=[
                RenovationTierCellV4(
                    renovation_level=level,
                    rehab_rate_per_sqft=rate,
                    flip_profit=profit,
                )
                for level in LEVELS
            ],
        ),
        RenovationTierV4(
            tier_key="1m_to_3m",
            lower_inclusive="1000000",
            upper_inclusive="3000000",
            cells=[
                RenovationTierCellV4(
                    renovation_level=level,
                    rehab_rate_per_sqft=rate,
                    flip_profit=profit,
                )
                for level in LEVELS
            ],
        ),
        RenovationTierV4(
            tier_key="over3m",
            lower_inclusive="3000000",
            cells=[
                RenovationTierCellV4(
                    renovation_level=level,
                    rehab_rate_per_sqft=rate,
                    flip_profit=profit,
                )
                for level in LEVELS
            ],
        ),
    ]


def make_settings(filters=None, adjustments=None, tiers=None, deal=None, major=None):
    return SettingsSnapshotV4(
        snapshot_id="s1",
        filters=filters or [],
        adjustments=adjustments or [],
        tiers=tiers if tiers is not None else make_tiers(),
        deal=deal or DealSettingsV4(),
        major_items=major or [],
    )


def make_comp(comp_id, price, sqft="2000", sale_date="2026-06-01", **kwargs):
    return CompCandidateV4(
        comp_id=comp_id,
        verified_sale_price=price,
        sale_date=sale_date,
        sqft=sqft,
        evidence_ref=f"ev-{comp_id}",
        **kwargs,
    )


def make_request(subject_sqft="2000", comps=None, level="light_cosmetic", **kwargs):
    subject = SubjectPropertyV4(address="1 Main St", sqft=subject_sqft)
    return EvaluationRequestV4(
        subject=subject,
        comps=comps or [],
        renovation_level=level,
        settings=kwargs.get("settings", make_settings()),
        evaluation_date=kwargs.get("evaluation_date", "2026-09-01"),
        major_item_evidence=kwargs.get("major_item_evidence", []),
        additional_items=kwargs.get("additional_items", []),
    )


def test_exact_decimal_arv_fixture():
    comps = [
        make_comp("c1", "600000", sqft="2000"),
        make_comp("c2", "550000", sqft="2200"),
        make_comp("c3", "500000", sqft="2500"),
    ]
    request = make_request(comps=comps)
    result = evaluate_v4(request)
    p1 = Decimal(600000) / Decimal(2000)
    p2 = Decimal(550000) / Decimal(2200)
    p3 = Decimal(500000) / Decimal(2500)
    expected_avg = (p1 + p2 + p3) / Decimal(3)
    expected_arv = expected_avg * Decimal(2000)
    assert result.status == "COMPLETED"
    assert result.arv.average_adjusted_ppsf == expected_avg
    assert result.arv.final_arv == expected_arv
    assert result.arv.accepted_comp_ids == ["c1", "c2", "c3"]


def test_fewer_than_three_returns_insufficient_comps():
    comps = [make_comp("c1", "400000"), make_comp("c2", "300000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.status == "INSUFFICIENT_COMPS"


def test_tie_break_is_deterministic():
    comps = [
        make_comp(
            "c-b",
            "500000",
            sale_date="2026-05-01",
            provider_property_id="P2",
            address="B St",
        ),
        make_comp(
            "c-a",
            "500000",
            sale_date="2026-08-01",
            provider_property_id="P1",
            address="A St",
        ),
        make_comp("c-top", "700000"),
        make_comp("c-low", "100000"),
    ]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.accepted_comp_ids[0] == "c-top"
    assert result.arv.accepted_comp_ids[1] == "c-a"
    assert result.arv.accepted_comp_ids[2] == "c-b"
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert statuses["c-low"] == "NOT_EXAMINED_FOR_ARV"


def test_early_stop_marks_remaining_not_examined():
    comps = [make_comp(f"c{i}", str(500000 - i * 10000)) for i in range(6)]
    result = evaluate_v4(make_request(comps=comps))
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert list(statuses.values()).count("ACCEPTED") == 3
    assert list(statuses.values()).count("NOT_EXAMINED_FOR_ARV") == 3


def test_rejected_comp_records_reasons():
    filters = [
        AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="1"),
    ]
    comps = [
        make_comp("c1", "600000", distance_miles="0.5"),
        make_comp("c2", "500000", distance_miles="9"),
        make_comp("c3", "400000", distance_miles="0.2"),
        make_comp("c4", "300000", distance_miles="0.1"),
    ]
    request = make_request(comps=comps, settings=make_settings(filters=filters))
    result = evaluate_v4(request)
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert by_id["c2"].rejection_reasons
    assert by_id["c4"].arv_status == "ACCEPTED"


def test_unknown_required_evidence_fails_rule():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="2")]
    comps = [
        make_comp("c1", "600000", distance_miles="0.5"),
        make_comp("c2", "550000"),
        make_comp("c3", "500000", distance_miles="0.5"),
        make_comp("c4", "400000", distance_miles="0.5"),
    ]
    result = evaluate_v4(
        make_request(comps=comps, settings=make_settings(filters=filters))
    )
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"


def test_boundary_fixtures():
    tiers = make_tiers()
    cases = [
        (Decimal("499999.99"), "under500k"),
        (Decimal("500000"), "500k_to_under1m"),
        (Decimal("999999.99"), "500k_to_under1m"),
        (Decimal("1000000"), "1m_to_3m"),
        (Decimal("3000000"), "1m_to_3m"),
        (Decimal("3000000.01"), "over3m"),
    ]
    for value, expected in cases:
        assert map_tier(value, tiers).tier_key == expected
    assert validate_tiers(tiers) == []


def test_legacy_boundary_is_rejected():
    tiers = make_tiers()
    tiers[0] = RenovationTierV4(
        tier_key="under500k",
        lower_inclusive="0",
        upper_exclusive="501000",
        cells=tiers[0].cells,
    )
    assert validate_tiers(tiers)


def test_adjustment_signs_and_no_double_count():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3", baths="2")
    comps = [
        make_comp("c1", "500000", beds="2", baths="2"),
        make_comp("c2", "500000", beds="2", baths="2"),
        make_comp("c3", "500000", beds="2", baths="2"),
    ]
    adjustments = [
        CompAdjustmentRuleV4(
            rule_id="bed",
            kind="bedroom",
            per_unit_amount="15000",
            signed_amount="15000",
            unit="usd_per_bed",
            applies_to="comp",
        ),
    ]
    request = EvaluationRequestV4(
        subject=subject,
        comps=comps,
        renovation_level="light_cosmetic",
        settings=make_settings(adjustments=adjustments),
        evaluation_date="2026-09-01",
    )
    result = evaluate_v4(request)
    assert result.arv.final_arv == Decimal("515000") * Decimal(2000) / Decimal(2000)
    keys = [e.duplicate_key for e in result.ledger]
    assert len(keys) == len(set(keys))
    assert len(result.ledger) == 3


def test_duplicate_rule_instance_applies_once_per_target():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3")
    comps = [make_comp("c1", "400000", beds="3"), make_comp("c2", "390000", beds="3"), make_comp("c3", "380000", beds="3")]
    adjustments = [
        CompAdjustmentRuleV4(rule_id="feat", kind="feature", signed_amount="5000", applies_to="comp"),
        CompAdjustmentRuleV4(rule_id="feat", kind="feature", signed_amount="5000", applies_to="comp"),
    ]
    request = EvaluationRequestV4(
        subject=subject,
        comps=comps,
        renovation_level="light_cosmetic",
        settings=make_settings(adjustments=adjustments),
        evaluation_date="2026-09-01",
    )
    result = evaluate_v4(request)
    feat_entries = [e for e in result.ledger if e.rule_id == "feat"]
    assert len(feat_entries) == 3


def test_major_item_age_equal_below_above():
    rules = [
        MajorItemRuleV4(system_id="roof", age_threshold_years="20", replacement_cost="12000"),
        MajorItemRuleV4(system_id="hvac", age_threshold_years="15", replacement_cost="8000"),
        MajorItemRuleV4(system_id="plumbing", age_threshold_years="30", replacement_cost="5000"),
    ]
    evidence = [
        MajorItemEvidenceV4(system_id="roof", supported_age_years="20"),
        MajorItemEvidenceV4(system_id="hvac", supported_age_years="10"),
        MajorItemEvidenceV4(system_id="plumbing", supported_age_years="40"),
    ]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    request = make_request(
        comps=comps,
        settings=make_settings(major=rules),
        major_item_evidence=evidence,
    )
    result = evaluate_v4(request)
    by_system = {i.system_id: i for i in result.renovation.items}
    assert by_system["roof"].included is False
    assert by_system["hvac"].included is False
    assert by_system["plumbing"].included is True
    assert result.renovation.major_items_total == Decimal("5000")


def test_rounding_exact_ceiling_and_display():
    assert round_display(Decimal("123456"), Decimal("1000"), "half_up") == Decimal("123000")
    assert round_display(Decimal("123500"), Decimal("1000"), "half_up") == Decimal("124000")
    assert round_display(Decimal("123250"), Decimal("500"), "half_up") == Decimal("123500")
    comps = [make_comp("c1", "600000"), make_comp("c2", "600000"), make_comp("c3", "600000")]
    request = make_request(comps=comps)
    result = evaluate_v4(request)
    assert result.deal.initial_offer_status == "INCOMPLETE"
    assert result.deal.seller_contract_ceiling_exact is not None
    assert result.deal.displayed_mao is not None
    assert (
        result.deal.displayed_mao - result.deal.seller_contract_ceiling_exact
        == result.deal.display_rounding_difference
    )


def test_investor_clear_case_returns_labeled_cohort():
    comps = [
        make_comp(f"low{i}", str(200000 + i * 5000)) for i in range(4)
    ] + [make_comp(f"high{i}", str(600000 + i * 5000)) for i in range(4)]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "COHORT_FOUND"
    assert result.investor.method_label == "ENGINEERING_PROPOSAL"
    assert "ENGINEERING_PROPOSAL" in result.investor.method
    assert result.investor.selected_count >= 4


def test_investor_outlier_case_excludes_extreme():
    comps = [make_comp(f"c{i}", str(300000 + i * 2000)) for i in range(7)]
    comps.append(make_comp("spike", "5000000"))
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status in {"COHORT_FOUND", "INSUFFICIENT_INVESTOR_DATA"}
    assert any("spike" in e for e in result.investor.exclusions)


def test_investor_unimodal_returns_insufficient():
    comps = [make_comp(f"c{i}", "300000") for i in range(7)]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"


def test_investor_small_sample_returns_insufficient():
    comps = [make_comp("c1", "300000"), make_comp("c2", "310000"), make_comp("c3", "320000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"
    assert result.status == "INSUFFICIENT_COMPS" or result.arv.status in {
        "COMPLETED",
        "INSUFFICIENT_COMPS",
    }


def test_investor_does_not_fail_supported_arv():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.status == "COMPLETED"
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"
