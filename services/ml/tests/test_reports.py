import json

import pytest

from cdarv.reports import ReportParseError, parse_report
from conftest import make_report


def test_parse_report_labels(report_payload):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    assert len(report.comps) == 8
    arv = [c for c in report.comps if c.label_arv]
    assert len(arv) == 3
    assert all(c.label_selected for c in arv)
    assert all(not c.label_as_is for c in report.comps)
    assert report.arv == 260000.0


def test_parse_report_dict_payload(report_payload):
    report = parse_report(
        report_id="r1", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=report_payload,
    )
    assert report.report_id == "r1"
    assert report.raw_json


def test_parse_rejects_bad_json():
    with pytest.raises(ReportParseError):
        parse_report(report_id="bad", user_id="u1", created_at="x", report_json="{not json")


def test_parse_rejects_missing_comps():
    with pytest.raises(ReportParseError):
        parse_report(
            report_id="bad", user_id="u1", created_at="x",
            report_json=json.dumps({"subject": {}, "comps": {"items": "nope"}}),
        )


def test_parse_rejects_empty_pool():
    with pytest.raises(ReportParseError):
        parse_report(
            report_id="bad", user_id="u1", created_at="x",
            report_json=json.dumps({"subject": {}, "comps": {"items": []}}),
        )


def test_as_is_labels_via_id_list():
    payload = make_report("r2")
    comp = payload["comps"]["items"][4]
    comp["compGroup"] = None
    payload["comps"]["asIsCompIds"] = [comp["id"]]
    report = parse_report(
        report_id="r2", user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload),
    )
    target = next(c for c in report.comps if c.comp_id == comp["id"])
    assert target.label_as_is and target.label_selected and not target.label_arv
