"""Parse a saved Flowstate analysis report into ML-ready structures.

The production report JSON (`saved_reports.full_response_json`) already
carries the full evaluated comp pool — every candidate the pipeline saw,
with filter results, adjustments, enable flags, and the final selection
(`compGroup` / `comps.asIsCompIds` / `comps.afterRenovationCompIds`).

CDARV treats a human-validated report as the ideal example: the comps the
reviewer kept are positive labels, everything else in the pool is negative.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


class ReportParseError(ValueError):
    """Raised when a stored report cannot be shaped into training data."""


@dataclass(frozen=True)
class CandidateComp:
    """One comparable from a report's evaluated pool."""

    comp_id: str
    rank_in_report: int
    raw: dict[str, Any]
    # Pipeline outputs recorded on the report (features — pre-selection).
    is_enabled: bool
    # Final selection labels (post-review ground truth in ideal reports).
    group: str | None  # 'arv' | 'as_is' | None
    in_arv_ids: bool
    in_as_is_ids: bool

    @property
    def label_arv(self) -> bool:
        return self.group == "arv" or self.in_arv_ids

    @property
    def label_as_is(self) -> bool:
        return self.group == "as_is" or self.in_as_is_ids

    @property
    def label_selected(self) -> bool:
        return self.label_arv or self.label_as_is


@dataclass(frozen=True)
class IdealReport:
    """An approved report plus the provenance needed to learn from it."""

    report_id: str
    user_id: str
    created_at: str  # saved_reports.created_at — reference date for sale age
    job_id: str | None
    address: str | None
    feedback_status: str
    feedback_at: str | None
    report_hash: str
    raw_json: str  # canonical payload, kept verbatim for re-derivation
    subject: dict[str, Any]
    comps: list[CandidateComp] = field(default_factory=list)
    valuation: dict[str, Any] = field(default_factory=dict)

    @property
    def arv(self) -> float | None:
        v = self.valuation.get("arv")
        return float(v) if isinstance(v, (int, float)) else None


def report_hash(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _id_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(v) for v in value}


def parse_report(
    *,
    report_id: str,
    user_id: str,
    created_at: str,
    report_json: str | dict[str, Any],
    job_id: str | None = None,
    address: str | None = None,
    feedback_status: str = "validated",
    feedback_at: str | None = None,
) -> IdealReport:
    """Parse a stored report payload. Raises ReportParseError on bad shape."""
    if isinstance(report_json, str):
        try:
            payload = json.loads(report_json)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ReportParseError(f"report {report_id}: invalid JSON") from exc
        canonical = report_json
    else:
        payload = report_json
        canonical = json.dumps(payload, sort_keys=True)

    if not isinstance(payload, dict):
        raise ReportParseError(f"report {report_id}: payload is not an object")

    subject = payload.get("subject")
    comps_block = payload.get("comps")
    if not isinstance(subject, dict) or not isinstance(comps_block, dict):
        raise ReportParseError(f"report {report_id}: missing subject/comps")
    items = comps_block.get("items")
    if not isinstance(items, list):
        raise ReportParseError(f"report {report_id}: comps.items is not a list")

    arv_ids = _id_set(comps_block.get("afterRenovationCompIds"))
    as_is_ids = _id_set(comps_block.get("asIsCompIds"))

    comps: list[CandidateComp] = []
    for rank, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        comp_id = item.get("id")
        if not comp_id:
            continue
        group = item.get("compGroup")
        if group not in ("arv", "as_is"):
            group = None
        comps.append(
            CandidateComp(
                comp_id=str(comp_id),
                rank_in_report=rank,
                raw=item,
                is_enabled=bool(item.get("isEnabled")),
                group=group,
                in_arv_ids=str(comp_id) in arv_ids,
                in_as_is_ids=str(comp_id) in as_is_ids,
            )
        )

    if not comps:
        raise ReportParseError(f"report {report_id}: no usable comps")

    valuation = payload.get("valuation")
    return IdealReport(
        report_id=report_id,
        user_id=user_id,
        created_at=created_at,
        job_id=job_id,
        address=address,
        feedback_status=feedback_status,
        feedback_at=feedback_at,
        report_hash=report_hash(canonical),
        raw_json=canonical,
        subject=subject,
        comps=comps,
        valuation=valuation if isinstance(valuation, dict) else {},
    )


__all__ = [
    "CandidateComp",
    "IdealReport",
    "ReportParseError",
    "parse_report",
    "report_hash",
]
