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
