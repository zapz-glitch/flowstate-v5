import json
import sqlite3

from cdarv.cli import main
from conftest import insert_saved_report, make_report


def test_end_to_end_cli(tmp_path, d1_file, capsys):
    db = str(tmp_path / "cdarv.db")
    artifacts = str(tmp_path / "artifacts")

    for i in range(6):
        insert_saved_report(d1_file, f"r{i}", make_report(f"r{i}"))

    assert main(["init-db", "--db", db]) == 0
    assert main(["ingest", "--db", db, "--source", "sqlite", "--d1", str(d1_file)]) == 0
    capsys.readouterr()
    assert main(["train", "--db", db, "--artifact-dir", artifacts]) == 0
    train_out = capsys.readouterr().out
    metrics = json.loads(train_out)
    assert metrics["model_version_id"] == 1

    assert main(["shadow", "--db", db]) == 0
    shadow_out = capsys.readouterr().out
    assert "shadow predictions written: 6" in shadow_out

    assert main(["status", "--db", db]) == 0
    status_out = capsys.readouterr().out
    assert "ideal reports: 6" in status_out
    assert "comp examples: 48" in status_out

    dataset_path = tmp_path / "examples.jsonl"
    assert main(["dataset", "--db", db, "--out", str(dataset_path)]) == 0
    lines = dataset_path.read_text().strip().split("\n")
    assert len(lines) == 48
    row = json.loads(lines[0])
    assert set(row) == {"report_id", "comp_id", "y", "features"}


def test_ingest_api_requires_credentials(tmp_path, capsys):
    code = main(["ingest", "--db", str(tmp_path / "x.db"), "--source", "api"])
    assert code == 2
