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
def app_engine(isolated_pg):
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
        submit_batch(
            session, tenant_id="t-app", requested_by_user_id="u-app",
            batch_key="bad", body={"evaluations": [], "settings": {}},
        )
    assert exc.value.code == "VALIDATION_ERROR"
    session.rollback()
    with maker() as probe:
        assert probe.execute(select(Batch)).scalars().all() == []


def test_fully_typed_requests_persist_queued(session):
    body = api_cases._body(2, key_prefix=f"app-{uuid.uuid4().hex[:6]}")
    batch, created, summaries = submit_batch(
        session, tenant_id="t-app", requested_by_user_id="u-app",
        batch_key=f"k-{uuid.uuid4().hex[:8]}", body=body,
    )
    session.commit()
    assert created and len(summaries) == 2
    assert all(s["status"] == "QUEUED" for s in summaries)
    assert str(batch.status) == "pending"


def test_provider_pending_persists_with_evidence_mode(session):
    body = api_cases._body(1, key_prefix=f"ppm-{uuid.uuid4().hex[:6]}", mode="provider_pending")
    batch, created, summaries = submit_batch(
        session, tenant_id="t-ppm", requested_by_user_id="u-ppm",
        batch_key=f"k-{uuid.uuid4().hex[:8]}", body=body,
    )
    session.commit()
    assert created and summaries[0]["status"] == "QUEUED"
    maker = sessionmaker(bind=session.bind)
    with maker() as probe:
        from eval_engine.persistence.models import Evaluation

        row = probe.execute(
            select(Evaluation).where(Evaluation.batch_id == batch.id)
        ).scalar_one()
        assert row.checkpoint["evidence_mode"] == "provider_pending"
        assert row.input_payload["evidence_mode"] == "provider_pending"
        assert row.input_payload["acquisition"]["subject"]


def test_owner_scoping_no_cross_user_reuse(session):
    body = api_cases._body(1, key_prefix="own-0")
    first, created, _ = submit_batch(
        session, tenant_id="t-own", requested_by_user_id="u-1",
        batch_key="shared-key", body=body,
    )
    session.commit()
    assert created
    second, created_again, _ = submit_batch(
        session, tenant_id="t-own", requested_by_user_id="u-2",
        batch_key="shared-key", body=body,
    )
    session.commit()
    assert created_again and second.id != first.id


def test_status_mapping_explicit():
    assert execution_status("succeeded", "VALUED") == "COMPLETED"
    assert execution_status("succeeded", "INSUFFICIENT_COMPS") == "INSUFFICIENT_COMPS"
    assert execution_status("queued", None) == "QUEUED"
    assert execution_status("running", None) == "RUNNING"
    assert execution_status("failed", None) == "FAILED"
    assert execution_status("dead", None) == "FAILED"
