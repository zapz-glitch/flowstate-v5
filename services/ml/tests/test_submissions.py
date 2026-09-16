"""Submission semantics: idempotency, versioning, no auto-authorization."""

import json

from sqlalchemy import select

from cdarv.domain.datasets import approved_members
from cdarv.domain.submissions import list_queue, submit_report
from cdarv.persistence.models import Snapshot
from conftest import make_report, submit_payload


def test_resubmission_is_idempotent(session):
    snap1, outcome1 = submit_payload(session, "r1")
    snap2, outcome2 = submit_payload(session, "r1")
    assert outcome1 == "created"
    assert outcome2 == "duplicate"
    assert snap1.id == snap2.id
    assert session.execute(select(Snapshot)).scalars().all().__len__() == 1


def test_changed_content_creates_new_version(session):
    snap1, _ = submit_payload(session, "r1")
    changed = make_report("r1")
    changed["comps"]["items"][5]["salePrice"] = 999999
    snap2, outcome = submit_report_v2(session, changed)
    assert outcome == "new_version"
    assert snap2.version == 2
    assert snap2.id != snap1.id
    # Original snapshot evidence is untouched.
    assert snap1.content_hash != snap2.content_hash


def submit_report_v2(session, payload):
    return submit_report(
        session, report_id="r1", user_id="u1",
        created_at="2026-09-01T00:00:00Z",
        report_json=json.dumps(payload), submitted_by="test",
    )


def test_submission_alone_does_not_authorize_training(session):
    """A submitted report contributes nothing to datasets until a human
    approves a review for the scope."""
    submit_payload(session, "r1")
    assert approved_members(session, scope="comp_ranking") == []
    assert approved_members(session, scope="valuation_benchmark") == []


def test_snapshot_status_lands_in_queue(session):
    snap, _ = submit_payload(session, "r1")
    assert snap.status == "submitted"
    assert snap in list_queue(session, "submitted")


def test_incomplete_snapshot_preserved(session):
    """Missing evidence is flagged, not repaired or dropped."""
    snap, _ = submit_payload(
        session, "r1",
        report_overrides={"comps": {"items": []}},
    )
    assert snap.completeness == "incomplete"
    assert snap.completeness_notes


def test_selection_history_lands_in_provenance(session):
    """The operator-edit trail (engine-vs-user variance) is preserved on
    the snapshot's provenance for reviewers and training."""
    history = [
        {
            "action": "comp_selection",
            "description": "Recalculated 2 operator-selected comparables",
            "created_at": "2026-09-02T00:00:00Z",
            "arv_before": ["r1-c0", "r1-c1", "r1-c2"],
            "arv_after": ["r1-c0", "r1-c4"],
        }
    ]
    snap, outcome = submit_payload(session, "r1", selection_history=history)
    assert outcome == "created"
    assert snap.provenance_json["selection_history"] == history


def test_selection_history_refreshes_on_duplicate(session):
    """Same report re-sent with a longer edit trail updates the envelope
    metadata without minting a new snapshot version."""
    submit_payload(session, "r1")
    history = [{"action": "comp_selection", "description": "edit",
                "created_at": "2026-09-02T00:00:00Z",
                "arv_before": ["a"], "arv_after": ["b"]}]
    snap, outcome = submit_payload(session, "r1", selection_history=history)
    assert outcome == "duplicate"
    assert snap.version == 1
    assert snap.provenance_json["selection_history"] == history
