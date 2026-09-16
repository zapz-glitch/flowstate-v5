"""Shadow scoring: eligibility gate, insufficient evidence, recalc call."""

import json

import pytest
from sqlalchemy import select

import cdarv.domain.shadow as shadow
from cdarv.domain.datasets import build_dataset
from cdarv.domain.submissions import submit_report
from cdarv.domain.training import train_model
from cdarv.persistence.models import Prediction
from conftest import approve_review, make_report, submit_payload


@pytest.fixture
def trained(session):
    for i in range(6):
        snap, _ = submit_payload(
            session, f"r{i}", created_at=f"2026-0{(i % 8) + 1}-15T00:00:00Z")
        approve_review(session, snap)
    dataset = build_dataset(session, name="d", created_by="test", seed=42)
    return train_model(session, dataset_id=dataset.id, name="baseline")


def _fake_recalc(arv=270000):
    def _fn(report_id, comp_ids):
        return {"valuation": {"arv": arv, "arvPerSqft": 180},
                "comps": {"afterRenovationCompIds": comp_ids}}
    return _fn


def _submit_payload(session, report_id, payload):
    return submit_report(
        session, report_id=report_id, user_id="u1",
        created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload), submitted_by="test",
    )


def test_shadow_scores_and_calls_production_recalc(session, trained, monkeypatch):
    calls = []

    def _spy(rid, ids):
        calls.append((rid, ids))
        return _fake_recalc()(rid, ids)

    monkeypatch.setattr(shadow, "_recalc", _spy)
    snap, _ = submit_payload(session, "live-1")
    pred = shadow.score_snapshot(session, snapshot=snap, model_row=trained)

    assert pred.status == "scored"
    assert pred.shadow_arv == 270000
    assert len(pred.selected_comp_ids) == 3
    assert calls and calls[0][0] == "live-1"
    assert set(pred.selected_comp_ids) == set(calls[0][1])
    assert pred.input_hash == snap.content_hash


def test_shadow_only_ranks_eligible_comps(session, trained, monkeypatch):
    """The model can never make an ineligible comp eligible.

    Eligibility = the production recalc contract (passedFilters !== false
    AND positive price), which is what the recalc callback will accept.
    """
    monkeypatch.setattr(shadow, "_recalc", _fake_recalc())
    payload = make_report("live-2")
    for i, item in enumerate(payload["comps"]["items"]):
        if i >= 4:
            item["isEnabled"] = False
            item["appraisalRules"]["passedFilters"] = False
    snap, _ = _submit_payload(session, "live-2", payload)
    pred = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    eligible_ids = {f"live-2-c{i}" for i in range(4)}
    assert set(pred.selected_comp_ids) <= eligible_ids
    assert set(pred.scores_json.keys()) <= eligible_ids


def test_shadow_enabled_but_rules_failed_is_not_rankable(session, trained, monkeypatch):
    """Real reports carry isEnabled=true with passedFilters=false (pipeline
    fallback tiers / manual enables). recalculateReport rejects those comps,
    so they are NOT shadow-eligible even though the pipeline enabled them."""
    monkeypatch.setattr(shadow, "_recalc", _fake_recalc())
    payload = make_report("live-2b")
    for i, item in enumerate(payload["comps"]["items"]):
        item["isEnabled"] = True  # pipeline enabled all of them
        if i >= 4:
            item["appraisalRules"]["passedFilters"] = False
    snap, _ = _submit_payload(session, "live-2b", payload)
    pred = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    eligible_ids = {f"live-2b-c{i}" for i in range(4)}
    assert set(pred.selected_comp_ids) <= eligible_ids
    assert set(pred.scores_json.keys()) <= eligible_ids


def test_shadow_insufficient_evidence_when_no_eligible(session, trained, monkeypatch):
    monkeypatch.setattr(shadow, "_recalc", _fake_recalc())
    payload = make_report("live-3")
    for item in payload["comps"]["items"]:
        item["isEnabled"] = False
        item["appraisalRules"]["passedFilters"] = False
    snap, _ = _submit_payload(session, "live-3", payload)
    pred = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    assert pred.status == "insufficient_evidence"
    assert pred.shadow_arv is None
    assert pred.selected_comp_ids == []


def test_shadow_recalc_failure_records_error_not_number(session, trained, monkeypatch):
    def _boom(rid, ids):
        raise shadow.RecalcError("downstream down")
    monkeypatch.setattr(shadow, "_recalc", _boom)
    snap, _ = submit_payload(session, "live-4")
    pred = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    assert pred.status == "error"
    assert pred.shadow_arv is None
    assert "downstream down" in pred.recalc_json["error"]


def test_prediction_upsert_per_snapshot_model(session, trained, monkeypatch):
    monkeypatch.setattr(shadow, "_recalc", _fake_recalc())
    snap, _ = submit_payload(session, "live-5")
    p1 = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    p2 = shadow.score_snapshot(session, snapshot=snap, model_row=trained)
    assert p1.id == p2.id  # same (snapshot, model) → same prediction row
    rows = session.execute(select(Prediction)).scalars().all()
    assert len(rows) == 1
