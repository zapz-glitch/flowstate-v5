"""Baseline comp-selection model: pointwise logistic ranker.

Each candidate comp scores P(comp ∈ ideal selection). Shadow selection
ranks a report's pool by score — no listwise machinery needed for the
foundation. The artifact is a pickled dict: sklearn Pipeline plus the
feature-name contract, so a model version can never silently drift from
the features it was trained on.
"""

from __future__ import annotations

import hashlib
import json
import math
import pickle
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURE_NAMES
from .metrics import grouped_split, per_report_topk, summarize
from .store import Store

TARGETS = ("arv", "as_is", "selected", "enabled")


def _matrix(feature_dicts: list[dict[str, float]], feature_names: list[str]) -> np.ndarray:
    return np.array(
        [[row.get(name, math.nan) for name in feature_names] for row in feature_dicts],
        dtype=float,
    )


def _dataset_hash(report_ids: list[str], labels: list[int]) -> str:
    h = hashlib.sha256()
    for rid, y in zip(report_ids, labels):
        h.update(f"{rid}:{y}\n".encode())
    return h.hexdigest()


def build_pipeline() -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(max_iter=5000, class_weight="balanced")),
        ]
    )


def train(
    store: Store,
    *,
    target: str = "arv",
    name: str = "baseline",
    artifact_dir: str | Path = "artifacts",
    val_fraction: float = 0.2,
    seed: int = 42,
) -> dict[str, Any]:
    if target not in TARGETS:
        raise ValueError(f"target must be one of {TARGETS}")

    with store.connect() as conn:
        # comp_ids needed for per-report metrics — reload with ids.
        label_col = {"arv": "label_arv", "as_is": "label_as_is",
                     "selected": "label_selected", "enabled": "label_enabled"}[target]
        rows = conn.execute(
            f"""SELECT e.report_id, e.comp_id, e.features_json, e.{label_col} AS y
                FROM comp_examples e ORDER BY e.report_id, e.rank_in_report"""
        ).fetchall()

    if not rows:
        raise RuntimeError("no comp examples — run `cdarv ingest` first")

    report_ids = [r["report_id"] for r in rows]
    comp_ids = [r["comp_id"] for r in rows]
    X = _matrix([json.loads(r["features_json"]) for r in rows], FEATURE_NAMES)
    y = np.array([int(r["y"]) for r in rows], dtype=int)

    train_ids, val_ids = grouped_split(report_ids, val_fraction, seed)
    tr = np.array([rid in train_ids for rid in report_ids])
    va = ~tr

    model = build_pipeline()
    model.fit(X[tr], y[tr])

    metrics: dict[str, Any] = {
        "target": target,
        "features": len(FEATURE_NAMES),
        "train_examples": int(tr.sum()),
        "val_examples": int(va.sum()),
        "train_reports": len(train_ids),
        "val_reports": len(val_ids),
        "positive_rate": float(y.mean()),
    }

    if va.any():
        probs = model.predict_proba(X[va])[:, 1]
        yv = y[va]
        if len(np.unique(yv)) > 1:
            metrics["val_log_loss"] = float(log_loss(yv, probs, labels=[0, 1]))
            metrics["val_roc_auc"] = float(roc_auc_score(yv, probs))
        metrics["val_ranking"] = summarize(
            per_report_topk(
                [report_ids[i] for i in np.flatnonzero(va)],
                [int(v) for v in yv],
                list(probs),
                [comp_ids[i] for i in np.flatnonzero(va)],
            )
        )

    # Refit on everything — the artifact ships the all-data fit; val metrics
    # above remain the honest estimate of generalization.
    model.fit(X, y)

    artifact_dir = Path(artifact_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    ds_hash = _dataset_hash(report_ids, list(y))
    artifact = {
        "name": name,
        "target": target,
        "feature_names": FEATURE_NAMES,
        "model": model,
        "dataset_hash": ds_hash,
        "cdarv_version": __import__("cdarv").__version__,
    }
    artifact_path = artifact_dir / f"{name}_{ds_hash[:12]}.pkl"
    artifact_path.write_bytes(pickle.dumps(artifact))

    with store.connect() as conn:
        version_id = store.insert_model_version(
            conn,
            name=name,
            target=target,
            feature_names=FEATURE_NAMES,
            metrics=metrics,
            dataset_hash=ds_hash,
            train_report_count=len(set(report_ids)),
            train_example_count=len(rows),
            artifact_path=str(artifact_path),
        )
    metrics["model_version_id"] = version_id
    metrics["artifact_path"] = str(artifact_path)
    return metrics


def load_artifact(path: str | Path) -> dict[str, Any]:
    artifact = pickle.loads(Path(path).read_bytes())
    for key in ("model", "feature_names", "target"):
        if key not in artifact:
            raise ValueError(f"artifact {path} missing '{key}'")
    return artifact


def score(artifact: dict[str, Any], feature_dicts: list[dict[str, float]]) -> np.ndarray:
    X = _matrix(feature_dicts, artifact["feature_names"])
    return artifact["model"].predict_proba(X)[:, 1]


__all__ = ["TARGETS", "build_pipeline", "train", "load_artifact", "score"]
