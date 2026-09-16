import json

from cdarv.ingest import SqliteReportSource, ingest_reports
from cdarv.store import Store
from conftest import insert_saved_report, make_report


def test_ingest_sqlite_source(d1_file, tmp_path):
    insert_saved_report(d1_file, "r1", make_report("r1"))
    insert_saved_report(d1_file, "r2", make_report("r2"), feedback="improve")
    insert_saved_report(d1_file, "r3", make_report("r3"))

    store = Store(tmp_path / "cdarv.db")
    result = ingest_reports(store, SqliteReportSource(str(d1_file)))

    # 'improve' report excluded — only validated reports are ideal examples
    assert result.inserted == 2
    with store.connect() as conn:
        reports = conn.execute("SELECT report_id FROM ideal_reports").fetchall()
        assert {r["report_id"] for r in reports} == {"r1", "r3"}
        examples = conn.execute("SELECT COUNT(*) c FROM comp_examples").fetchone()["c"]
        assert examples == 16  # 8 comps per report


def test_ingest_idempotent(d1_file, tmp_path):
    insert_saved_report(d1_file, "r1", make_report("r1"))
    store = Store(tmp_path / "cdarv.db")
    source = SqliteReportSource(str(d1_file))

    first = ingest_reports(store, source)
    assert first.inserted == 1
    second = ingest_reports(store, source)
    assert second.unchanged == 1 and second.inserted == 0


def test_ingest_refresh_on_change(d1_file, tmp_path):
    insert_saved_report(d1_file, "r1", make_report("r1"))
    store = Store(tmp_path / "cdarv.db")
    source = SqliteReportSource(str(d1_file))
    ingest_reports(store, source)

    # Reviewer re-selects: move a far comp into the ARV set
    payload = make_report("r1")
    payload["comps"]["items"][5]["compGroup"] = "arv"
    payload["comps"]["items"][0]["compGroup"] = None
    payload["comps"]["afterRenovationCompIds"] = [
        c["id"] for c in payload["comps"]["items"] if c.get("compGroup") == "arv"
    ]
    import sqlite3
    conn = sqlite3.connect(d1_file)
    conn.execute(
        "UPDATE saved_reports SET full_response_json = ? WHERE id = 'r1'",
        (json.dumps(payload),),
    )
    conn.commit()
    conn.close()

    result = ingest_reports(store, source)
    assert result.updated == 1
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT comp_id, label_arv FROM comp_examples WHERE report_id = 'r1'"
        ).fetchall()
        by_id = {r["comp_id"]: r["label_arv"] for r in rows}
        assert by_id["r1-c5"] == 1
        assert by_id["r1-c0"] == 0


def test_ingest_skips_unparseable(d1_file, tmp_path):
    insert_saved_report(d1_file, "good", make_report("good"))
    insert_saved_report(d1_file, "bad", {"subject": {}, "comps": {"items": []}})

    store = Store(tmp_path / "cdarv.db")
    result = ingest_reports(store, SqliteReportSource(str(d1_file)))
    assert result.inserted == 1
    assert len(result.skipped) == 1
