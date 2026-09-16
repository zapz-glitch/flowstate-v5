"""Dataset construction: freeze approved examples into reproducible sets.

Rules enforced here:

- Only reviews whose approval covers the requested scope contribute, and
  the manifest pins exact (snapshot_id, snapshot_version, review_id,
  review_version) pairs — later corrections create new versions and never
  silently alter a built dataset.
- Splits are by snapshot: every comp of a subject stays together.
- Time-aware: the test split is the most recent slice of reports by
  report-created date; train/val are a deterministic hash split of the
  rest. Future information never lands in a training example for an
  earlier evaluation.
- Geography overlap between splits is measured and recorded on the
  manifest — same-city/same-subdivision bleed is documented, not hidden.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..persistence.models import (
    Approval, Dataset, DatasetMember, Review, Snapshot,
)
from .features import FEATURE_SPEC_VERSION


def _code_version() -> str | None:
    env = os.environ.get("CDARV_CODE_VERSION") or os.environ.get("RENDER_GIT_COMMIT")
    if env:
        return env
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def _split_bucket(key: str, seed: int) -> float:
    h = hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def _market_of(snapshot: Snapshot) -> dict[str, str | None]:
    subject = snapshot.report_json.get("subject") or {}
    address = snapshot.report_json.get("subject", {}).get("address") or ""
    parts = [p.strip() for p in address.split(",")]
    return {
        "city": parts[1] if len(parts) > 1 else None,
        "state": parts[2].split(" ")[0] if len(parts) > 2 else None,
        "subdivision": subject.get("subdivision"),
        "neighborhood": subject.get("neighborhoodName") or subject.get("neighborhoodCode"),
    }


def approved_members(session: Session, scope: str = "comp_ranking") -> list[dict[str, Any]]:
    """Approved (snapshot, review) pairs for the given approval scope."""
    if scope not in ("comp_ranking", "valuation_benchmark"):
        raise ValueError(f"unknown approval scope '{scope}'")
    col = (
        Approval.comp_ranking_approved if scope == "comp_ranking"
        else Approval.valuation_benchmark_approved
    )
    rows = session.execute(
        select(Snapshot, Review, Approval)
        .join(Review, Review.snapshot_id == Snapshot.id)
        .join(Approval, Approval.review_id == Review.id)
        .where(
            Review.status == "approved",
            col.is_(True),
            Snapshot.status != "excluded",
        )
        .order_by(Snapshot.created_at)
    ).all()
    # Latest approved review version per snapshot wins.
    by_snap: dict[str, tuple] = {}
    for snap, rev, appr in rows:
        cur = by_snap.get(snap.id)
        if cur is None or rev.version > cur[1].version:
            by_snap[snap.id] = (snap, rev, appr)
    return [
        {
            "snapshot": snap, "review": rev, "approval": appr,
            "report_created_at": snap.provenance_json.get("report_created_at") or "",
        }
        for snap, rev, appr in by_snap.values()
    ]


def build_dataset(
    session: Session,
    *,
    name: str,
    created_by: str,
    scope: str = "comp_ranking",
    test_fraction: float = 0.2,
    val_fraction: float = 0.2,
    seed: int = 42,
) -> Dataset:
    members = approved_members(session, scope=scope)
    if not real_data_training_enabled():
        members = [m for m in members if _is_synthetic(m["snapshot"])]
    if not members:
        raise ValueError(
            "no eligible approved examples for scope — approve reviews first"
            + ("" if real_data_training_enabled()
               else "; real-data training is disabled "
                    "(CDARV_REAL_DATA_TRAINING_ENABLED is not set)")
        )

    # Time-aware test split: most recent reports by report-created date.
    ordered = sorted(members, key=lambda m: m["report_created_at"])
    n_test = max(1, round(len(ordered) * test_fraction)) if len(ordered) > 2 else 0
    test_members = ordered[-n_test:] if n_test else []
    rest = ordered[: len(ordered) - n_test] if n_test else ordered

    splits: dict[str, str] = {}
    for m in test_members:
        splits[m["snapshot"].id] = "test"
    for m in rest:
        b = _split_bucket(m["snapshot"].id, seed)
        splits[m["snapshot"].id] = "val" if b < val_fraction else "train"

    manifest = {
        "scope": scope,
        "seed": seed,
        "test_fraction": test_fraction,
        "val_fraction": val_fraction,
        "members": [
            {
                "snapshot_id": m["snapshot"].id,
                "snapshot_version": m["snapshot"].version,
                "review_id": m["review"].id,
                "review_version": m["review"].version,
                "split": splits[m["snapshot"].id],
                "report_created_at": m["report_created_at"],
                "content_hash": m["snapshot"].content_hash,
            }
            for m in ordered
        ],
    }

    # Geography overlap between splits — documented, not enforced.
    geo: dict[str, dict[str, set]] = {}
    for m in ordered:
        market = _market_of(m["snapshot"])
        split = splits[m["snapshot"].id]
        for key in ("city", "subdivision", "neighborhood"):
            if market.get(key):
                geo.setdefault(split, {}).setdefault(key, set()).add(str(market[key]))
    geo_summary = {
        split: {k: sorted(v) for k, v in keys.items()} for split, keys in geo.items()
    }
    overlap = {
        "city_test_train": sorted(
            geo.get("test", {}).get("city", set()) & geo.get("train", {}).get("city", set())
        ),
        "subdivision_test_train": sorted(
            geo.get("test", {}).get("subdivision", set())
            & geo.get("train", {}).get("subdivision", set())
        ),
    }

    split_counts = {
        s: sum(1 for v in splits.values() if v == s) for s in ("train", "val", "test")
    }

    existing = session.execute(
        select(Dataset.version).where(Dataset.name == name)
        .order_by(Dataset.version.desc()).limit(1)
    ).scalar()

    dataset = Dataset(
        name=name,
        version=(existing + 1) if existing else 1,
        manifest_json=manifest,
        feature_spec_version=FEATURE_SPEC_VERSION,
        code_version=_code_version(),
        split_summary_json=split_counts,
        geo_summary_json={"splits": geo_summary, "overlap": overlap},
        created_by=created_by,
    )
    session.add(dataset)
    session.flush()
    for m in ordered:
        session.add(
            DatasetMember(
                dataset_id=dataset.id,
                snapshot_id=m["snapshot"].id,
                review_id=m["review"].id,
                split=splits[m["snapshot"].id],
            )
        )
    session.flush()
    return dataset


def real_data_training_enabled() -> bool:
    """CDARV_REAL_DATA_TRAINING_ENABLED — default OFF.

    When off, only snapshots whose report payload carries an explicit
    synthetic marker (report_json.meta.synthetic == true) may enter a
    training dataset. Provider-derived real reports can still be
    submitted, reviewed, labeled, and approved — they just cannot cross
    into training while the flag is off.
    """
    return os.environ.get("CDARV_REAL_DATA_TRAINING_ENABLED", "").strip().lower() in (
        "1", "true", "yes",
    )


def _is_synthetic(snapshot: Snapshot) -> bool:
    rj = snapshot.report_json
    return (
        isinstance(rj, dict)
        and isinstance(rj.get("meta"), dict)
        and rj["meta"].get("synthetic") is True
    )


def dataset_examples(session: Session, dataset: Dataset) -> list[dict[str, Any]]:
    """Re-derive examples from the pinned manifest versions.

    Returns one dict per labeled comp: {snapshot_id, split, comp_id,
    features, y, rule_context}. not_reviewed comps are excluded — they are
    not negatives.
    """
    from ..reports import parse_report
    from .features import extract_comp_features, extract_rule_context
    from ..persistence.models import CompLabel

    out: list[dict[str, Any]] = []
    members = session.execute(
        select(DatasetMember).where(DatasetMember.dataset_id == dataset.id)
    ).scalars().all()
    label_by_review: dict[str, dict[str, CompLabel]] = {}
    gold_by_review: dict[str, bool] = {}
    review_ids = [m.review_id for m in members]
    if review_ids:
        for row in session.execute(
            select(CompLabel).where(CompLabel.review_id.in_(review_ids))
        ).scalars():
            label_by_review.setdefault(row.review_id, {})[row.comp_id] = row
        for appr in session.execute(
            select(Approval).where(Approval.review_id.in_(review_ids))
        ).scalars():
            gold_by_review[appr.review_id] = appr.gold_standard

    for member in members:
        snap = session.get(Snapshot, member.snapshot_id)
        rev = session.get(Review, member.review_id)
        if snap is None or rev is None:
            continue
        parsed = parse_report(
            report_id=snap.report_id, user_id=snap.user_id,
            created_at=snap.provenance_json.get("report_created_at") or "",
            report_json=snap.report_json,
        )
        labels = label_by_review.get(rev.id, {})
        for comp in parsed.comps:
            lab = labels.get(comp.comp_id)
            if lab is None or lab.label == "not_reviewed":
                continue
            y = 1 if lab.label in ("strong_arv", "usable_with_adjustment") else 0
            out.append(
                {
                    "snapshot_id": snap.id,
                    "split": member.split,
                    "comp_id": comp.comp_id,
                    "transaction_key": comp.transaction_key,
                    "features": extract_comp_features(parsed, comp),
                    "rule_context": extract_rule_context(parsed, comp),
                    "label": lab.label,
                    "y": y,
                    "gold_standard": gold_by_review.get(rev.id, False),
                }
            )
    return out


__all__ = ["approved_members", "build_dataset", "dataset_examples"]
