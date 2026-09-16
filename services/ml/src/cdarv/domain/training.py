"""Candidate-model training over a frozen dataset.

Baseline: pointwise logistic ranker scoring P(comp ∈ ideal selection).
Training runs only inside the worker on an explicit `train_model` job —
never inside a request and never automatically on approval.
"""

from __future__ import annotations

import hashlib
import json
import math
import pickle
from typing import Any

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..metrics import per_report_topk, summarize
from ..persistence.models import Dataset, DatasetMember, Model
from .datasets import dataset_examples
from .features import FEATURE_NAMES


def _matrix(rows: list[dict[str, Any]], names: list[str]) -> np.ndarray:
    return np.array(
        [[r["features"].get(n, math.nan) for n in names] for r in rows],
        dtype=float,
    )


def build_pipeline() -> Pipeline:
    return Pipeline(
        [
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(max_iter=5000, class_weight="balanced")),
        ]
    )


def train_model(
    session: Session, *, dataset_id: str, name: str = "baseline",
) -> Model:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise ValueError("dataset not found")

    examples = dataset_examples(session, dataset)
    if not examples:
        raise ValueError("dataset has no labeled comp examples")

    X = _matrix(examples, FEATURE_NAMES)
    y = np.array([e["y"] for e in examples], dtype=int)
    snap_ids = [e["snapshot_id"] for e in examples]
    comp_ids = [e["comp_id"] for e in examples]
    splits = [e["split"] for e in examples]

    tr = np.array([s == "train" for s in splits])
    va = np.array([s == "val" for s in splits])
    te = np.array([s == "test" for s in splits])

    if len(np.unique(y[tr])) < 2:
        raise ValueError("training split has a single class — more reviewed data needed")

    model = build_pipeline()
    model.fit(X[tr], y[tr])

    def _block(mask: np.ndarray) -> dict[str, Any]:
        if not mask.any():
            return {"examples": 0}
        probs = model.predict_proba(X[mask])[:, 1]
        ym = y[mask]
        block: dict[str, Any] = {
            "examples": int(mask.sum()),
            "reports": len({snap_ids[i] for i in np.flatnonzero(mask)}),
            "positive_rate": float(ym.mean()),
        }
        if len(np.unique(ym)) > 1:
            block["log_loss"] = float(log_loss(ym, probs, labels=[0, 1]))
            block["roc_auc"] = float(roc_auc_score(ym, probs))
        ranking = summarize(
            per_report_topk(
                [snap_ids[i] for i in np.flatnonzero(mask)],
                [int(v) for v in ym],
                list(probs),
                [comp_ids[i] for i in np.flatnonzero(mask)],
            )
        )
        block["ranking"] = ranking
        # Diagnostic only: agreement with the ORIGINAL evaluator selection —
        # not proof of quality.
        eval_sel = np.array(
            [1 if examples[i]["rule_context"]["evaluator_selected"] else 0
             for i in range(len(examples))],
            dtype=int,
        )
        eval_rank = summarize(
            per_report_topk(
                [snap_ids[i] for i in np.flatnonzero(mask)],
                [int(eval_sel[i]) for i in np.flatnonzero(mask)],
                list(probs),
                [comp_ids[i] for i in np.flatnonzero(mask)],
            )
        )
        block["evaluator_agreement"] = eval_rank
        return block

    # Missing-data rates per feature — a data-gap report, not a fix.
    missing = {
        n: float(np.isnan(X[:, j]).mean())
        for j, n in enumerate(FEATURE_NAMES)
    }

    metrics = {
        "dataset_id": dataset.id,
        "dataset_version": dataset.version,
        "feature_spec_version": dataset.feature_spec_version,
        "code_version": dataset.code_version,
        "label_counts": {
            "positive": int(y.sum()),
            "negative": int((y == 0).sum()),
            "examples": int(len(y)),
            "reviewed_reports": len(set(snap_ids)),
        },
        "splits": {
            "train": _block(tr),
            "val": _block(va),
            "test": _block(te),
        },
        "feature_missing_rate": missing,
    }

    ds_hash = hashlib.sha256(
        json.dumps(dataset.manifest_json, sort_keys=True).encode()
    ).hexdigest()

    artifact = {
        "name": name,
        "target": "comp_selection",
        "feature_names": FEATURE_NAMES,
        "feature_spec_version": dataset.feature_spec_version,
        "model": model.fit(X, y),  # final artifact refit on all labeled data
        "dataset_id": dataset.id,
        "dataset_hash": ds_hash,
    }

    existing = session.execute(
        select(Model.version).where(Model.name == name)
        .order_by(Model.version.desc()).limit(1)
    ).scalar()

    row = Model(
        name=name,
        version=(existing + 1) if existing else 1,
        dataset_id=dataset.id,
        target="comp_selection",
        feature_names_json=FEATURE_NAMES,
        metrics_json=metrics,
        dataset_hash=ds_hash,
        artifact=pickle.dumps(artifact),
        status="candidate",
    )
    session.add(row)
    session.flush()
    return row


def load_artifact(model_row: Model) -> dict[str, Any]:
    return pickle.loads(model_row.artifact)


def score_features(artifact: dict[str, Any], features: list[dict[str, float]]) -> np.ndarray:
    names = artifact["feature_names"]
    X = np.array(
        [[f.get(n, math.nan) for n in names] for f in features], dtype=float
    )
    return artifact["model"].predict_proba(X)[:, 1]


__all__ = ["build_pipeline", "load_artifact", "score_features", "train_model"]
