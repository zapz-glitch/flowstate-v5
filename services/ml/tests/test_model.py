import json

import pytest

from cdarv.ingest import SqliteReportSource, ingest_reports
from cdarv.model import load_artifact, score, train
from cdarv.store import Store
from conftest import insert_saved_report, make_report


@pytest.fixture
def trained_store(tmp_path, d1_file):
    """12 planted-rule reports → trained baseline."""
    for i in range(12):
        insert_saved_report(
            d1_file, f"r{i}", make_report(f"r{i}"),
            created_at=f"2026-09-{i + 1:02d}T00:00:00Z",
        )
    store = Store(tmp_path / "cdarv.db")
    ingest_reports(store, SqliteReportSource(str(d1_file)))
    metrics = train(store, artifact_dir=tmp_path / "artifacts")
    return store, metrics


def test_train_produces_artifact_and_metrics(trained_store):
    store, metrics = trained_store
    assert metrics["train_reports"] + metrics["val_reports"] == 12
    assert metrics["val_ranking"]["reports_scored"] > 0
    # Planted rule (distance < 0.3 + enabled) is linearly separable —
    # the baseline should recover it exactly on held-out reports.
    assert metrics["val_ranking"]["mean_precision_at_k"] == pytest.approx(1.0)

    artifact = load_artifact(metrics["artifact_path"])
    assert artifact["target"] == "arv"
    assert artifact["feature_names"]
    assert "model" in artifact


def test_model_version_recorded(trained_store):
    store, metrics = trained_store
    with store.connect() as conn:
        version = store.get_model_version(conn, "latest")
        assert version["id"] == metrics["model_version_id"]
        assert version["target"] == "arv"


def test_score_returns_probabilities(trained_store, report_payload):
    store, metrics = trained_store
    artifact = load_artifact(metrics["artifact_path"])

    from cdarv.reports import parse_report
    from cdarv.features import extract_comp_features

    report = parse_report(
        report_id="probe", user_id="u1", created_at="2026-09-15T00:00:00Z",
        report_json=json.dumps(report_payload),
    )
    feats = [extract_comp_features(report, c) for c in report.comps]
    probs = score(artifact, feats)
    assert len(probs) == len(report.comps)
    assert all(0.0 <= p <= 1.0 for p in probs)
    # Near comps (the planted positive class) must outrank far comps.
    near = probs[:3].min()
    far = probs[3:].max()
    assert near > far


def test_train_empty_store_fails(tmp_path):
    store = Store(tmp_path / "empty.db")
    store.init_schema()
    with pytest.raises(RuntimeError, match="no comp examples"):
        train(store, artifact_dir=tmp_path / "artifacts")


def test_grouped_split_no_leakage():
    from cdarv.metrics import grouped_split

    report_ids = [f"r{i}" for i in range(50)]
    train_ids, val_ids = grouped_split(report_ids)
    assert not (train_ids & val_ids)
    assert train_ids | val_ids == set(report_ids)
