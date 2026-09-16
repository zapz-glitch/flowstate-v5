"""Review workflow: versioning, labels, preferences, approvals."""

import pytest

from cdarv.domain.reviews import (
    ReviewError, add_external_comp, add_preference, decide, open_review,
    review_detail, set_comp_labels,
)
from conftest import approve_review, submit_payload


def test_open_review_moves_snapshot_to_needs_review(session):
    snap, _ = submit_payload(session, "r1")
    review, outcome = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    assert outcome == "created"
    assert review.version == 1
    assert snap.status == "needs_review"


def test_open_review_is_idempotent_while_open(session):
    snap, _ = submit_payload(session, "r1")
    r1, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    r2, outcome = open_review(session, snapshot_id=snap.id, reviewer_id="rev2")
    assert outcome == "reused"
    assert r1.id == r2.id


def test_correction_creates_new_review_version(session):
    snap, _ = submit_payload(session, "r1")
    r1 = approve_review(session, snap)
    # A decided review cannot be mutated — corrections open a new version.
    with pytest.raises(ReviewError):
        set_comp_labels(session, r1, [{"comp_id": "r1-c0", "label": "unsuitable"}])
    r2, outcome = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    assert outcome == "created"
    assert r2.version == 2
    assert r1.version == 1  # history preserved


def test_invalid_label_rejected(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    with pytest.raises(ReviewError):
        set_comp_labels(session, review, [{"comp_id": "x", "label": "bogus"}])


def test_invalid_reason_rejected(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    with pytest.raises(ReviewError):
        set_comp_labels(
            session, review,
            [{"comp_id": "x", "label": "strong_arv", "reasons": ["bogus"]}],
        )


def test_approval_requires_scope(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    with pytest.raises(ReviewError, match="scope"):
        decide(session, review, action="approve", reviewer_id="rev1")


def test_gold_standard_requires_evidence(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    with pytest.raises(ReviewError, match="evidence"):
        decide(session, review, action="approve", reviewer_id="rev1",
               comp_ranking=True, gold_standard=True)


def test_separate_approval_scopes(session):
    """Comp-ranking approval does not imply valuation-benchmark approval."""
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    decide(session, review, action="approve", reviewer_id="rev1", comp_ranking=True)
    detail = review_detail(session, review)
    assert detail["approval"]["comp_ranking"] is True
    assert detail["approval"]["valuation_benchmark"] is False


def test_preference_and_external_comp_recorded(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    pref = add_preference(
        session, review, preferred_comp_id="r1-c4", over_comp_id="r1-c0",
        reasons=["different_neighborhood"],
        note="Closer but across a major road — prefer the subject-side sale.",
    )
    ext = add_external_comp(
        session, review, source="mls",
        transaction={"comp_id": "ext-1", "saleDate": "2026-05-01", "salePrice": 240000},
        availability_date="2026-05-03",
    )
    detail = review_detail(session, review)
    assert detail["preferences"][0]["preferred_comp_id"] == "r1-c4"
    assert detail["external_comps"][0]["id"] == ext.id
    assert pref.review_id == review.id


def test_external_comp_requires_provenance(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    with pytest.raises(ReviewError):
        add_external_comp(session, review, source="", transaction={}, availability_date="")


def test_exclusion_marks_snapshot(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    decide(session, review, action="exclude", reviewer_id="rev1", note="bad data")
    assert snap.status == "excluded"
    assert review.status == "excluded"


def test_needs_more_evidence_state(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    decide(session, review, action="needs_more_evidence", reviewer_id="rev1")
    assert review.status == "needs_more_evidence"
    assert snap.status == "needs_more_evidence"
