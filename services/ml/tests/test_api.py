"""End-to-end over HTTP: submit → review → approve → dataset → train job
→ worker → shadow activate → score → prediction. Demonstrates the full
human-curated loop against the real service surface."""

import json
import os

import pytest

TOKEN = "test-internal-token"


@pytest.fixture
def client(tmp_path, monkeypatch):
    db = tmp_path / "cdarv.sqlite"
    monkeypatch.setenv("CDARV_TEST_PROFILE", "true")
    monkeypatch.setenv("CDARV_DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setenv("CDARV_INTERNAL_API_TOKEN", TOKEN)

    from cdarv.api import deps
    from cdarv.persistence.db import create_schema
    deps._engine = None
    engine = deps.get_engine()

    from sqlalchemy import event

    @event.listens_for(engine, "connect")
    def _fk_on(c, _r):
        c.execute("PRAGMA foreign_keys = ON")

    create_schema(engine)

    from fastapi.testclient import TestClient
    from cdarv.app import app
    with TestClient(app) as tc:
        yield tc

    deps._engine = None


def _auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def _submit(client, report_id, payload, created_at="2026-09-01T00:00:00Z"):
    return client.post("/v1/submissions", headers=_auth(), json={
        "report_id": report_id, "user_id": "u1", "created_at": created_at,
        "report_json": payload, "submitted_by": "tester",
    })


def test_auth_required(client):
    assert client.get("/v1/queue").status_code == 401
    assert client.get("/v1/queue", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_health_open(client):
    assert client.get("/health").status_code == 200


def test_full_learning_loop(client, monkeypatch):
    from conftest import make_report

    # 1. Submit three reports (synthetic fixtures).
    snap_ids = []
    for i in range(3):
        resp = _submit(client, f"r{i}", make_report(f"r{i}"),
                       created_at=f"2026-0{i + 7}-01T00:00:00Z")
        assert resp.status_code == 201, resp.text
        snap_ids.append(resp.json()["snapshot"]["id"])

    # Idempotent: resubmit returns duplicate, not a second row.
    resp = _submit(client, "r0", make_report("r0"), created_at="2026-07-01T00:00:00Z")
    assert resp.json()["outcome"] == "duplicate"

    queue = client.get("/v1/queue", headers=_auth()).json()["snapshots"]
    assert len(queue) == 3

    # 2. Review + label + approve one snapshot.
    snap_id = snap_ids[0]
    review = client.post("/v1/reviews", headers=_auth(), json={
        "snapshot_id": snap_id, "reviewer_id": "rev1",
    }).json()
    review_id = review["review_id"]

    labels = [{"comp_id": f"r0-c{i}", "label": "strong_arv"} for i in range(3)]
    labels += [{"comp_id": f"r0-c{i}", "label": "unsuitable",
                "reasons": ["different_neighborhood"]} for i in range(3, 8)]
    resp = client.post(f"/v1/reviews/{review_id}/labels", headers=_auth(),
                       json={"labels": labels})
    assert resp.json()["labels_set"] == 8

    resp = client.post(f"/v1/reviews/{review_id}/decide", headers=_auth(), json={
        "action": "approve", "reviewer_id": "rev1", "comp_ranking": True,
    })
    assert resp.json()["status"] == "approved"

    # Approve the other two so a dataset has enough members.
    for i, sid in enumerate(snap_ids[1:], start=1):
        rv = client.post("/v1/reviews", headers=_auth(), json={
            "snapshot_id": sid, "reviewer_id": "rev1"}).json()
        client.post(f"/v1/reviews/{rv['review_id']}/labels", headers=_auth(),
                    json={"labels": [
                        {"comp_id": f"r{i}-c{j}", "label": "strong_arv"} for j in range(3)
                    ] + [
                        {"comp_id": f"r{i}-c{j}", "label": "unsuitable"} for j in range(3, 8)
                    ]})
        client.post(f"/v1/reviews/{rv['review_id']}/decide", headers=_auth(),
                    json={"action": "approve", "reviewer_id": "rev1",
                          "comp_ranking": True})

    # 3. Build dataset.
    resp = client.post("/v1/datasets", headers=_auth(), json={
        "name": "baseline", "created_by": "rev1", "scope": "comp_ranking",
    })
    assert resp.status_code == 201, resp.text
    dataset = resp.json()["dataset"]
    assert dataset["feature_spec_version"] == "v2"
    assert len(dataset["manifest"]["members"]) == 3

    # 4. Enqueue training + run the worker.
    resp = client.post("/v1/models/train", headers=_auth(),
                       json={"dataset_id": dataset["id"], "name": "baseline"})
    assert resp.status_code == 202

    from cdarv.worker.runner import Worker, WorkerConfig
    worker = Worker(WorkerConfig(owner="test"))
    assert worker.process_one() is True

    models = client.get("/v1/models", headers=_auth()).json()["models"]
    assert len(models) == 1
    model = models[0]
    assert model["status"] == "candidate"

    # 5. Activate shadow + score a snapshot (recalc stubbed — worker calls it).
    import cdarv.domain.shadow as shadow_mod
    monkeypatch.setattr(shadow_mod, "_recalc",
                        lambda rid, ids: {"valuation": {"arv": 265000}})

    resp = client.post("/v1/shadow/activate", headers=_auth(),
                       json={"model_id": model["id"], "activated_by": "admin"})
    assert resp.json()["shadow"]["active_model_id"] == model["id"]

    resp = client.post("/v1/shadow/score", headers=_auth(),
                       json={"snapshot_id": snap_ids[0]})
    assert resp.status_code == 202
    assert worker.process_one() is True

    preds = client.get(f"/v1/predictions?snapshot_id={snap_ids[0]}",
                       headers=_auth()).json()["predictions"]
    assert len(preds) == 1
    assert preds[0]["status"] == "scored"
    assert preds[0]["shadow_arv"] == 265000

    # 6. Rollback.
    resp = client.post("/v1/shadow/deactivate", headers=_auth())
    assert resp.json()["shadow"]["active_model_id"] is None

    # 7. Monitoring summary reports descriptive counts.
    summary = client.get("/v1/monitoring/summary", headers=_auth()).json()["summary"]
    assert summary["independently_reviewed_reports"] == 3
    assert summary["predictions_by_status"]["scored"] == 1
