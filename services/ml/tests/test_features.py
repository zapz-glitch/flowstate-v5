import json
import math

from cdarv.domain.features import (
    FEATURE_NAMES,
    RULE_ECHO_FIELDS,
    extract_comp_features,
    extract_rule_context,
)
from cdarv.reports import parse_report


def _report_and_comp(payload, comp_index=0):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload),
    )
    return report, report.comps[comp_index]


def test_all_features_present_and_float(report_payload):
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    assert set(feats.keys()) == set(FEATURE_NAMES)
    assert all(isinstance(v, float) for v in feats.values())


def test_avm_never_reaches_features(report_payload):
    """Cotality AVM fields must not influence model inputs: stripping the
    avm block must produce byte-identical features."""
    report, comp = _report_and_comp(report_payload)
    with_avm = extract_comp_features(report, comp)

    stripped = json.loads(json.dumps(report_payload))
    del stripped["subject"]["avm"]
    report2 = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(stripped),
    )
    without_avm = extract_comp_features(report2, report2.comps[0])
    assert with_avm == without_avm


def test_rule_echoes_not_in_features(report_payload):
    """Evaluator outputs are diagnostics only — none may appear in inputs."""
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    for name in RULE_ECHO_FIELDS:
        assert name not in feats
    ctx = extract_rule_context(report, comp)
    assert ctx["is_enabled"] is True
    assert ctx["evaluator_selected"] is True
    assert ctx["filter_passed_count"] == 5


def test_distance_and_sale_age(report_payload):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    near = extract_comp_features(report, report.comps[0])
    far = extract_comp_features(report, report.comps[5])
    assert near["distance_miles"] < far["distance_miles"]
    # sale 2026-06-01, report created 2026-09-01 → 92 days
    assert near["sale_age_days"] == 92.0


def test_sqft_diff_math(report_payload):
    report, comp = _report_and_comp(report_payload, 0)
    feats = extract_comp_features(report, comp)
    assert feats["sqft_diff_abs"] == 0.0
    assert feats["sqft_diff_pct"] == 0.0


def test_unknown_stays_unknown(report_payload):
    """Unknown attributes never default to a match."""
    report_payload["comps"]["items"][0]["buildingStyle"] = None
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    assert feats["building_style_known"] == 0.0
    assert feats["building_style_same"] == 0.0


def test_missing_sale_date_is_nan(report_payload):
    report_payload["comps"]["items"][0]["saleDate"] = None
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    assert math.isnan(feats["sale_age_days"])


def test_renovation_target_features(report_payload):
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    assert feats["target_rehab_level_index"] == 2.0
    assert feats["comp_renovated_evidence"] == 1.0
    assert feats["comp_classification_known"] == 1.0
