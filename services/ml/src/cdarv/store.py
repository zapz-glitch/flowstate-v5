"""SQLite dataset + artifact registry for CDARV.

The store is derived data: raw ideal reports are kept verbatim so features
and labels can be re-derived without re-pulling from the production API.
SQLite keeps the package deployable anywhere the existing backend can run a
Python job — no separate database service required.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS ideal_reports (
    report_id       TEXT PRIMARY KEY,
    job_id          TEXT,
    user_id         TEXT NOT NULL,
    address         TEXT,
    feedback_status TEXT NOT NULL,
    feedback_at     TEXT,
    report_created_at TEXT NOT NULL,
    report_json     TEXT NOT NULL,
    report_hash     TEXT NOT NULL,
    ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ideal_reports_user ON ideal_reports(user_id);
CREATE INDEX IF NOT EXISTS ix_ideal_reports_created ON ideal_reports(report_created_at);

CREATE TABLE IF NOT EXISTS comp_examples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id     TEXT NOT NULL REFERENCES ideal_reports(report_id) ON DELETE CASCADE,
    comp_id       TEXT NOT NULL,
    rank_in_report INTEGER,
    features_json TEXT NOT NULL,
    label_selected INTEGER NOT NULL,
    label_arv      INTEGER NOT NULL,
    label_as_is    INTEGER NOT NULL,
    label_enabled  INTEGER NOT NULL,
    UNIQUE(report_id, comp_id)
);
CREATE INDEX IF NOT EXISTS ix_comp_examples_report ON comp_examples(report_id);

CREATE TABLE IF NOT EXISTS model_versions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    target         TEXT NOT NULL,
    feature_names_json TEXT NOT NULL,
    metrics_json   TEXT NOT NULL,
    dataset_hash   TEXT NOT NULL,
    train_report_count  INTEGER NOT NULL,
    train_example_count INTEGER NOT NULL,
    artifact_path  TEXT NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_predictions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    model_version_id INTEGER NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
    report_id        TEXT NOT NULL,
    prediction_json  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    UNIQUE(model_version_id, report_id)
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    # ── ideal_reports / comp_examples ────────────────────────────────────────

    def existing_report_hash(self, conn: sqlite3.Connection, report_id: str) -> str | None:
        row = conn.execute(
            "SELECT report_hash FROM ideal_reports WHERE report_id = ?", (report_id,)
        ).fetchone()
        return row["report_hash"] if row else None

    def upsert_report(self, conn: sqlite3.Connection, report, comp_rows) -> str:
        """Insert or refresh an ideal report and its comp examples.

        `comp_rows` is a list of (CandidateComp, features_dict) pairs.
        Returns 'inserted' | 'updated' | 'unchanged'.
        """
        prior = self.existing_report_hash(conn, report.report_id)
        if prior == report.report_hash:
            return "unchanged"

        conn.execute(
            """INSERT INTO ideal_reports
               (report_id, job_id, user_id, address, feedback_status,
                feedback_at, report_created_at, report_json, report_hash, ingested_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(report_id) DO UPDATE SET
                 job_id=excluded.job_id, user_id=excluded.user_id,
                 address=excluded.address, feedback_status=excluded.feedback_status,
                 feedback_at=excluded.feedback_at,
                 report_created_at=excluded.report_created_at,
                 report_json=excluded.report_json, report_hash=excluded.report_hash,
                 ingested_at=excluded.ingested_at""",
            (
                report.report_id, report.job_id, report.user_id, report.address,
                report.feedback_status, report.feedback_at, report.created_at,
                report.raw_json, report.report_hash, utcnow(),
            ),
        )
        # Re-derive examples: bounded pool (~25 comps), so delete+insert is
        # simpler and always consistent with the stored payload.
        conn.execute("DELETE FROM comp_examples WHERE report_id = ?", (report.report_id,))
        conn.executemany(
            """INSERT INTO comp_examples
               (report_id, comp_id, rank_in_report, features_json,
                label_selected, label_arv, label_as_is, label_enabled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    report.report_id,
                    comp.comp_id,
                    comp.rank_in_report,
                    json.dumps(features, sort_keys=True),
                    int(comp.label_selected),
                    int(comp.label_arv),
                    int(comp.label_as_is),
                    int(comp.is_enabled),
                )
                for comp, features in comp_rows
            ],
        )
        return "updated" if prior else "inserted"

    def iter_reports(self, conn: sqlite3.Connection) -> list[sqlite3.Row]:
        return conn.execute(
            "SELECT * FROM ideal_reports ORDER BY report_created_at, report_id"
        ).fetchall()

    def load_examples(self, conn: sqlite3.Connection, target: str = "arv"):
        """Return (report_ids, feature_dicts, labels) for a target."""
        label_col = {"arv": "label_arv", "as_is": "label_as_is",
                     "selected": "label_selected", "enabled": "label_enabled"}[target]
        rows = conn.execute(
            f"""SELECT e.report_id, e.features_json, e.{label_col} AS y
                FROM comp_examples e ORDER BY e.report_id, e.rank_in_report"""
        ).fetchall()
        report_ids = [r["report_id"] for r in rows]
        features = [json.loads(r["features_json"]) for r in rows]
        labels = [int(r["y"]) for r in rows]
        return report_ids, features, labels

    # ── model_versions ───────────────────────────────────────────────────────

    def insert_model_version(self, conn: sqlite3.Connection, *, name: str, target: str,
                             feature_names: list[str], metrics: dict[str, Any],
                             dataset_hash: str, train_report_count: int,
                             train_example_count: int, artifact_path: str) -> int:
        cur = conn.execute(
            """INSERT INTO model_versions
               (name, target, feature_names_json, metrics_json, dataset_hash,
                train_report_count, train_example_count, artifact_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, target, json.dumps(feature_names), json.dumps(metrics),
             dataset_hash, train_report_count, train_example_count,
             artifact_path, utcnow()),
        )
        return int(cur.lastrowid)

    def get_model_version(self, conn: sqlite3.Connection, ref: str):
        if ref == "latest":
            return conn.execute(
                "SELECT * FROM model_versions ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return conn.execute(
            "SELECT * FROM model_versions WHERE id = ?", (int(ref),)
        ).fetchone()

    def list_model_versions(self, conn: sqlite3.Connection):
        return conn.execute(
            "SELECT id, name, target, metrics_json, created_at FROM model_versions ORDER BY id"
        ).fetchall()

    # ── shadow_predictions ───────────────────────────────────────────────────

    def upsert_shadow(self, conn: sqlite3.Connection, *, model_version_id: int,
                      report_id: str, prediction: dict[str, Any]) -> None:
        conn.execute(
            """INSERT INTO shadow_predictions
               (model_version_id, report_id, prediction_json, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(model_version_id, report_id) DO UPDATE SET
                 prediction_json=excluded.prediction_json, created_at=excluded.created_at""",
            (model_version_id, report_id, json.dumps(prediction), utcnow()),
        )


__all__ = ["Store", "SCHEMA", "utcnow"]
