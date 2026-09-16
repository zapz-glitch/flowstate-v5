"""Parse a saved Flowstate report payload into snapshot structures.

The production report JSON (`saved_reports.full_response_json`) carries
the entire evaluated comp pool: every candidate the pipeline saw with
filter results, adjustments, enable flags, and the final selection
(`compGroup`, `asIsCompIds`, `afterRenovationCompIds`).

A snapshot preserves:
- the subject + the intended renovation level (and its definition version),
- the candidate pool with per-sale transaction identities,
- the evaluator's kept/rejected comps, reasons, adjustments, and ARV,
- provenance: report created_at, applied settings, code/rule versions.

Human corrections never mutate the snapshot — they live on review versions.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


class ReportParseError(ValueError):
    """Raised when a stored report cannot be shaped into a snapshot."""


@dataclass(frozen=True)
class CandidateComp:
    """One comparable from the report's evaluated pool."""

    comp_id: str
    rank_in_report: int
    raw: dict[str, Any]
    # Evaluator outputs — kept as rule_context for comparison; excluded
    # from model inputs by default (the model must not copy the system
    # it is meant to improve).
    is_enabled: bool
    group: str | None  # evaluator selection: 'arv' | 'as_is' | None
    in_arv_ids: bool
    in_as_is_ids: bool

    @property
    def transaction_key(self) -> str:
        """Uniquely identifies the sale: comp id + sale date + price."""
        sale_date = self.raw.get("saleDate") or "unknown-date"
        sale_price = self.raw.get("salePrice") or "unknown-price"
        return f"{self.comp_id}|{sale_date}|{sale_price}"

    @property
    def evaluator_selected(self) -> bool:
        return self.group is not None or self.in_arv_ids or self.in_as_is_ids

    @property
    def recalc_eligible(self) -> bool:
        """Mirrors recalculateReport's eligibility gate exactly:

        appraisalRules.passedFilters !== false AND a positive
        (adjustedPrice ?? salePrice). Real reports can carry
        isEnabled=true with passedFilters=false (fallback tiers /
        manual enables) — those comps were ARV-usable at eval time but
        the production recalc contract rejects them, so shadow ranking
        must gate on this predicate, not on is_enabled.
        """
        rules = self.raw.get("appraisalRules")
        if isinstance(rules, dict) and rules.get("passedFilters") is False:
            return False
        price = self.raw.get("adjustedPrice") or self.raw.get("salePrice")
        return isinstance(price, (int, float)) and price > 0


@dataclass(frozen=True)
class ReportSnapshot:
    """Parsed report ready to persist as a snapshot row."""

    report_id: str
    user_id: str
    created_at: str  # report's own creation time — the as-of date
    job_id: str | None
    address: str | None
    content_hash: str
    raw_json: str
    subject: dict[str, Any]
    comps: list[CandidateComp] = field(default_factory=list)
    valuation: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    completeness: str = "complete"
    completeness_notes: list[str] = field(default_factory=list)

    @property
    def arv(self) -> float | None:
        v = self.valuation.get("arv")
        return float(v) if isinstance(v, (int, float)) else None


def content_hash(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _id_set(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(v) for v in value}


def _extract_provenance(payload: dict[str, Any], created_at: str) -> dict[str, Any]:
    """Provenance + the renovation target and its definition version."""
    applied = payload.get("appliedSettings")
    valuation = payload.get("valuation") or {}
    applied = applied if isinstance(applied, dict) else {}

    rehab_index = applied.get("rehabLevelIndex")
    rehab_table = applied.get("rehabTable")
    provenance = {
        "report_created_at": created_at,
        "evaluation_revision": payload.get("evaluationRevision"),
        "rehab_level_index": rehab_index if isinstance(rehab_index, int) else None,
        "rehab_level": valuation.get("rehabLevel"),
        # Definition version: hash of the applied rehab table — the same
        # level name can mean different dollars across settings versions.
        "rehab_table_hash": (
            content_hash(json.dumps(rehab_table, sort_keys=True))[:16]
            if rehab_table is not None else None
        ),
        "deal_params": applied.get("dealParams") if isinstance(applied.get("dealParams"), dict) else None,
        "arv_threshold_percent": valuation.get("arvThresholdPercent"),
        "provider": "cotality",  # report pool originates from CoreLogic/Cotality
        # AVM note: subject.avm exists in the payload but is research-only —
        # it is recorded as present here and excluded from all model inputs.
        "avm_present": isinstance(payload.get("subject"), dict)
        and payload["subject"].get("avm") is not None,
    }
    return provenance


def parse_report(
    *,
    report_id: str,
    user_id: str,
    created_at: str,
    report_json: str | dict[str, Any],
    job_id: str | None = None,
    address: str | None = None,
) -> ReportSnapshot:
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

    notes: list[str] = []
    if not comps:
        notes.append("no candidate comp pool preserved")
    if not any(c.is_enabled for c in comps):
        notes.append("no evaluator-enabled comps recorded")
    if not subject.get("squareFeet"):
        notes.append("subject square footage missing")
    completeness = "incomplete" if notes else "complete"

    valuation = payload.get("valuation")
    return ReportSnapshot(
        report_id=report_id,
        user_id=user_id,
        created_at=created_at,
        job_id=job_id,
        address=address,
        content_hash=content_hash(canonical),
        raw_json=canonical,
        subject=subject,
        comps=comps,
        valuation=valuation if isinstance(valuation, dict) else {},
        provenance=_extract_provenance(payload, created_at),
        completeness=completeness,
        completeness_notes=notes,
    )


__all__ = [
    "CandidateComp",
    "ReportParseError",
    "ReportSnapshot",
    "content_hash",
    "parse_report",
]
