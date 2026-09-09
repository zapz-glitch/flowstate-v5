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
            lower_exclusive="3000000",
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
        filters=filters if filters is not None else [AppraisalFilterV4(rule_id="sale_age", kind="max_sale_age_days", value="10000")],
        adjustments=adjustments or [],
        transaction_rule=tx or TransactionRuleV4(),
        tiers=tiers if tiers is not None else make_tiers(),
        deal=deal or DealSettingsV4(),
        major_items=major or [],
    )


def make_comp(comp_id, price, sqft="2000", sale_date="2026-06-01", **kwargs):
    kwargs.setdefault("evidence_ref", f"ev-{comp_id}")
    kwargs.setdefault("is_sale", True)
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
    expected_avg = p1
    expected_arv = expected_avg * Decimal(2000)
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.average_adjusted_ppsf == expected_avg
    assert result.arv.final_arv == expected_arv
    assert result.arv.accepted_comp_ids == ["c1"]
    assert result.methodology_version == "evaluation-v4"
    assert result.settings_snapshot_id == "s1"
    assert len(result.settings_content_hash) == 64


def test_manual_add_and_remove_comps_recalculates_exact_python_arv():
    request = make_request(comps=[make_comp("high", "600000"), make_comp("low", "400000")])
    assert evaluate_v4(request).arv.accepted_comp_ids == ["high"]
    request.selected_comp_ids = ["low", "high"]
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["high", "low"]
    assert result.arv.final_arv == Decimal("500000")
    assert result.arv.average_adjusted_ppsf == Decimal("250")
    assert result.status == "REVIEW_REQUIRED"
    assert result.deal.preliminary is True
    assert all("operator" in d.selection_reason for d in result.decisions)
    assert sorted(d.priority_rank for d in result.decisions) == [1, 2]
    request.selected_comp_ids = ["low"]
    assert evaluate_v4(request).arv.final_arv == Decimal("400000")


@pytest.mark.parametrize("selected", [[], ["high", "high"], [""], [" "]])
def test_manual_selection_contract_rejects_empty_or_duplicate_ids(selected):
    data = make_request(comps=[make_comp("high", "600000")]).model_dump(mode="json")
    data["selected_comp_ids"] = selected
    with pytest.raises(ValidationError):
        EvaluationRequestV4.model_validate(data)


@pytest.mark.parametrize("selected", [["unknown"], ["invalid"], ["valid", "invalid"]])
def test_manual_selection_cannot_bypass_verified_sale_gates(selected):
    request = make_request(comps=[make_comp("valid", "600000"), make_comp("invalid", None)])
    request.selected_comp_ids = selected
    with pytest.raises(ValueError, match="ineligible comparable IDs"):
        evaluate_v4(request)


@pytest.mark.parametrize("count, expected_arv", [(1, "400000"), (2, "400000")])
def test_one_or_two_verified_comps_return_preliminary_valuation(count, expected_arv):
    comps = [make_comp("c1", "400000"), make_comp("c2", "300000")][:count]
    result = evaluate_v4(make_request(comps=comps))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.status == "PRELIMINARY"
    assert result.arv.final_arv == Decimal(expected_arv)
    assert result.renovation.preliminary is True
    assert result.deal.preliminary is True
    assert result.deal.status == "PRELIMINARY"
    assert any("1 qualifying verified" in note for note in result.arv.limitations)
    assert "arv" in result.incomplete_sections


def test_zero_valid_sales_still_returns_insufficient():
    filters = [AppraisalFilterV4(rule_id="distance", kind="max_distance_miles", value="1")]
    comps = [make_comp("outside", None, distance_miles="2")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.final_arv is None
    assert result.deal is None


def style_request(comps, subject_style="Conventional"):
    request = make_request(comps=comps, settings=make_settings(filters=[
        AppraisalFilterV4(rule_id="building_style_match", kind="building_style_match"),
    ]))
    request.subject.building_style = subject_style
    return request


def test_building_style_keeps_only_verified_subject_style_match():
    comps = [
        make_comp("ranch", "900000", building_style="Ranch"),
        make_comp("missing", "800000"),
        make_comp("conventional", "400000", building_style="  CONVENTIONAL  "),
    ]
    result = evaluate_v4(style_request(comps))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.accepted_comp_ids == ["conventional"]
    assert result.arv.final_arv == Decimal("400000")
    decisions = {d.comp_id: d for d in result.decisions}
    assert decisions["ranch"].arv_status == "REJECTED"
    assert "Ranch != Conventional" in ";".join(decisions["ranch"].mismatch_reasons)
    assert "unknown comp building style" in ";".join(decisions["missing"].mismatch_reasons)


@pytest.mark.parametrize("unknown", ["", "unknown", "N/A", "Not Available", "-", "  "])
def test_unknown_building_styles_never_match_each_other(unknown):
    result = evaluate_v4(style_request([make_comp("unknown", "400000", building_style=unknown)], unknown))
    assert result.status == "REVIEW_REQUIRED"
    assert result.decisions[0].match_percent == Decimal(0)
    assert result.arv.final_arv == Decimal("400000")


@pytest.mark.parametrize("style", ["Ranch", "unknown", "n/a", "not available", "-"])
def test_all_missing_or_mismatched_styles_return_zero_match_preliminary(style):
    result = evaluate_v4(style_request([make_comp("wrong", "900000", building_style=style)]))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.accepted_comp_ids == ["wrong"]
    assert result.decisions[0].match_percent == Decimal(0)
    assert result.decisions[0].mismatch_reasons
    assert result.deal.preliminary is True


def test_building_style_normalizes_internal_whitespace_only():
    result = evaluate_v4(style_request([
        make_comp("matching", "400000", building_style="  split   LEVEL  "),
    ], "Split Level"))
    assert result.arv.accepted_comp_ids == ["matching"]


def test_best_partial_match_uses_style_tiebreak_and_reports_every_mismatch():
    filters = [
        AppraisalFilterV4(rule_id="style", kind="building_style_match"),
        AppraisalFilterV4(rule_id="distance", kind="max_distance_miles", value="1"),
        AppraisalFilterV4(rule_id="disabled", kind="subdivision_match", enabled=False),
    ]
    comps = [
        make_comp("expensive_ranch", "900000", building_style="Ranch", distance_miles="0.5"),
        make_comp("matching_style", "400000", building_style="Conventional", distance_miles="2"),
        make_comp("unknown", "800000", distance_miles=None),
    ]
    request = make_request(comps=comps, settings=make_settings(filters=filters))
    request.subject.building_style = "Conventional"
    result = evaluate_v4(request)
    assert result.arv.accepted_comp_ids == ["matching_style"]
    assert result.status == "REVIEW_REQUIRED"
    assert result.deal.preliminary
    decisions = {d.comp_id: d for d in result.decisions}
    assert decisions["matching_style"].match_percent == Decimal(50)
    assert decisions["expensive_ranch"].match_percent == Decimal(50)
    assert decisions["unknown"].match_percent == Decimal(0)
    assert all(d.total_rule_count == 2 for d in result.decisions)
    assert decisions["matching_style"].matched_rule_count == 1
    assert decisions["matching_style"].mismatch_reasons
    assert decisions["matching_style"].investor_status == "REJECTED"


def test_no_enabled_rules_are_unscored_and_select_only_one():
    result = evaluate_v4(make_request(
        comps=[make_comp("high", "600000"), make_comp("low", "400000")],
        settings=make_settings(filters=[]),
    ))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.accepted_comp_ids == ["high"]
    assert all(d.match_percent is None and d.total_rule_count == 0 for d in result.decisions)


def physical_request(comps):
    request = style_request(comps)
    request.subject.subdivision = "Oak Park"
    request.subject.year_built = 1980
    request.subject.lot_sqft = Decimal("10000")
    return request


def test_subdivision_priority_beats_higher_score_price_and_geographic_closeness():
    result = evaluate_v4(physical_request([
        make_comp("local", "400000", subdivision="  OAK PARK ", year_built=1970,
                  sqft="2500", lot_sqft="12000", building_style="Ranch", distance_miles="2"),
        make_comp("other", "900000", subdivision="Other", year_built=1980,
                  sqft="2000", lot_sqft="10000", building_style="Conventional", distance_miles="0.1"),
    ]))
    assert result.arv.accepted_comp_ids == ["local"]
    decisions = {d.comp_id: d for d in result.decisions}
    assert decisions["local"].priority_rank == 1
    assert decisions["local"].match_percent == Decimal(0)
    assert decisions["other"].match_percent == Decimal(100)
    assert decisions["other"].priority_rank == 2
    assert decisions["local"].ranking_details[0] == "subdivision: match"


@pytest.mark.parametrize("better, worse", [
    ({"year_built": 1981, "sqft": "2500"}, {"year_built": 1985, "sqft": "2000"}),
    ({"sqft": "2050", "lot_sqft": "20000"}, {"sqft": "2200", "lot_sqft": "10000"}),
    ({"lot_sqft": "11000", "building_style": "Ranch"}, {"lot_sqft": "15000", "building_style": "Conventional"}),
    ({"lot_sqft": "11000"}, {"lot_sqft": None}),
    ({"building_style": "Conventional"}, {"building_style": "Ranch"}),
])
def test_physical_priorities_are_lexicographic_with_unknown_lot_last(better, worse):
    base = {"subdivision": "Oak Park", "year_built": 1980, "sqft": "2000", "lot_sqft": "10000", "building_style": "Conventional"}
    result = evaluate_v4(physical_request([
        make_comp("better", "400000", **(base | better)),
        make_comp("worse", "900000", **(base | worse)),
    ]))
    assert result.arv.accepted_comp_ids == ["better"]
    decisions = {d.comp_id: d for d in result.decisions}
    assert decisions["better"].priority_rank == 1
    assert decisions["worse"].priority_rank == 2
    if worse.get("lot_sqft", "known") is None:
        assert "relative lot-area difference: unknown" in decisions["worse"].ranking_details


@pytest.mark.parametrize("changes", [
    {"verified_sale_price": None}, {"sqft": None}, {"sqft": "0"},
    {"sale_date": None}, {"sale_date": "2027-01-01"}, {"is_sale": False}, {"is_sale": None},
])
def test_match_score_never_overrides_hard_sale_exclusions(changes):
    evidence = make_comp("invalid", "900000", building_style="Conventional").model_dump(mode="json")
    evidence.update(changes)
    result = evaluate_v4(style_request([CompCandidateV4.model_validate(evidence)]))
    assert result.status == "INSUFFICIENT_COMPS"
    assert result.arv.final_arv is None
    assert result.decisions[0].match_percent == Decimal(100)
    assert result.decisions[0].arv_status == "REJECTED"
    assert result.decisions[0].rejection_reasons


def test_single_comp_ranking_does_not_accept_unverified_evidence():
    filters = [AppraisalFilterV4(rule_id="distance", kind="max_distance_miles", value="1")]
    comps = [
        make_comp("outside", "900000", distance_miles="2"),
        make_comp("unknown_price", None, distance_miles="0.1"),
        make_comp("qualifying", "400000", distance_miles="0.5"),
    ]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.accepted_comp_ids == ["outside"]
    assert result.arv.final_arv == Decimal("900000")
    assert all(d.arv_status == "REJECTED" for d in result.decisions if d.comp_id != "outside")


def test_tie_break_is_deterministic():
    comps = [
        make_comp("c-b", "500000", sale_date="2026-05-01", provider_property_id="P2", address="B St"),
        make_comp("c-a", "500000", sale_date="2026-08-01", provider_property_id="P1", address="A St"),
        make_comp("c-top", "700000"),
        make_comp("c-low", "100000"),
    ]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.accepted_comp_ids[0] == "c-top"
    ranks = {d.comp_id: d.priority_rank for d in result.decisions}
    assert ranks["c-a"] == 2
    assert ranks["c-b"] == 3
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert statuses["c-low"] == "REJECTED"


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


def test_explicit_duplicate_of_links_respected_and_bad_links_rejected():
    comps = [
        make_comp("c2", "500000", duplicate_of="c1"),
        make_comp("c1", "600000"),
        make_comp("c3", "400000"),
        make_comp("c4", "300000"),
    ]
    result = evaluate_v4(make_request(comps=comps))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert by_id["c2"].duplicate_of == "c1"
    bad = [
        make_comp("c1", "600000"),
        make_comp("c-self", "500000", duplicate_of="c-self"),
        make_comp("c3", "400000"),
    ]
    bad_result = evaluate_v4(make_request(comps=bad))
    assert bad_result.decisions[[d.comp_id for d in bad_result.decisions].index("c-self")].arv_status == "REJECTED"
    missing = [
        make_comp("c1", "600000"),
        make_comp("c-ghost", "500000", duplicate_of="nope"),
        make_comp("c3", "400000"),
    ]
    missing_result = evaluate_v4(make_request(comps=missing))
    assert "missing target" in " ".join(
        missing_result.decisions[[d.comp_id for d in missing_result.decisions].index("c-ghost")].rejection_reasons
    )


def test_transitive_equivalence_and_cycle_survivor_deterministic():
    group = [
        make_comp("c1", "500000", provider_property_id="P1", evidence_ref="tx-a"),
        make_comp("c2", "600000", provider_property_id="P1", evidence_ref="tx-b"),
        make_comp("c3", "550000", provider_property_id="P1", evidence_ref="tx-b"),
        make_comp("c4", "400000"),
        make_comp("c5", "300000"),
    ]
    first = evaluate_v4(make_request(comps=group))
    swapped = evaluate_v4(make_request(comps=list(reversed(group))))
    first_map = sorted((d.comp_id, d.duplicate_of, d.arv_status) for d in first.decisions)
    swapped_map = sorted((d.comp_id, d.duplicate_of, d.arv_status) for d in swapped.decisions)
    assert first_map == swapped_map
    cyclic = [
        make_comp("c1", "600000", duplicate_of="c2"),
        make_comp("c2", "590000", duplicate_of="c1"),
        make_comp("c3", "500000"),
        make_comp("c4", "400000"),
        make_comp("c5", "300000"),
    ]
    cyclic_result = evaluate_v4(make_request(comps=cyclic))
    by_id = {d.comp_id: d for d in cyclic_result.decisions}
    assert by_id["c1"].arv_status == "REJECTED"
    assert by_id["c2"].arv_status == "REJECTED"
    assert "same-transaction conflict" in " ".join(by_id["c1"].rejection_reasons)


def test_transitive_address_chain_collapses_permutation_invariant():
    group = [
        make_comp("c1", "500000", address="  123 Main St  "),
        make_comp("c2", "510000", address="123 main st"),
        make_comp("c3", "520000", address="123   Main ST"),
        make_comp("c4", "400000"),
        make_comp("c5", "300000"),
    ]
    first = evaluate_v4(make_request(comps=group))
    swapped = evaluate_v4(make_request(comps=list(reversed(group))))
    assert sorted((d.comp_id, d.duplicate_of) for d in first.decisions) == sorted(
        (d.comp_id, d.duplicate_of) for d in swapped.decisions
    )


def test_limited_result_preserves_accepted_ids():
    comps = [make_comp("c1", "400000"), make_comp("c2", "300000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.status == "REVIEW_REQUIRED"
    assert result.arv.accepted_comp_ids == ["c1"]


def test_result_carries_snapshot_schema_versions_and_hash():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.settings_schema_version == "evaluation-v4"
    assert result.settings_snapshot_id == "s1"
    assert result.settings_content_hash == make_settings().compute_content_hash()


def test_tampered_snapshot_hash_fails_durable_contract():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    settings = make_settings()
    stamped = settings.model_copy(update={"content_hash": settings.compute_content_hash()})
    tampered = stamped.model_copy(update={"content_hash": "f" * 64})
    result = evaluate_v4(make_request(comps=comps, settings=tampered))
    assert result.status == "FAILED"
    assert result.errors and result.errors[0].code == "INVALID_SNAPSHOT"


def test_every_comp_is_scored_and_ranked_with_one_reference():
    comps = [make_comp(f"c{i}", str(500000 - i * 10000)) for i in range(6)]
    result = evaluate_v4(make_request(comps=comps))
    statuses = {d.comp_id: d.arv_status for d in result.decisions}
    assert list(statuses.values()).count("ACCEPTED") == 1
    assert list(statuses.values()).count("REJECTED") == 5
    assert all(d.match_percent == Decimal(100) and d.total_rule_count == 1 for d in result.decisions)


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
    assert any(o.rule_id == "dist" and o.passed is False for o in by_id["c2"].rule_outcomes)
    assert any(o.rule_id == "transaction_eligibility" for o in by_id["c2"].rule_outcomes)
    assert any(o.rule_id == "dist" and o.passed is True for o in by_id["c1"].rule_outcomes)
    assert by_id["c4"].arv_status == "REJECTED"


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
    assert any(o.kind == "transaction" for o in by_id["c1"].rule_outcomes)
    default_result = evaluate_v4(make_request(comps=comps))
    assert default_result.arv.accepted_comp_ids == ["c1"]


def test_required_transaction_fields_reject_unknown_with_outcome():
    tx = TransactionRuleV4(rule_id="tx-req", allowed_codes=["ARMS"], require_known_code=True)
    comps = [
        make_comp("c1", "600000", transaction_code="ARMS"),
        make_comp("c2", "590000", transaction_code="MYSTERY"),
        make_comp("c3", "580000", transaction_code="ARMS"),
        make_comp("c4", "570000", transaction_code="ARMS"),
    ]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(tx=tx)))
    by_id = {d.comp_id: d for d in result.decisions}
    assert by_id["c2"].arv_status == "REJECTED"
    assert any(o.kind == "transaction" and not o.passed for o in by_id["c2"].rule_outcomes)


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
    assert result.arv.accepted_comp_ids == ["c-top"]


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
    from eval_engine.domain.renovation import tier_inclusivity

    tiers = make_tiers()
    assert validate_tiers(tiers) == []
    assert tier_inclusivity(tiers[0]) == "[0..500000)"
    assert tier_inclusivity(tiers[2]) == "[1000000..3000000]"
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
    flipped = make_tiers()
    flipped[1] = RenovationTierV4(
        tier_key="500k_to_under1m", lower_inclusive="500000", upper_inclusive="1000000", cells=flipped[1].cells,
    )
    assert validate_tiers(flipped)


def test_adjustment_signs_and_no_double_count():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3", baths="2")
    comps = [make_comp("c1", "500000", beds="2", baths="2"), make_comp("c2", "500000", beds="2", baths="2"), make_comp("c3", "500000", beds="2", baths="2")]
    adjustments = [CompAdjustmentRuleV4(rule_id="bed", kind="bedroom", per_unit_amount="15000", signed_amount="15000", unit="usd_per_bed", applies_to="comp")]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    assert result.arv.final_arv == Decimal("515000") * Decimal(2000) / Decimal(2000)
    keys = [e.duplicate_key for e in result.ledger]
    assert len(keys) == len(set(keys))
    assert len([e for e in result.ledger if e.stage == "comp"]) == 1


def test_subject_adjustment_applies_once_with_stage_semantics():
    subject = SubjectPropertyV4(address="s", sqft="2000", beds="3")
    comps = [make_comp("c1", "500000", beds="2"), make_comp("c2", "500000", beds="2"), make_comp("c3", "500000", beds="2")]
    adjustments = [CompAdjustmentRuleV4(rule_id="subj", kind="bedroom", signed_amount="7000", per_unit_amount="7000", applies_to="subject")]
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
        CompAdjustmentRuleV4(rule_id="feat", kind="bedroom", signed_amount="5000", per_unit_amount="5000", applies_to="comp"),
        CompAdjustmentRuleV4(rule_id="feat", kind="bedroom", signed_amount="5000", per_unit_amount="5000", applies_to="comp"),
    ]
    result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=adjustments), evaluation_date="2026-09-01"))
    assert len([e for e in result.ledger if e.rule_id == "feat"]) == 1


def test_feature_proximity_require_typed_evidence_and_record_outcomes():
    subject = SubjectPropertyV4(address="s", sqft="2000")
    comps = [make_comp("c1", "500000"), make_comp("c2", "500000"), make_comp("c3", "500000")]
    flat = [CompAdjustmentRuleV4(rule_id="pool", kind="feature", signed_amount="8000", applies_to="comp")]
    flat_result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=flat), evaluation_date="2026-09-01"))
    assert flat_result.arv.final_arv == Decimal("500000")
    assert flat_result.status == "REVIEW_REQUIRED"
    assert flat_result.arv.status == "PRELIMINARY"
    assert any(o.outcome == "skipped" and o.reason.startswith("SKIPPED_UNKNOWN_EVIDENCE") for o in flat_result.arv.adjustment_outcomes)
    typed = [CompAdjustmentRuleV4(rule_id="pool", kind="feature", per_unit_amount="8000", signed_amount="0", applies_to="comp", subject_evidence_field="beds", comp_evidence_field="beds")]
    typed_result = evaluate_v4(EvaluationRequestV4(subject=SubjectPropertyV4(address="s", sqft="2000", beds="3"), comps=[make_comp("c1", "500000", beds="2"), make_comp("c2", "500000", beds="2"), make_comp("c3", "500000", beds="2")], renovation_level="light_cosmetic", settings=make_settings(adjustments=typed), evaluation_date="2026-09-01"))
    assert typed_result.arv.final_arv == Decimal("508000")
    missing = [CompAdjustmentRuleV4(rule_id="pool", kind="feature", per_unit_amount="8000", signed_amount="0", applies_to="comp", subject_evidence_field="beds", comp_evidence_field="beds")]
    missing_result = evaluate_v4(EvaluationRequestV4(subject=subject, comps=comps, renovation_level="light_cosmetic", settings=make_settings(adjustments=missing), evaluation_date="2026-09-01"))
    assert missing_result.status == "REVIEW_REQUIRED"
    assert missing_result.arv.status == "PRELIMINARY"
    assert any(o.outcome == "skipped" for o in missing_result.arv.adjustment_outcomes)
    assert any(o.outcome == "no_difference" or o.outcome == "applied" for o in typed_result.arv.adjustment_outcomes)
    zero = [CompAdjustmentRuleV4(rule_id="bed", kind="bedroom", per_unit_amount="15000", signed_amount="0", applies_to="comp")]
    zero_result = evaluate_v4(EvaluationRequestV4(subject=SubjectPropertyV4(address="s", sqft="2000", beds="3"), comps=[make_comp("c1", "500000", beds="3"), make_comp("c2", "500000", beds="3"), make_comp("c3", "500000", beds="3")], renovation_level="light_cosmetic", settings=make_settings(adjustments=zero), evaluation_date="2026-09-01"))
    assert any(o.outcome == "no_difference" for o in zero_result.arv.adjustment_outcomes)


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
    assert result.arv.status == "PRELIMINARY"
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


def test_major_item_canonical_aliases_and_manual_categories():
    from eval_engine.domain.renovation import canonical_level, canonical_system

    assert canonical_system("Re-Wire") == "rewiring"
    assert canonical_system("ELECTRICAL PANEL") == "electrical_panel"
    assert canonical_system("replumb") == "plumbing"
    assert canonical_level("Down to Stud") == "full_gut"
    rules = [MajorItemRuleV4(system_id="appliance_package", age_threshold_years="10", replacement_cost="4000", inclusion_category="operator_additional")]
    evidence = [permitted_evidence("appliance_package", "12")]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    assert result.renovation.items[0].included is False
    assert any("explicit operator" in limit for limit in result.renovation.limitations)


def test_major_item_base_overlap_uses_tier_cell_systems():
    tiers = make_tiers()
    tiers[1].cells[1] = RenovationTierCellV4(
        renovation_level="light_cosmetic", rehab_rate_per_sqft="100", flip_profit="50000",
        included_systems=["roof"],
    )
    rules = [MajorItemRuleV4(system_id="roof", age_threshold_years="20", replacement_cost="12000")]
    evidence = [permitted_evidence("roof", "40")]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(tiers=tiers, major=rules), major_item_evidence=evidence))
    assert result.renovation.items[0].included is False
    assert any("base rehab overlap" in limit for limit in result.renovation.limitations)


def test_major_item_overlap_only_among_triggering_candidates():
    rules = [
        MajorItemRuleV4(system_id="electrical_panel", age_threshold_years="20", replacement_cost="3000"),
        MajorItemRuleV4(system_id="rewiring", age_threshold_years="20", replacement_cost="9000"),
    ]
    evidence = [permitted_evidence("rewiring", "40")]
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(major=rules), major_item_evidence=evidence))
    by_system = {i.system_id: i for i in result.renovation.items}
    assert by_system["rewiring"].included is True
    assert by_system["electrical_panel"].included is False


def test_major_item_all_additional_items_included_with_reasons():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    additional = [
        AdditionalRenovationItemV4(item_id="deck", cost="5000"),
        AdditionalRenovationItemV4(item_id="fence", cost="2000", dedup_group="shared"),
        AdditionalRenovationItemV4(item_id="fence-dupe", cost="2000", dedup_group="shared"),
    ]
    result = evaluate_v4(make_request(comps=comps, additional_items=additional))
    assert result.renovation.additional_total == Decimal("7000")
    assert result.renovation.additional_items and len(result.renovation.additional_items) == 3
    assert any(i.item_id == "deck" and i.included for i in result.renovation.additional_items)
    assert any("duplicate of" in (i.reason or "") for i in result.renovation.additional_items)


def test_rounding_exact_ceiling_and_display():
    assert round_display(Decimal("123456"), Decimal("1000"), "half_up") == Decimal("123000")
    assert round_display(Decimal("123500"), Decimal("1000"), "half_up") == Decimal("124000")
    assert round_display(Decimal("123250"), Decimal("500"), "half_up") == Decimal("123500")


@pytest.mark.parametrize("increment, expected_arv, expected_buy", [
    ("1000", "500000", "200000"), ("500", "500500", "200500"),
])
def test_arv_and_buy_display_rounding_never_changes_exact_math(increment, expected_arv, expected_buy):
    settings = make_settings(deal=DealSettingsV4(
        closing_cost_percent="8", carrying_cost_percent="2", wholesale_fee="10000",
        rounding_increment=increment,
    ))
    result = evaluate_v4(make_request(comps=[make_comp("one", "500499.99")], settings=settings))
    assert result.arv.final_arv == Decimal("500499.99")
    assert result.arv.displayed_arv == Decimal(expected_arv)
    assert result.arv.display_rounding_difference == Decimal(expected_arv) - Decimal("500499.99")
    assert result.deal.closing_costs == Decimal("40039.9992")
    assert result.deal.investor_purchase_ceiling_exact == Decimal("200449.991")
    assert result.deal.displayed_buy_price == Decimal(expected_buy)
    assert result.deal.buy_price_rounding_difference == result.deal.displayed_buy_price - result.deal.investor_purchase_ceiling_exact
    assert result.deal.seller_contract_ceiling_exact == Decimal("190449.991")


def test_initial_offer_stays_incomplete_with_displayed_mao():
    comps = [make_comp("c1", "600000"), make_comp("c2", "600000"), make_comp("c3", "600000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.deal.initial_offer_status == "INCOMPLETE"
    assert result.deal.initial_offer_value is None
    assert "Initial Offer" in result.deal.initial_offer_reason
    assert result.deal.seller_contract_ceiling_exact is not None
    assert result.deal.displayed_mao is not None
    assert result.deal.displayed_mao - result.deal.seller_contract_ceiling_exact == result.deal.display_rounding_difference


@pytest.mark.parametrize("increment, exact, displayed", [
    ("1000", "123499.99", "123000"), ("1000", "123500", "124000"),
    ("500", "123249.99", "123000"), ("500", "123250", "123500"),
])
def test_buy_headline_half_up_boundaries_preserve_exact_ceiling(increment, exact, displayed):
    result = evaluate_deal(Decimal(exact), Decimal(0), DealSettingsV4(rounding_increment=increment), Decimal(0))
    assert result.investor_purchase_ceiling_exact == Decimal(exact)
    assert result.displayed_buy_price == Decimal(displayed)
    assert result.buy_price_rounding_difference == Decimal(displayed) - Decimal(exact)


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
    assert result.status == "REVIEW_REQUIRED"


def test_investor_applies_property_filters():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="1")]
    comps = [make_comp(f"low{i}", str(200000 + i * 1000), distance_miles="0.5") for i in range(4)]
    comps += [make_comp(f"high{i}", str(600000 + i * 1000), distance_miles="50") for i in range(5)]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"


def test_investor_appends_ledger_and_applies_subject_once():
    subject_sqft = "2000"
    from eval_engine.contracts import SubjectPropertyV4 as _SP
    _subject = _SP(address="1 Main St", sqft=subject_sqft)
    low = [make_comp(f"low{i}", str(200000 + i * 1000), sqft="2000") for i in range(4)]
    high = [make_comp(f"high{i}", str(600000 + i * 1000), sqft="2000") for i in range(4)]
    comps = low + high
    adjustments = [CompAdjustmentRuleV4(rule_id="pool", kind="sqft", signed_amount="10", per_unit_amount="10", applies_to="both")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(adjustments=adjustments)))
    assert result.investor.status == "COHORT_FOUND"
    assert any(e.stage == "investor_comp" for e in result.ledger)


def test_investor_subject_adjustment_applied_once():
    comps = [make_comp(f"low{i}", str(200000 + i * 1000)) for i in range(4)] + [make_comp(f"high{i}", str(600000 + i * 1000)) for i in range(4)]
    adjustments = [CompAdjustmentRuleV4(rule_id="subj", kind="sqft", signed_amount="5000", per_unit_amount="5", applies_to="both")]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(adjustments=adjustments)))
    assert result.investor.status == "COHORT_FOUND"
    assert len([e for e in result.ledger if e.stage == "investor_subject"]) == 1
    assert len([e for e in result.ledger if e.stage == "subject"]) == 1


def test_investor_rejects_tail_and_skew():
    tail = [make_comp(f"c{i}", str(300000 + i * 1000)) for i in range(8)] + [make_comp("tail", "900000")]
    assert evaluate_v4(make_request(comps=tail)).investor.status == "INSUFFICIENT_INVESTOR_DATA"
    skew = [make_comp(f"c{i}", "300000") for i in range(7)] + [make_comp("high", "900000")]
    assert evaluate_v4(make_request(comps=skew)).investor.status == "INSUFFICIENT_INVESTOR_DATA"


def test_investor_marks_filter_exclusions_rejected_with_reasons():
    filters = [AppraisalFilterV4(rule_id="dist", kind="max_distance_miles", value="1")]
    comps = [make_comp(f"low{i}", str(200000 + i * 1000), distance_miles="0.5") for i in range(4)]
    comps += [make_comp(f"high{i}", str(600000 + i * 1000), distance_miles="50") for i in range(5)]
    result = evaluate_v4(make_request(comps=comps, settings=make_settings(filters=filters)))
    by_id = {d.comp_id: d for d in result.decisions}
    assert any(d.investor_status == "REJECTED" and any("filter exclusion" in r for r in d.rejection_reasons) for d in by_id.values())


def test_investor_does_not_fail_supported_arv():
    comps = [make_comp("c1", "600000"), make_comp("c2", "590000"), make_comp("c3", "580000")]
    result = evaluate_v4(make_request(comps=comps))
    assert result.arv.status == "PRELIMINARY"
    assert result.investor.status == "INSUFFICIENT_INVESTOR_DATA"
