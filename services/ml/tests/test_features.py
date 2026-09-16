import json
import math

from cdarv.features import FEATURE_NAMES, extract_comp_features
from cdarv.reports import parse_report


def _report_and_comp(payload, comp_index=0):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload),
    )
    return report, report.comps[comp_index]


def test_all_features_present(report_payload):
    report, comp = _report_and_comp(report_payload)
    feats = extract_comp_features(report, comp)
    assert set(feats.keys()) == set(FEATURE_NAMES)
    assert all(isinstance(v, float) for v in feats.values())


def test_distance_and_selection_features(report_payload):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    near = extract_comp_features(report, report.comps[0])
    far = extract_comp_features(report, report.comps[5])
    assert near["distance_miles"] < far["distance_miles"]
    assert near["is_enabled"] == 1.0


def test_sqft_diff_math(report_payload):
    report, comp = _report_and_comp(report_payload, 0)
    feats = extract_comp_features(report, comp)
    # comp 1500 sqft, subject 1500
    assert feats["sqft_diff"] == 0.0
    assert feats["sqft_diff_pct"] == 0.0


def test_sale_age_uses_report_created_at(report_payload):
    report, comp = _report_and_comp(report_payload, 0)
    feats = extract_comp_features(report, comp)
    # sale 2026-06-01, report created 2026-09-01 → 92 days
    assert feats["sale_age_days"] == 92.0


def test_filter_scores_encoded(report_payload):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    passed = extract_comp_features(report, report.comps[0])
    assert passed["f_subdivision_match"] == 1.0
    assert passed["filters_passed_count"] == 5.0
    # filters absent from fixture for unmatched types → unverified
    assert passed["f_road_barrier"] == 0.0

    report_payload["comps"]["items"][5]["appraisalRules"]["filters"][0] = {
        "type": "subdivision_match", "passed": False, "status": "failed",
    }
    report2 = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    failed = extract_comp_features(report2, report2.comps[5])
    assert failed["f_subdivision_match"] == -1.0


def test_missing_fields_become_nan(report_payload):
    report_payload["comps"]["items"][0]["distanceMiles"] = None
    report_payload["comps"]["items"][0]["salePrice"] = None
    report, comp = _report_and_comp(report_payload, 0)
    feats = extract_comp_features(report, comp)
    assert math.isnan(feats["distance_miles"])
    assert math.isnan(feats["sale_price_log"])


def test_labels_not_in_features():
    """Post-selection fields must never leak into the feature contract."""
    assert "comp_group" not in FEATURE_NAMES
    assert "is_best_match" not in FEATURE_NAMES
    assert not any(n.startswith("label_") for n in FEATURE_NAMES)
    assert not any(n.startswith("arv") for n in FEATURE_NAMES)
