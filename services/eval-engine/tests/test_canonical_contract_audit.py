"""Canonical ARV contract audit fixtures (A-E).

Owner contract under test:
  - Candidates ordered by VERIFIED SALE PRICE DESCENDING.
  - Walk downward; accept first 3 DISTINCT valid ARV comps.
  - Everything after the 3rd acceptance is NOT_EXAMINED_FOR_ARV.
  - No 90% price band, no proximity-first reorder, no hidden weighting.
  - adjusted_ppsf = (verified_price + signed comp adjustments) / comp_sqft
  - base_arv = mean(adjusted_ppsf) * subject_sqft; final = base + subject adj.
  - Decimal internally; round at presentation only; no mean-price fallback.

These fixtures DOCUMENT actual V4 behavior vs the contract. They assert the
observed behavior so the audit output is machine-checkable; expected-contract
values are stated in comments/assert messages, not silently assumed.
"""

from __future__ import annotations

import json
from decimal import Decimal

from eval_engine.contracts.deal import (
    EvaluationRequestV4,
    EvaluationResultV4,
)
from eval_engine.contracts.filters import AppraisalFilterV4
from eval_engine.contracts.settings import (
    DealSettingsV4,
    RenovationTierCellV4,
    RenovationTierV4,
    SettingsSnapshotV4,
)
from eval_engine.contracts.comps import CompCandidateV4
from eval_engine.contracts.subject import SubjectPropertyV4
from eval_engine.domain.evaluate import evaluate_v4

EVAL_DATE = "2026-09-01"
SALE_DATE = "2026-08-01"  # age = 31 days, well inside 180d

CANONICAL_SELECTED = ["c-high", "c-mid", "c-low"]
CANONICAL_ARV = Decimal("375000")  # mean(250,250,250) * 1500


def _subject() -> dict:
    return {
        "subject_id": "subj-1",
        "address": "100 Main St",
        "city": "Austin",
        "state": "TX",
        "zip": "78701",
        "property_type": "Single Family",
        "building_style": "Ranch",
        "garage_spaces": 2,
        "beds": "3",
        "baths": "2",
        "sqft": "1500",
        "lot_sqft": "7000",
        "year_built": 2000,
        "subdivision": "Test Heights",
    }


def _comp(comp_id: str, price: str, sqft: str, address: str) -> dict:
    return {
        "comp_id": comp_id,
        "provider_property_id": f"prov-{comp_id}",
        "address": address,
        "verified_sale_price": price,
        "sale_date": SALE_DATE,
        "sqft": sqft,
        "lot_sqft": "7000",
        "beds": "3",
        "baths": "2",
        "year_built": 2000,
        "property_type": "Single Family",
        "building_style": "Ranch",
        "garage_spaces": 2,
        "distance_miles": "0.3",
        "evidence_ref": f"tx-{comp_id}",
        "is_sale": True,
        "subdivision": "Test Heights",
    }


def _comps(price_override: dict[str, str] | None = None) -> list[dict]:
    prices = {"c-high": "350000", "c-mid": "337500", "c-low": "325000"}
    if price_override:
        prices.update(price_override)
    return [
        _comp("c-high", prices["c-high"], "1400", "1 High Ln"),   # ppsf 250
        _comp("c-mid", prices["c-mid"], "1350", "2 Mid Ln"),      # ppsf 250
        _comp("c-low", prices["c-low"], "1300", "3 Low Ln"),      # ppsf 250
        # A 4th, lower-priced candidate: canonical contract says it is
        # never reached once 3 accept -> NOT_EXAMINED_FOR_ARV.
        _comp("c-extra", "300000", "1200", "4 Low Ln"),           # ppsf 250
    ]


def _filters() -> list[AppraisalFilterV4]:
    return [
        AppraisalFilterV4(rule_id="f_age", kind="max_sale_age_days", value=Decimal("180")),
        AppraisalFilterV4(rule_id="f_sqft", kind="max_sqft_diff", value=Decimal("250")),
        AppraisalFilterV4(rule_id="f_year", kind="max_year_built_diff", value=Decimal("10")),
        AppraisalFilterV4(rule_id="f_dist", kind="max_distance_miles", value=Decimal("1")),
        AppraisalFilterV4(rule_id="f_type", kind="property_type_match"),
        AppraisalFilterV4(rule_id="f_style", kind="building_style_match"),
        AppraisalFilterV4(rule_id="f_subdiv", kind="subdivision_match"),
    ]


def _tiers() -> list[RenovationTierV4]:
    cells = [
        RenovationTierCellV4(
            renovation_level=level,
            rehab_rate_per_sqft=Decimal("50"),
            flip_profit=Decimal("25000"),
        )
        for level in ("lipstick", "light_cosmetic", "full_cosmetic", "heavy_rehab", "full_gut")
    ]
    return [
        RenovationTierV4(tier_key="under500k", lower_inclusive=Decimal("0"), upper_exclusive=Decimal("500000"), cells=cells),
        RenovationTierV4(tier_key="500k_to_under1m", lower_inclusive=Decimal("500000"), upper_exclusive=Decimal("1000000"), cells=cells),
        RenovationTierV4(tier_key="1m_to_3m", lower_inclusive=Decimal("1000000"), upper_inclusive=Decimal("3000000"), cells=cells),
        RenovationTierV4(tier_key="over3m", lower_exclusive=Decimal("3000000"), cells=cells),
    ]


def _request(policy: str, price_override: dict[str, str] | None = None) -> EvaluationRequestV4:
    settings = SettingsSnapshotV4(
        snapshot_id="snap-audit-1",
        filters=_filters(),
        adjustments=[],
        tiers=_tiers(),
        deal=DealSettingsV4(),
        arv_selection_policy=policy,
    )
    return EvaluationRequestV4(
        subject=SubjectPropertyV4(**_subject()),
        comps=[CompCandidateV4(**c) for c in _comps(price_override)],
        renovation_level="full_cosmetic",
        settings=settings,
        evaluation_date=EVAL_DATE,
    )


def _summary(result: EvaluationResultV4) -> dict:
    return {
        "status": result.status,
        "arv_status": result.arv.status if result.arv else None,
        "accepted": result.arv.accepted_comp_ids if result.arv else [],
        "exact_value": result.arv.exact_value if result.arv else "",
        "final_arv": str(result.arv.final_arv) if result.arv and result.arv.final_arv is not None else None,
        "statuses": {d.comp_id: d.arv_status for d in result.decisions},
        "weights": {k: str(v) for k, v in (result.arv.comp_weights.items() if result.arv else [])},
    }


# ── Fixture A: canonical expected outcome vs actual per policy ────────────

def test_a_canonical_expectation_vs_actual():
    """Contract expects [c-high,c-mid,c-low] accepted, ARV exactly 375000."""
    for policy in ("legacy_physical_v1", "upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"):
        result = evaluate_v4(_request(policy))
        s = _summary(result)
        print(f"\n[A] policy={policy}: {json.dumps(s, default=str)}")
        # Numeric ARV coincides (all adjusted PPSF = 250) — the deviation is
        # in WHICH comps were accepted and the examination semantics.
        assert s["exact_value"] == "375000", f"{policy}: ARV {s['exact_value']} != 375000"
        # Contract deviation evidence: fewer than 3 accepted under every policy.
        assert len(s["accepted"]) < 3, f"{policy}: unexpectedly canonical"
        # Contract requires c-extra to be NOT_EXAMINED_FOR_ARV once 3 accept;
        # V4 never emits that status at all.
        assert "NOT_EXAMINED_FOR_ARV" not in s["statuses"].values()


# ── Fixture B: repeated identical runs are identical ──────────────────────

def test_b_repeat_runs_identical():
    for policy in ("legacy_physical_v1", "upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"):
        first = evaluate_v4(_request(policy))
        second = evaluate_v4(_request(policy))
        a, b = _summary(first), _summary(second)
        assert a["accepted"] == b["accepted"], f"{policy}: selected IDs differ across runs"
        assert a["exact_value"] == b["exact_value"], f"{policy}: ARV differs across runs"
        assert first.model_dump(mode="json") == second.model_dump(mode="json"), f"{policy}: full result differs"


# ── Fixture C: save -> load with unchanged inputs preserves exact result ──

def test_c_save_load_roundtrip():
    """Persisted payload (model_dump json) -> revalidated -> identical bytes."""
    for policy in ("legacy_physical_v1", "upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"):
        result = evaluate_v4(_request(policy))
        stored = result.model_dump(mode="json")
        loaded = EvaluationResultV4.model_validate(stored)
        assert loaded.model_dump(mode="json") == stored, f"{policy}: load changed the stored result"
        assert loaded.arv.exact_value == result.arv.exact_value


# ── Fixture D: recalculation from serialized request gives identical result ─

def test_d_recalc_identical_inputs():
    for policy in ("legacy_physical_v1", "upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"):
        original = evaluate_v4(_request(policy))
        # Rebuild the request purely from its serialized form (the stored
        # payload path used by worker/service.py).
        req = _request(policy)
        rebuilt = EvaluationRequestV4.model_validate(req.model_dump(mode="json"))
        recalc = evaluate_v4(rebuilt)
        assert recalc.arv.accepted_comp_ids == original.arv.accepted_comp_ids
        assert recalc.arv.exact_value == original.arv.exact_value
        assert recalc.model_dump(mode="json") == original.model_dump(mode="json")


# ── Fixture E: one changed input -> changed, attributable result ──────────

def test_e_changed_input_attributable():
    """Raise the top comp's verified price 350000 -> 355000.

    Expected under contract: ppsf 253.571428..., mean = (250+250+253.571..)/3,
    ARV = 376785.71... Under V4 the delta must still be attributable to c-high.
    """
    for policy in ("legacy_physical_v1", "upper_half_rule_weighted_v1", "provider_authoritative_upper_half_v2"):
        base = evaluate_v4(_request(policy))
        changed = evaluate_v4(_request(policy, price_override={"c-high": "355000"}))
        bs, cs = _summary(base), _summary(changed)
        print(f"\n[E] policy={policy}: base={bs['exact_value']} changed={cs['exact_value']} accepted={cs['accepted']}")
        assert cs["exact_value"] != bs["exact_value"], f"{policy}: price change on selected comp produced no ARV change"
        # The change is attributable: c-high is in the accepted set and its
        # adjusted PPSF moved.
        assert "c-high" in cs["accepted"]
        dec = {d.comp_id: d for d in changed.decisions}
        assert dec["c-high"].arv_status == "ACCEPTED"
