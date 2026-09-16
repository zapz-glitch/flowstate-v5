"""Dataset discipline: approval gating, frozen manifests, split hygiene."""

import pytest

from cdarv.domain.datasets import build_dataset, dataset_examples
from cdarv.domain.features import FEATURE_NAMES
from cdarv.domain.reviews import decide, open_review, set_comp_labels
from cdarv.persistence.models import Snapshot
from conftest import approve_review, submit_payload
from sqlalchemy import select


def _approved_snapshots(session, n: int):
    snaps = []
    for i in range(n):
        snap, _ = submit_payload(
            session, f"r{i}",
            created_at=f"2026-0{(i % 8) + 1}-15T00:00:00Z",
        )
        approve_review(session, snap)
        snaps.append(snap)
    return snaps


def test_unapproved_reports_never_enter_dataset(session):
    submit_payload(session, "r0")  # submitted, never reviewed
    with pytest.raises(ValueError, match="no eligible approved examples"):
        build_dataset(session, name="d", created_by="test")


def test_unreviewed_comps_are_not_negatives(session):
    snap, _ = submit_payload(session, "r1")
    review, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    # Label only 2 of 8 comps; the other 6 stay unreviewed.
    set_comp_labels(session, review, [
        {"comp_id": "r1-c0", "label": "strong_arv"},
        {"comp_id": "r1-c5", "label": "unsuitable"},
    ])
    decide(session, review, action="approve", reviewer_id="rev1", comp_ranking=True)

    dataset = build_dataset(session, name="d", created_by="test")
    examples = dataset_examples(session, dataset)
    assert len(examples) == 2  # exactly the labeled comps — no auto-negatives
    labels = {e["comp_id"]: e["y"] for e in examples}
    assert labels["r1-c0"] == 1
    assert labels["r1-c5"] == 0


def test_excluded_review_omitted_from_dataset(session):
    snap_ok, _ = submit_payload(session, "r1")
    approve_review(session, snap_ok)
    snap_bad, _ = submit_payload(session, "r2")
    review, _ = open_review(session, snapshot_id=snap_bad.id, reviewer_id="rev1")
    decide(session, review, action="exclude", reviewer_id="rev1")

    dataset = build_dataset(session, name="d", created_by="test")
    member_snap_ids = {
        m["snapshot_id"] for m in dataset.manifest_json["members"]
    }
    assert snap_ok.id in member_snap_ids
    assert snap_bad.id not in member_snap_ids


def test_approved_then_excluded_snapshot_omitted(session):
    """Excluding a snapshot after approval must drop it from datasets —
    the stale approved v1 must not leak back in."""
    snap_ok, _ = submit_payload(session, "r1")
    approve_review(session, snap_ok)
    snap_bad, _ = submit_payload(session, "r2")
    approve_review(session, snap_bad)
    # Reopen and exclude: v2 becomes 'excluded', snapshot excluded.
    review2, _ = open_review(session, snapshot_id=snap_bad.id, reviewer_id="rev1")
    decide(session, review2, action="exclude", reviewer_id="rev1")

    dataset = build_dataset(session, name="d", created_by="test")
    member_snap_ids = {
        m["snapshot_id"] for m in dataset.manifest_json["members"]
    }
    assert snap_ok.id in member_snap_ids
    assert snap_bad.id not in member_snap_ids


def test_real_data_gate_blocks_unmarked_snapshots(session, monkeypatch):
    """With CDARV_REAL_DATA_TRAINING_ENABLED unset (default), approved
    snapshots without a synthetic marker cannot enter datasets."""
    monkeypatch.delenv("CDARV_REAL_DATA_TRAINING_ENABLED", raising=False)
    snap, _ = submit_payload(session, "r1", report_overrides={"meta": {}})
    approve_review(session, snap)
    with pytest.raises(ValueError, match="real-data training is disabled"):
        build_dataset(session, name="d", created_by="test")


def test_real_data_gate_mixed_pool(session):
    """Synthetic members pass; unmarked approved members are dropped."""
    syn, _ = submit_payload(session, "r1")  # fixture carries meta.synthetic
    approve_review(session, syn)
    real, _ = submit_payload(session, "r2", report_overrides={"meta": {}})
    approve_review(session, real)

    dataset = build_dataset(session, name="d", created_by="test")
    member_ids = {m["snapshot_id"] for m in dataset.manifest_json["members"]}
    assert member_ids == {syn.id}


def test_real_data_gate_enabled_includes_real(session, monkeypatch):
    """Explicit opt-in admits unmarked (provider-derived) snapshots."""
    monkeypatch.setenv("CDARV_REAL_DATA_TRAINING_ENABLED", "true")
    snap, _ = submit_payload(session, "r1", report_overrides={"meta": {}})
    approve_review(session, snap)
    dataset = build_dataset(session, name="d", created_by="test")
    member_ids = {m["snapshot_id"] for m in dataset.manifest_json["members"]}
    assert snap.id in member_ids


def test_superseded_review_not_reused(session):
    """A correction creates a new version; the dataset uses the latest
    approved version only."""
    snap, _ = submit_payload(session, "r1")
    r1 = approve_review(session, snap)
    r2, _ = open_review(session, snapshot_id=snap.id, reviewer_id="rev1")
    set_comp_labels(session, r2, [
        {"comp_id": "r1-c0", "label": "unsuitable"},
    ])
    decide(session, r2, action="approve", reviewer_id="rev1", comp_ranking=True)

    dataset = build_dataset(session, name="d", created_by="test")
    member = dataset.manifest_json["members"][0]
    assert member["review_id"] == r2.id
    assert member["review_version"] == 2
    assert member["review_id"] != r1.id


def test_manifest_pins_versions(session):
    snaps = _approved_snapshots(session, 4)
    dataset = build_dataset(session, name="d", created_by="test")
    members = dataset.manifest_json["members"]
    assert len(members) == 4
    for m, snap in zip(
        sorted(members, key=lambda m: m["snapshot_id"]),
        sorted(snaps, key=lambda s: s.id),
    ):
        assert m["snapshot_version"] == snap.version
        assert m["review_version"] == 1
        assert m["split"] in ("train", "val", "test")
        assert m["content_hash"] == snap.content_hash


def test_splits_keep_snapshot_comps_together(session):
    """All comps of a subject evaluation share one split — no straddling."""
    _approved_snapshots(session, 6)
    dataset = build_dataset(session, name="d", created_by="test", seed=42)
    examples = dataset_examples(session, dataset)
    by_snap: dict[str, set] = {}
    for e in examples:
        by_snap.setdefault(e["snapshot_id"], set()).add(e["split"])
    assert all(len(splits) == 1 for splits in by_snap.values())


def test_test_split_is_time_aware(session):
    snaps = _approved_snapshots(session, 6)
    dataset = build_dataset(
        session, name="d", created_by="test", test_fraction=0.34, seed=42)
    test_members = {
        m["snapshot_id"]: m for m in dataset.manifest_json["members"]
        if m["split"] == "test"
    }
    assert test_members
    test_dates = {m["report_created_at"] for m in test_members.values()}
    other_dates = {
        m["report_created_at"] for m in dataset.manifest_json["members"]
        if m["split"] != "test"
    }
    assert min(test_dates) >= max(other_dates)


def test_dataset_versioning_never_overwrites(session):
    _approved_snapshots(session, 3)
    d1 = build_dataset(session, name="d", created_by="test")
    snap, _ = submit_payload(session, "rx")
    approve_review(session, snap)
    d2 = build_dataset(session, name="d", created_by="test")
    assert d1.version == 1
    assert d2.version == 2
    assert d1.id != d2.id


def test_examples_carry_provenance_and_context(session):
    _approved_snapshots(session, 2)
    dataset = build_dataset(session, name="d", created_by="test")
    examples = dataset_examples(session, dataset)
    assert examples
    for e in examples:
        assert e["transaction_key"]
        assert e["rule_context"]["is_enabled"] is True
        assert set(e["features"].keys()) == set(FEATURE_NAMES)
