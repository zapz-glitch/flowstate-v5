"""Ideal-report ingestion: pull approved reports into the CDARV store.

Sources
-------
SqliteReportSource — reads `saved_reports` directly from a D1 SQLite file
(local `wrangler d1` DB or a `wrangler d1 export` artifact). Zero API cost;
the path for bulk refresh and local development.

HttpReportSource — pulls `GET /v1/ml/ideal-reports` from the production API
with a normal `fs_` API key. Bounded pages; the path for scheduled refresh.

Both emit the same row shape and feed `ingest_reports`, which parses each
report, extracts comp features, and upserts idempotently (content-hash
keyed — re-running ingest is free when nothing changed).
"""

from __future__ import annotations

import json
import sqlite3
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Protocol

from .features import extract_comp_features
from .reports import ReportParseError, parse_report
from .store import Store


@dataclass(frozen=True)
class SourceRow:
    report_id: str
    user_id: str
    created_at: str
    report_json: str
    job_id: str | None = None
    address: str | None = None
    feedback_status: str = "validated"
    feedback_at: str | None = None


class ReportSource(Protocol):
    def iter_rows(self) -> Iterator[SourceRow]: ...


class SqliteReportSource:
    """Reads saved_reports from a D1 SQLite file."""

    def __init__(self, path: str, feedback_status: str = "validated"):
        self.path = path
        self.feedback_status = feedback_status

    def iter_rows(self) -> Iterator[SourceRow]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """SELECT id, user_id, job_id, property_address, property_city,
                          property_state, property_zip, feedback_status,
                          feedback_at, created_at, full_response_json
                   FROM saved_reports
                   WHERE feedback_status = ? AND full_response_json IS NOT NULL
                   ORDER BY created_at, id""",
                (self.feedback_status,),
            ).fetchall()
        finally:
            conn.close()
        for r in rows:
            address = ", ".join(
                p for p in (r["property_address"], r["property_city"], r["property_state"]) if p
            )
            yield SourceRow(
                report_id=r["id"],
                user_id=r["user_id"],
                created_at=r["created_at"],
                report_json=r["full_response_json"],
                job_id=r["job_id"],
                address=address or None,
                feedback_status=r["feedback_status"] or "validated",
                feedback_at=r["feedback_at"],
            )


class HttpReportSource:
    """Pulls ideal reports from the production API export endpoint."""

    def __init__(self, base_url: str, api_key: str, page_size: int = 25):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.page_size = page_size

    def iter_rows(self) -> Iterator[SourceRow]:
        cursor: str | None = None
        while True:
            url = f"{self.base_url}/v1/ml/ideal-reports?limit={self.page_size}"
            if cursor:
                url += f"&cursor={cursor}"
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {self.api_key}"}
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            for item in body.get("reports", []):
                yield SourceRow(
                    report_id=item["reportId"],
                    user_id=item.get("userId", ""),
                    created_at=item["createdAt"],
                    report_json=json.dumps(item["report"]),
                    job_id=item.get("jobId"),
                    address=item.get("address"),
                    feedback_status=item.get("feedbackStatus") or "validated",
                    feedback_at=item.get("feedbackAt"),
                )
            cursor = body.get("nextCursor")
            if not cursor:
                break


@dataclass
class IngestResult:
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return self.inserted + self.updated + self.unchanged


def ingest_reports(store: Store, source: ReportSource) -> IngestResult:
    store.init_schema()
    result = IngestResult()
    with store.connect() as conn:
        for row in source.iter_rows():
            try:
                report = parse_report(
                    report_id=row.report_id,
                    user_id=row.user_id,
                    created_at=row.created_at,
                    report_json=row.report_json,
                    job_id=row.job_id,
                    address=row.address,
                    feedback_status=row.feedback_status,
                    feedback_at=row.feedback_at,
                )
            except ReportParseError as exc:
                result.skipped.append(str(exc))
                continue
            comp_rows = [
                (comp, extract_comp_features(report, comp)) for comp in report.comps
            ]
            outcome = store.upsert_report(conn, report, comp_rows)
            if outcome == "inserted":
                result.inserted += 1
            elif outcome == "updated":
                result.updated += 1
            else:
                result.unchanged += 1
    return result


__all__ = [
    "HttpReportSource",
    "IngestResult",
    "ReportSource",
    "SourceRow",
    "SqliteReportSource",
    "ingest_reports",
]
