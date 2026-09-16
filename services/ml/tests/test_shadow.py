import json

from cdarv.ingest import SqliteReportSource, ingest_reports
from cdarv.model import train
from cdarv.shadow import run_shadow
from cdarv.store import Store
from conftest import insert_saved_report, make_report


def test_shadow_predictions_written(tmp_path, d1_file):
    for i in range(6):
        insert_saved_report(d1_file, f"r{i}", make_report(f"r{i}"))
    store = Store(tmp_path / "cdarv.db")
    ingest_reports(store, SqliteReportSource(str(d1_file)))
    train(store, artifact_dir=tmp_path / "artifacts")

    outcomes = run_shadow(store)
    assert len(outcomes) == 6

    outcome = outcomes[0]
    p = outcome.prediction
    assert p["model_target"] == "arv"
    assert len(p["selected"]) == 3
    # Planted rule: shadow selection should match the actual ARV picks.
    assert p["overlap_with_actual"] == 3
    assert p["shadow_arv"] is not None
    assert p["actual_arv"] == 260000.0
    assert p["arv_delta"] is not None

    with store.connect() as conn:
        stored = conn.execute("SELECT COUNT(*) c FROM shadow_predictions").fetchone()["c"]
        assert stored == 6


def test_shadow_single_report(tmp_path, d1_file):
    insert_saved_report(d1_file, "r1", make_report("r1"))
    insert_saved_report(d1_file, "r2", make_report("r2"))
    store = Store(tmp_path / "cdarv.db")
    ingest_reports(store, SqliteReportSource(str(d1_file)))
    train(store, artifact_dir=tmp_path / "artifacts")

    outcomes = run_shadow(store, report_id="r1")
    assert len(outcomes) == 1
    assert outcomes[0].report_id == "r1"


def test_shadow_requires_model(tmp_path, d1_file):
    insert_saved_report(d1_file, "r1", make_report("r1"))
    store = Store(tmp_path / "cdarv.db")
    ingest_reports(store, SqliteReportSource(str(d1_file)))
    import pytest
    with pytest.raises(RuntimeError, match="not found"):
        run_shadow(store)
