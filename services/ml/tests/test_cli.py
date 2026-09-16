"""CLI smoke: init-db + submit-from-D1 + queue + status."""

import json
import os

from cdarv.cli import main
from conftest import insert_saved_report, make_report


def test_init_submit_status(tmp_path, monkeypatch, d1_file, capsys):
    db = tmp_path / "cdarv.sqlite"
    monkeypatch.setenv("CDARV_TEST_PROFILE", "true")
    url = f"sqlite:///{db}"

    insert_saved_report(d1_file, "r1", make_report("r1"), feedback="validated")
    insert_saved_report(d1_file, "r2", make_report("r2"), feedback="improve")

    assert main(["--db", url, "init-db"]) == 0
    assert main(["--db", url, "submit", "--d1", str(d1_file)]) == 0
    out = capsys.readouterr().out
    assert "1 created" in out  # only the validated report

    # Resubmit: idempotent.
    assert main(["--db", url, "submit", "--d1", str(d1_file)]) == 0
    assert "1 duplicates" in capsys.readouterr().out

    assert main(["--db", url, "queue"]) == 0
    assert "1 snapshots" in capsys.readouterr().out

    assert main(["--db", url, "status"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["snapshots_by_status"]["submitted"] == 1


def test_sqlite_requires_test_profile(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CDARV_TEST_PROFILE", raising=False)
    db = tmp_path / "cdarv.sqlite"
    try:
        main(["--db", f"sqlite:///{db}", "queue"])
    except SystemExit as e:
        assert e.code == 2
    else:
        raise AssertionError("expected SystemExit")
    assert "CDARV_TEST_PROFILE" in capsys.readouterr().err
