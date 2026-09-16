import json

import pytest

from cdarv.reports import ReportParseError, parse_report
from conftest import make_report


def _parse(payload, report_id="r1"):
    return parse_report(
        report_id=report_id, user_id="u1", created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload) if isinstance(payload, dict) else payload,
    )


def test_parse_report_pool_and_selection(report_payload):
    report = _parse(report_payload)
    assert len(report.comps) == 8
    selected = [c for c in report.comps if c.evaluator_selected]
    assert len(selected) == 3
    assert all(c.group == "arv" for c in selected)
    assert all(c.in_arv_ids for c in selected)
    assert report.arv == 260000.0
    assert report.completeness == "complete"


def test_transaction_key_pins_sale(report_payload):
    report = _parse(report_payload)
    comp = report.comps[0]
    assert comp.transaction_key == f"{comp.comp_id}|2026-06-01|200000"


def test_provenance_records_rehab_target_and_code_version(report_payload):
    report = _parse(report_payload)
    prov = report.provenance
    assert prov["rehab_level_index"] == 2
    assert prov["rehab_level"] == "Full Cosmetic"
    assert prov["rehab_table_hash"]
    assert prov["evaluation_revision"] == 7
    assert prov["report_created_at"] == "2026-09-01T00:00:00Z"


def test_avm_recorded_as_present_only(report_payload):
    """subject.avm exists in the fixture — provenance notes its presence;
    the value itself is never surfaced for learning."""
    report = _parse(report_payload)
    assert report.provenance["avm_present"] is True
    assert "avm" in report.subject  # preserved verbatim in raw evidence


def test_parse_rejects_bad_json():
    with pytest.raises(ReportParseError):
        _parse("{not json", report_id="bad")


def test_parse_rejects_missing_comps():
    with pytest.raises(ReportParseError):
        _parse({"subject": {}, "comps": {"items": "nope"}}, report_id="bad")


def test_empty_pool_marks_incomplete_not_error():
    """Older reports lacking a candidate pool are incomplete, not crashes —
    we never backfill today's data into a historical evaluation."""
    report = _parse({"subject": {"squareFeet": 1500}, "comps": {"items": []}},
                    report_id="old")
    assert report.completeness == "incomplete"
    assert "no candidate comp pool preserved" in report.completeness_notes


def test_no_enabled_comps_marks_incomplete():
    payload = make_report("r2")
    for item in payload["comps"]["items"]:
        item["isEnabled"] = False
    report = _parse(payload, report_id="r2")
    assert report.completeness == "incomplete"
    assert "no evaluator-enabled comps recorded" in report.completeness_notes


def test_missing_subject_sqft_marks_incomplete():
    payload = make_report("r3")
    del payload["subject"]["squareFeet"]
    report = _parse(payload, report_id="r3")
    assert report.completeness == "incomplete"
    assert "subject square footage missing" in report.completeness_notes


def test_as_is_selection_via_id_list():
    payload = make_report("r4")
    comp = payload["comps"]["items"][4]
    comp["compGroup"] = None
    payload["comps"]["asIsCompIds"] = [comp["id"]]
    report = _parse(payload, report_id="r4")
    target = next(c for c in report.comps if c.comp_id == comp["id"])
    assert target.in_as_is_ids and target.evaluator_selected and target.group is None


def test_content_hash_stable_and_sensitive(report_payload):
    a = _parse(report_payload)
    b = _parse(report_payload)
    assert a.content_hash == b.content_hash
    changed = make_report("r1")
    changed["valuation"]["arv"] = 999999
    c = _parse(changed)
    assert c.content_hash != a.content_hash
