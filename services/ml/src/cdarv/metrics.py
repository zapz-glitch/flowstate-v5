"""Grouped ranking metrics for comp selection.

Examples are grouped by report — a comp is only rankable against its own
pool, so every metric is computed per report then averaged. Splitting is
also by report: comps from the same property must never straddle train/val.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence


def per_report_topk(
    report_ids: Sequence[str],
    labels: Sequence[int],
    scores: Sequence[float],
    comp_ids: Sequence[str],
) -> list[dict]:
    """Rank each report's pool by score; compare top-k to the true selection.

    k is the report's own selected count — the model is judged on whether it
    would have kept exactly the comps the reviewer kept.
    """
    groups: dict[str, list[tuple[str, int, float]]] = {}
    for rid, cid, y, s in zip(report_ids, comp_ids, labels, scores):
        groups.setdefault(rid, []).append((cid, int(y), float(s)))

    out: list[dict] = []
    for rid, rows in groups.items():
        true_ids = {cid for cid, y, _ in rows if y == 1}
        if not true_ids:
            continue
        k = len(true_ids)
        ranked = sorted(rows, key=lambda r: r[2], reverse=True)
        picked = {cid for cid, _, _ in ranked[:k]}
        hit = len(true_ids & picked)
        out.append(
            {
                "report_id": rid,
                "k": k,
                "hits": hit,
                "precision_at_k": hit / k,
                "recall_at_k": hit / len(true_ids),
                "exact_match": 1.0 if true_ids == picked else 0.0,
                "top1_hit": 1.0 if ranked and ranked[0][0] in true_ids else 0.0,
            }
        )
    return out


def summarize(per_report: list[dict]) -> dict:
    if not per_report:
        return {
            "reports_scored": 0,
            "mean_precision_at_k": None,
            "mean_recall_at_k": None,
            "exact_match_rate": None,
            "top1_hit_rate": None,
        }
    n = len(per_report)
    return {
        "reports_scored": n,
        "mean_precision_at_k": sum(r["precision_at_k"] for r in per_report) / n,
        "mean_recall_at_k": sum(r["recall_at_k"] for r in per_report) / n,
        "exact_match_rate": sum(r["exact_match"] for r in per_report) / n,
        "top1_hit_rate": sum(r["top1_hit"] for r in per_report) / n,
    }


def grouped_split(report_ids: Iterable[str], val_fraction: float = 0.2,
                  seed: int = 42) -> tuple[set[str], set[str]]:
    """Deterministic report-level split: no report appears in both sets."""
    import hashlib

    def bucket(rid: str) -> float:
        h = hashlib.sha256(f"{seed}:{rid}".encode()).hexdigest()
        return int(h[:8], 16) / 0xFFFFFFFF

    unique = sorted(set(report_ids))
    train = {r for r in unique if bucket(r) >= val_fraction}
    val = set(unique) - train
    # Keep both sides non-empty when possible.
    if not val and unique:
        val = {unique[-1]}
        train.discard(unique[-1])
    if not train and unique:
        train = {unique[0]}
        val.discard(unique[0])
    return train, val


__all__ = ["per_report_topk", "summarize", "grouped_split"]
