"""V4-104 application-layer tests (isolated PostgreSQL, no HTTP)."""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from eval_engine.api.errors import ApiFailure
from eval_engine.application.service import execution_status, submit_batch
from eval_engine.persistence.models import Batch

import tests.test_api as api_cases

MAINT_URL = api_cases.MAINT_URL


@pytest.fixture(scope="module")
def app_engine():
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    db_name = f"v4app_{uuid.uuid4().hex[:12]}"
    with maint.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = MAINT_URL.rsplit("/", 1)[0] + f"/{db_name}"
    engine = create_engine(url, pool_pre_ping=True)
    from alembic import command
    from alembic.config import Config

    ini = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
    cfg = Config(ini)
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(cfg, "head")
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
    yield engine
    engine.dispose()
    with maint.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    maint.dispose()


@pytest.fixture()
def session(app_engine):
    maker = sessionmaker(bind=app_engine, expire_on_commit=False)
    with maker() as sess:
        yield sess
        sess.rollback()


def test_validation_before_transaction_no_writes(session):
    maker = sessionmaker(bind=session.bind)
    with maker() as probe:
        before = probe.execute(select(Batch)).scalars().all()
    assert before == []
    with pytest.raises(ApiFailure) as exc:
        submit_batch(session, tenant_id="t-app", batch_key="bad", body={"evaluations": [], "settings": {}})
    assert exc.value.code == "VALIDATION_ERROR"
    session.rollback()
    with maker() as probe:
        assert probe.execute(select(Batch)).scalars().all() == []


def test_fully_typed_requests_accepted(session):
    body = api_cases._body(2, key_prefix=f"app-{uuid.uuid4().hex[:6]}")
    batch, created, summaries = submit_batch(session, tenant_id="t-app", batch_key=f"k-{uuid.uuid4().hex[:8]}", body=body)
    session.commit()
    assert created and len(summaries) == 2
    assert all(s["status"] == "COMPLETED" for s in summaries)


def test_result_snapshot_refs_validated(session):
    from eval_engine.persistence import repositories as repo

    body = api_cases._body(1, key_prefix=f"ref-{uuid.uuid4().hex[:6]}")
    batch, _, summaries = submit_batch(session, tenant_id="t-ref", batch_key=f"k-{uuid.uuid4().hex[:8]}", body=body)
    session.commit()
    maker = sessionmaker(bind=session.bind)
    with maker() as probe:
        from eval_engine.persistence.models import EvaluationResult

        rows = probe.execute(
            select(EvaluationResult).where(EvaluationResult.tenant_id == "t-ref")
        ).scalars().all()
        assert rows
        probe.expire_all()
        batch_id = batch.id
        snap_id = probe.execute(
            select(Batch.snapshot_id).where(Batch.id == batch_id)
        ).scalar_one()
        for row in rows:
            assert row.snapshot_id == snap_id
            assert row.status in ("VALUED", "REVIEW_REQUIRED", "INSUFFICIENT_COMPS", "INSUFFICIENT_INVESTOR_DATA", "INCOMPLETE", "FAILED")
            assert row.result_payload["settings_snapshot_id"] == str(batch.snapshot_id)


def test_status_mapping_explicit():
    assert execution_status("succeeded", "VALUED") == "COMPLETED"
    assert execution_status("succeeded", "INSUFFICIENT_COMPS") == "INSUFFICIENT_COMPS"
    assert execution_status("queued", None) == "QUEUED"
    assert execution_status("running", None) == "RUNNING"
    assert execution_status("failed", None) == "FAILED"
    assert execution_status("dead", None) == "FAILED"
