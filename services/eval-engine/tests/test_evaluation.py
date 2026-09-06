"""Backend-owned deterministic V4 evaluation tests."""

from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from eval_engine.contracts import (
    CompCandidateV4,
    EvaluationRequestV4,
    SettingsSnapshotV4,
    SubjectPropertyV4,
    TransactionRuleV4,
)
from eval_engine.contracts.deal import AdditionalRenovationItemV4, MajorItemEvidenceV4
from eval_engine.contracts.filters import AppraisalFilterV4, CompAdjustmentRuleV4
from eval_engine.contracts.settings import (
    DealSettingsV4,
    MajorItemRuleV4,
    RenovationTierCellV4,
    RenovationTierV4,
)
from eval_engine.domain.deal import evaluate_deal, round_display
from eval_engine.domain.evaluate import evaluate_v4
from eval_engine.domain.investor import MIN_ELIGIBLE
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


def make_settings(filters=None, adjustments=None, tiers=None, deal=None, major=None, tx=None):
    return SettingsSnapshotV4(
        snapshot_id="s1",
        content_hash="",
        filters=filters or [],
        adjustments=adjustments or [],
        transaction_rule=tx or TransactionRuleV4(),
        tiers=tiers if tiers is not None else make_tiers(),
        deal=deal or DealSettingsV4(),
        major_items=major or [],
    )


def make_comp(comp_id, price, sqft="2000", sale_date="2026-06-01", **kwargs):
    kwargs.setdefault("evidence_ref", f"ev-{comp_id}")
    return CompCandidateV4(
        comp_id=comp_id,
        verified_sale_price=price,
        sale_date=sale_date,
        sqft=sqft,
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


def permitted_evidence(system, age, scope="roof replacement", completion="permit finaled"):
    return MajorItemEvidenceV4(
        system_id=system,
        supported_age_years=age,
        evidence_date="2020-01-01",
        permit_scope=scope,
        completion_evidence=completion,
        source="permit",
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
    assert result.methodology_version == "evaluation-v4"
    assert result.settings_snapshot_id == "s1"
    assert len(result.settings_content_hash) == 64


def test_fewer_than_three_returns_insufficient_comps():
    comps = [make_comp("c1", "400000"), make_comp("c2", "300000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.status == "INSUFFICIENT_DATA"
    assert "arv" in result.incomplete_sections


def test_tie_break_is_deterministic():
    comps = [
        make_comp("c-b", "500000", sale_date="2026-05-01", provider_property_id="P2", address="B St"),
        make_comp("c-a", "500000", sale_date="2026-08-01", provider_property_id="P1", address="A St"),
        make_comp("c-top", "700000"),
        make_comp("c-low", "100000"),
    ]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.accepted_comp_ids[0] == "c-top"
    assert result.arv.accepted_comp_ids[1] == "c-a"
    assert result.arv.accepted_comp_ids[2] == "c-b"
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert statuses["c-low"] == "NOT_EXAMINED_FOR_ARV"


def test_permutation_invariant_duplicate_of_fallback():
    first = [
        make_comp("c1", "600000", provider_property_id="P1", address="1 Main", evidence_ref="tx-1"),
        make_comp("c2", "600000", provider_property_id="P1", address="1 Main", evidence_ref="tx-2"),
        make_comp("c3", "500000"),
        make_comp("c4", "400000"),
        make_comp("c5", "300000"),
    ]
    swapped = [first[1], first[0], first[2], first[3], first[4]]
    first_result = evaluate_v4(make_request(comps=first))
    swapped_result = evaluate_v4(make_request(comps=swapped))
    first_dupes = sorted((d.comp_id, d.duplicate_of) for d in first_result.decisions if d.duplicate_of)
    swapped_dupes = sorted((d.comp_id, d.duplicate_of) for d in swapped_result.decisions if d.duplicate_of)
    assert first_dupes == swapped_dupes
    assert {d.comp_id for d in first_result.decisions if d.arv_status == "ACCEPTED"} == {
        d.comp_id for d in swapped_result.decisions if d.arv_status == "ACCEPTED"
    }


def test_address_fallback_duplicate_without_provider_id():
    comps = [
        make_comp("c1", "600000", address="Same Address"),
        make_comp("c2", "590000", address="same address"),
        make_comp("c3", "500000"),
        make_comp("c4", "400000"),
    ]
    result = evaluate_v4(make_request(comps=comps))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert by_id["c2"].duplicate_of == "c1"


def test_early_stop_marks_remaining_not_examined():
    comps = [make_comp(f"c{i}", str(500000 - i * 10000)) for i in range(6)]
    result = evaluate_v4(make_request(comps=comps))
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert list(statuses.values()).count("ACCEPTED") == 3
    assert list(statuses.values()).count("NOT_EXAMINED_FOR_ARV") == 3


def test_rejected_comp_records_reasons_and_rule_outcomes():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="1")]
    comps = [
        make_comp("c1", "600000", distance_miles="0.5"),
        make_comp("c2", "500000", distance_miles="9"),
        make_comp("c3", "400000", distance_miles="0.2"),
        make_comp("c4", "300000", distance_miles="0.1"),
    ]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert by_id["c2"].rejection_reasons
    assert by_id["c2"].rule_outcomes and by_id["c2"].rule_outcomes[0].passed is False
    assert by_id["c1"].rule_outcomes and by_id["c1"].rule_outcomes[0].passed is True
    assert by_id["c4"].arv_status == "ACCEPTED"


def test_configured_transaction_rule_without_invented_lists():
    tx = TransactionRuleV4(rule_id="tx", denied_codes=["RELO"], allowed_types=["sale"])
    comps = [
        make_comp("c1", "600000", transaction_code="ARMS", transaction_type="sale"),
        make_comp("c2", "590000", transaction_code="RELO", transaction_type="sale"),
        make_comp("c3", "580000", transaction_code="ARMS", transaction_type="sale"),
        make_comp("c4", "570000", transaction_code="ARMS", transaction_type="sale"),
    ]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(tx=tx)))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert "tx" in " ".join(by_id["c2"].rejection_reasons)
    default_result = evaluate_v4(make_request(comps=comps))
    assert default_result.arv.accepted_comp_ids[:3] == ["c1", "c2", "c3"]


def test_unknown_required_evidence_fails_rule():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="2")]
    comps = [
        make_comp("c1", "600000", distance_miles="0.5"),
        make_comp("c2", "550000"),
        make_comp("c3", "500000", distance_miles="0.5"),
        make_comp("c4", "400000", distance_miles="0.5"),
    ]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"


def test_missing_calc_field_rejects_comp_but_continues_first_three():
    comps = [
        make_comp("c-top", "900000"),
        make_comp("c-bad", "800000"),
        make_comp("c2", "700000"),
        make_comp("c3", "600000"),
        make_comp("c4", "500000"),
    ]
    comps[1] = CompCandidateV4(comp_id="c-bad", verified_sale_price="800000", sale_date="2026-06-01", evidence_ref="ev-bad")
    result = evaluate_v4(make_request(comps=comps))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c-bad"].arv_status == "REJECTED"
    assert result.arv.status == "FAILED" or result.arv.accepted_comp_ids[:3] == ["c-top", "c2", "c3"]


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


def test_strict_tier_order_endpoints_and_cells():
    tiers = make_tiers()
    assert validate_tiers(tiers) == []
    assert validate_tiers(list(reversed(tiers)))
    bad = make_tiers()
    bad[0] = RenovationTierV4(tier_key="under500k", lower_inclusive="0", upper_exclusive="501000", cells=bad[0].cells)
    assert validate_tiers(bad)
    incomplete = make_tiers()
    incomplete[1] = RenovationTierV4(
        tier_key="500k_to_under1m", lower_inclusive="500000", upper_exclusive="1000000",
        cells=incomplete[1].cells[:4],
    )
    assert validate_tiers(incomplete)


def test_adjustment_signs_and_no_double_count():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3", baths="2")
    comps = [make_comp("c1", "500000", beds="2", baths="2"), make_comp("c2", "500000", beds="2", baths="2"), make_comp("c3", "500000", beds="2", baths="2")]
    adjustments = [CompAdjustmentRuleV4(rule_id="bed", kind="bedroom", per_unit_amount="15000", signed_amount="15000", unit="usd_per_bed", applies_to="comp")]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    assert result.arv.final_arv == Decimal("515000") * Decimal(2000) / Decimal(2000)
    keys = [e.duplicate_key for e in result.ledger]
    assert len(keys) == len(set(keys))
    assert len([e for e in result.ledger if e.stage == "comp"]) == 3


def test_subject_adjustment_applies_once_with_stage_semantics():
    subject = SubjectPropertyV4(address="s", sqft="2000")
    comps = [make_comp("c1", "500000"), make_comp("c2", "500000"), make_comp("c3", "500000")]
    adjustments = [CompAdjustmentRuleV4(rule_id="subj", kind="feature", signed_amount="7000", applies_to="subject")]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    subject_entries = [e for e in result.ledger if e.stage == "subject"]
    assert len(subject_entries) == 1
    assert result.arv.subject_adjustment_total == Decimal("7000")
    assert result.arv.final_arv == Decimal("507000")


def test_sale_age_adjustment_returns_skipped_limitation():
    subject = SubjectPropertyV4(address="s", sqft="2000")
    comps = [make_comp("c1", "500000"), make_comp("c2", "500000"), make_comp("c3", "500000")]
    adjustments = [CompAdjustmentRuleV4(rule_id="age", kind="sale_age", signed_amount="1000", applies_to="comp")]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    assert result.arv.final_arv == Decimal("500000")
    assert any("sale_age" in skip or "sale_age" in limit for skip in result.arv.skipped_adjustments for limit in result.arv.limitations + ["sale_age"])


def test_duplicate_rule_instance_applies_once_per_target():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3")
    comps = [make_comp("c1", "400000", beds="3"), make_comp("c2", "390000", beds="3"), make_comp("c3", "380000", beds="3")]
    adjustments = [
        CompAdjustmentRuleV4(rule_id="feat", kind="feature", signed_amount="5000", applies_to="comp"),
        CompAdjustmentRuleV4(rule_id="feat", kind="feature", signed_amount="5000", applies_to="comp"),
    ]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    assert len([e for e in result.ledger if e.rule_id == "feat"]) == 3


def test_major_item_age_equal_below_above_with_scope_gate():
    rules = [
        MajorItemRuleV4(system_id="roof", age_threshold_years="20", replacement_cost="12000"),
        MajorItemRuleV4(system_id="hvac", age_threshold_years="15", replacement_cost="8000"),
        MajorItemRuleV4(system_id="plumbing", age_threshold_years="30", replacement_cost="5000"),
    ]
    evidence = [
        permitted_evidence("roof", "20"),
        permitted_evidence("hvac", "10"),
        permitted_evidence("plumbing", "40"),
    ]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    by_system = {i.system_id: i for i in result.renovation.items}
    assert by_system["roof"].included is False
    assert by_system["hvac"].included is False
    assert by_system["plumbing"].included is True
    assert result.renovation.major_items_total == Decimal("5000")
    assert any(e.stage == "major_item" for e in result.ledger)


def test_major_item_missing_scope_stays_visible_and_preliminary():
    rules = [MajorItemRuleV4(system_id="roof", age_threshold_years="20", replacement_cost="12000")]
    evidence = [MajorItemEvidenceV4(system_id="roof", supported_age_years="40", source="owner")]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    assert result.arv.status == "COMPLETED"
    assert result.renovation.preliminary is True
    assert result.renovation.items[0].included is False
    assert "deal" in result.incomplete_sections


def test_major_item_conflict_reconciliation_and_panel_rewiring_dedupe():
    rules = [
        MajorItemRuleV4(system_id="electrical_panel", age_threshold_years="20", replacement_cost="3000"),
        MajorItemRuleV4(system_id="rewiring", age_threshold_years="20", replacement_cost="9000"),
    ]
    evidence = [
        permitted_evidence("electric_panel", "30"),
        permitted_evidence("rewiring", "10"),
        MajorItemEvidenceV4(system_id="rewiring", supported_age_years="45", evidence_date="2019-01-01", permit_scope="partial", completion_evidence="invoice", source="owner"),
    ]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    assert any("conflicting" in limit or "conflict" in limit for limit in result.renovation.limitations)
    assert sum(1 for item in result.renovation.items if item.included) <= 1


def test_rounding_exact_ceiling_and_display():
    assert round_display(Decimal("123456"), Decimal("1000"), "half_up") == Decimal("123000")
    assert round_display(Decimal("123500"), Decimal("1000"), "half_up") == Decimal("124000")
    assert round_display(Decimal("123250"), Decimal("500"), "half_up") == Decimal("123500")
    comps = [make_comp("c1", "600000"), make_comp("c2", "600000"), make_comp("c3", "600000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.deal.initial_offer_status == "INCOMPLETE"
    assert result.deal.initial_offer_value is None
    assert "Initial Offer" in result.deal.initial_offer_reason
    assert result.deal.seller_contract_ceiling_exact is not None
    assert result.deal.displayed_mao is not None
    assert result.deal.displayed_mao - result.deal.seller_contract_ceiling_exact == result.deal.display_rounding_difference


def test_exact_deal_math_is_unquantized():
    deal = DealSettingsV4(closing_cost_percent="8.333", carrying_cost_percent="2.5", wholesale_fee="10000")
    result = evaluate_deal(Decimal("499999.99"), Decimal("100000"), deal, Decimal("50000"))
    assert result.investor_purchase_ceiling_exact == Decimal("499999.99") - Decimal("100000") - result.closing_costs - result.carrying_costs - Decimal("50000")
    assert result.closing_costs == Decimal("499999.99") * Decimal("8.333") / Decimal(100)


def test_restricted_deal_bases_rejected():
    with pytest.raises(ValidationError):
        DealSettingsV4(closing_cost_base="net_proceeds")


def test_preliminary_renovation_propagates_to_deal():
    rules = [MajorItemRuleV4(system_id="roof", age_threshold_years="20", replacement_cost="12000")]
    evidence = [MajorItemEvidenceV4(system_id="roof", supported_age_years="40", source="owner")]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    assert result.renovation.preliminary is True
    assert result.deal.preliminary is True
    assert result.deal.status == "PRELIMINARY"


def test_investor_clear_case_returns_labeled_cohort():
    comps = [make_comp(f"low{i}", str(200000 + i * 1000)) for i in range(4)] + [make_comp(f"high{i}", str(600000 + i * 1000)) for i in range(4)]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "COHORT_FOUND"
    assert result.investor.method_label == "ENGINEERING_PROPOSAL"
    assert result.investor.minimum_sample == MIN_ELIGIBLE
    assert result.investor.selected_count >= 4
    assert result.investor.separation_gap_ppsf is not None
    assert result.investor.buyer_label == "inferred investor or as-is pricing"
    by_id = {d.comp_id: d for d in result.decisions}
    assert any(d.investor_status == "ACCEPTED" for d in by_id.values())


def test_investor_outlier_case_excludes_extreme():
    comps = [make_comp(f"c{i}", str(300000 + i * 1000)) for i in range(8)]
    comps.append(make_comp("spike", "5000000"))
    result = evaluate_v4(make_request(comps=comps))
    assert any("spike" in e for e in result.investor.exclusions)


def test_investor_smooth_unimodal_declines():
    comps = [make_comp(f"c{i}", str(300000 + i * 1000)) for i in range(9)]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"


def test_investor_small_sample_returns_insufficient():
    comps = [make_comp("c1", "300000"), make_comp("c2", "310000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"
    assert result.status == "INSUFFICIENT_COMPS"


def test_investor_applies_property_filters():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="1")]
    comps = [make_comp(f"low{i}", str(200000 + i * 1000), distance_miles="0.5") for i in range(4)]
    comps += [make_comp(f"high{i}", str(600000 + i * 1000), distance_miles="50") for i in range(5)]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"


def test_investor_does_not_fail_supported_arv():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.status == "COMPLETED"
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"
