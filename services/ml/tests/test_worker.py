"""Worker + training: jobs process in the worker, never in a request."""

import os

import pytest
from sqlalchemy import create_engine, event, select

from cdarv.domain.datasets import build_dataset
from cdarv.domain.registry import activate_shadow, deactivate_shadow, shadow_state
from cdarv.domain.training import train_model
from cdarv.persistence import repositories as repo
from cdarv.persistence.db import create_schema, create_session_factory
from cdarv.persistence.models import Job, Model, Prediction
from conftest import approve_review, submit_payload


def _approved(session, n: int):
    for i in range(n):
        snap, _ = submit_payload(
            session, f"r{i}", created_at=f"2026-0{(i % 8) + 1}-15T00:00:00Z")
        approve_review(session, snap)


def test_train_produces_versioned_model(session):
    _approved(session, 6)
    dataset = build_dataset(session, name="d", created_by="test", seed=42)
    model = train_model(session, dataset_id=dataset.id, name="baseline")

    assert model.version == 1
    assert model.status == "candidate"
    assert model.dataset_id == dataset.id
    assert model.artifact  # pickled pipeline
    metrics = model.metrics_json
    assert metrics["feature_spec_version"] == "v2"
    assert metrics["label_counts"]["reviewed_reports"] == 6
    # Evaluator agreement is diagnostic-only but present.
    assert "evaluator_agreement" in metrics["splits"]["train"]

    # A second run versions up — never overwrites.
    model2 = train_model(session, dataset_id=dataset.id, name="baseline")
    assert model2.version == 2
    assert model2.id != model.id


def test_worker_processes_train_job(tmp_path, monkeypatch):
    """End-to-end: enqueue → worker claims → model row appears."""
    db = tmp_path / "cdarv.sqlite"
    monkeypatch.setenv("CDARV_TEST_PROFILE", "true")
    monkeypatch.setenv("CDARV_DATABASE_URL", f"sqlite:///{db}")

    engine = create_engine(f"sqlite:///{db}")

    @event.listens_for(engine, "connect")
    def _fk_on(c, _r):
        c.execute("PRAGMA foreign_keys = ON")

    create_schema(engine)
    factory = create_session_factory(engine)

    with factory() as session:
        _approved(session, 6)
        dataset = build_dataset(session, name="d", created_by="test")
        job = repo.enqueue(session, "train_model",
                           {"dataset_id": dataset.id, "name": "baseline"})
        session.commit()

        from cdarv.worker.runner import Worker, WorkerConfig
        worker = Worker(WorkerConfig(owner="test-worker"))
        worker.engine = engine
        worker.session_factory = factory
        assert worker.process_one() is True

        session.expire_all()
        job = session.get(Job, job.id)
        assert job.status == "succeeded"
        assert job.result_json["model_id"]
        assert session.execute(select(Model)).scalar_one().version == 1


def test_worker_recovers_expired_lease(session):
    job = repo.enqueue(session, "shadow_score", {"snapshot_id": "x"})
    claimed = repo.claim_next(session, owner="w1")
    assert claimed and claimed.status == "running"
    # Force lease expiry, then another worker recovers it.
    claimed.lease_expires_at = claimed.lease_expires_at.replace(year=2000)
    session.flush()
    assert repo.recover_expired(session) == 1
    reclaimed = repo.claim_next(session, owner="w2")
    assert reclaimed and reclaimed.id == job.id


def test_shadow_activation_and_rollback(session):
    _approved(session, 5)
    dataset = build_dataset(session, name="d", created_by="test")
    m1 = train_model(session, dataset_id=dataset.id, name="baseline")
    m2 = train_model(session, dataset_id=dataset.id, name="baseline")

    state = activate_shadow(session, model_id=m1.id, activated_by="admin")
    assert state["active_model_id"] == m1.id
    assert m1.status == "shadow"

    # Switching models demotes the old one; nothing is deleted.
    state = activate_shadow(session, model_id=m2.id, activated_by="admin")
    assert state["active_model_id"] == m2.id
    assert m1.status == "candidate"

    # Rollback: deactivate stops shadow scoring; history preserved.
    state = deactivate_shadow(session)
    assert state["active_model_id"] is None
    assert m2.status == "candidate"
    assert shadow_state(session)["active_model_id"] is None
