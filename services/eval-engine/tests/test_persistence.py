"""Isolated PostgreSQL persistence tests for V4 (no SQLite fallback).

Uses a distinct temporary database per session on the isolated test
container (v4-persist-pg-102, 127.0.0.1:55440). Never touches production
or Neon integration stores. Set V4_TEST_DATABASE_URL to override the
maintenance URL; the harness always creates and drops a unique database.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from eval_engine.persistence import repositories as repo
from eval_engine.persistence.db import (
    NonPostgreSQLError,
    require_postgresql_url,
)
from eval_engine.persistence.models import Base, Evaluation
from eval_engine.persistence.repositories import (
    IdempotencyConflict,
    claim_next_evaluation,
    commit_result,
    create_batch_with_evaluations,
    fail_evaluation,
    get_batch_progress,
    heartbeat_lease,
    recover_stale_leases,
    store_settings_snapshot,
)

MAINT_URL = os.environ.get(
    "V4_TEST_DATABASE_URL",
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test",
)
TEST_CONTAINER = "v4-persist-pg-102"
TEST_PORT = 55440


def _guard_maintenance_url(url: str) -> None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    port = parsed.port or 5432
    if "neon.tech" in url or "neon" in host:
        raise RuntimeError("refusing test URL pointing at Neon")
    tail = url.lower().split("@")[-1]
    if "prod" in tail:
        raise RuntimeError("refusing test URL that looks like production")
    if host not in {"127.0.0.1", "localhost"} or port != TEST_PORT:
        raise RuntimeError(
            "tests run only against the isolated container "
            f"127.0.0.1:{TEST_PORT}"
        )


def _port_open(port: int) -> bool:
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _ensure_test_container() -> None:
    if shutil.which("docker") is None:
        raise RuntimeError("docker is required for isolated persistence tests")
    if _port_open(TEST_PORT):
        return
    subprocess.run(
        ["docker", "rm", "-f", TEST_CONTAINER],
        capture_output=True,
        check=False,
    )
    proc = subprocess.run(
        [
            "docker", "run", "-d", "--name", TEST_CONTAINER,
            "-e", "POSTGRES_USER=v4test",
            "-e", "POSTGRES_PASSWORD=v4testpw",
            "-e", "POSTGRES_DB=v4test",
            "-p", f"127.0.0.1:{TEST_PORT}:5432",
            "postgres:16-alpine",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not start isolated PG: {proc.stderr[-500:]}")
    for _ in range(30):
        if _port_open(TEST_PORT):
            break
        time.sleep(1)
    engine = create_engine(MAINT_URL, connect_args={"connect_timeout": 2})
    for _ in range(30):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            break
        except OperationalError:
            time.sleep(1)
    engine.dispose()


def _maintenance_engine():
    _guard_maintenance_url(MAINT_URL)
    require_postgresql_url(MAINT_URL)
    return create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")


@pytest.fixture(scope="module")
def test_engine():
    _ensure_test_container()
    _guard_maintenance_url(MAINT_URL)
    require_postgresql_url(MAINT_URL)
    db_name = f"v4test_{uuid.uuid4().hex[:12]}"
    maint = _maintenance_engine()
    with maint.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = MAINT_URL.rsplit("/", 1)[0] + f"/{db_name}"
    engine = create_engine(url, pool_pre_ping=True)
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()
    with maint.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    maint.dispose()


@pytest.fixture()
def session(test_engine):
    maker = sessionmaker(bind=test_engine, expire_on_commit=False)
    with maker() as sess:
        yield sess
        sess.rollback()


def _items(n: int, prefix: str = "prop") -> list[dict]:
    return [
        {
            "idempotency_key": f"{prefix}-{i}",
            "payload": {"address": f"{i} Main St", "n": i},
        }
        for i in range(n)
    ]


def test_snapshot_store_is_content_addressed(session: Session):
    first = store_settings_snapshot(
        session,
        tenant_id="t-snap",
        snapshot_version="v1",
        content={"rate": "12.5", "tiers": [1, 2]},
        source={"rate": "user_default"},
    )
    session.commit()
    again = store_settings_snapshot(
        session,
        tenant_id="t-snap",
        snapshot_version="v1",
        content={"rate": "12.5", "tiers": [1, 2]},
        source={"rate": "user_default"},
    )
    session.commit()
    assert again.id == first.id
    other = store_settings_snapshot(
        session,
        tenant_id="t-snap",
        snapshot_version="v1",
        content={"rate": "13.5", "tiers": [1, 2]},
    )
    session.commit()
    assert other.id != first.id
    assert other.content_hash != first.content_hash


def test_batch_idempotency_same_key_same_payload_reuses(session: Session):
    payload = {"run": "a", "props": 2}
    first = create_batch_with_evaluations(
        session,
        tenant_id="t-idem",
        idempotency_key="batch-1",
        request_payload=payload,
        items=_items(2),
    )
    session.commit()
    second = create_batch_with_evaluations(
        session,
        tenant_id="t-idem",
        idempotency_key="batch-1",
        request_payload=payload,
        items=_items(2),
    )
    session.commit()
    assert second.id == first.id


def test_batch_idempotency_same_key_different_payload_conflicts(session: Session):
    create_batch_with_evaluations(
        session,
        tenant_id="t-conf",
        idempotency_key="batch-c",
        request_payload={"run": "a"},
        items=_items(1),
    )
    session.commit()
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session,
            tenant_id="t-conf",
            idempotency_key="batch-c",
            request_payload={"run": "b"},
            items=_items(1),
        )
    session.rollback()


def test_tenant_isolation(session: Session):
    payload = {"run": "shared"}
    batch_a = create_batch_with_evaluations(
        session,
        tenant_id="tenant-a",
        idempotency_key="shared-key",
        request_payload=payload,
        items=_items(1, prefix="a"),
    )
    batch_b = create_batch_with_evaluations(
        session,
        tenant_id="tenant-b",
        idempotency_key="shared-key",
        request_payload=payload,
        items=_items(1, prefix="b"),
    )
    session.commit()
    assert batch_a.id != batch_b.id
    progress = get_batch_progress(
        session, tenant_id="tenant-a", batch_id=batch_a.id
    )
    assert progress["tenant_id"] == "tenant-a"
    with pytest.raises(KeyError):
        get_batch_progress(session, tenant_id="tenant-b", batch_id=batch_a.id)


def test_atomic_claims_no_double_claim(session: Session):
    batch = create_batch_with_evaluations(
        session,
        tenant_id="t-claim",
        idempotency_key="batch-claim",
        request_payload={"run": "claim"},
        items=_items(2, prefix="claim"),
    )
    session.commit()
    first = claim_next_evaluation(
        session, tenant_id="t-claim", lease_owner="worker-1"
    )
    session.commit()
    assert first is not None
    second = claim_next_evaluation(
        session, tenant_id="t-claim", lease_owner="worker-2"
    )
    session.commit()
    assert second is not None
    assert second.evaluation_id != first.evaluation_id
    third = claim_next_evaluation(
        session, tenant_id="t-claim", lease_owner="worker-3"
    )
    session.commit()
    assert third is None
    assert batch.id is not None


def test_lease_expiry_recovery(session: Session):
    create_batch_with_evaluations(
        session,
        tenant_id="t-lease",
        idempotency_key="batch-lease",
        request_payload={"run": "lease"},
        items=_items(1, prefix="lease"),
    )
    session.commit()
    claim = claim_next_evaluation(
        session, tenant_id="t-lease", lease_owner="worker-1"
    )
    session.commit()
    assert claim is not None
    assert heartbeat_lease(
        session, evaluation_id=claim.evaluation_id, lease_owner="worker-1"
    )
    assert not heartbeat_lease(
        session, evaluation_id=claim.evaluation_id, lease_owner="impostor"
    )
    session.commit()
    row = session.get(Evaluation, claim.evaluation_id)
    assert row is not None
    row.lease_expires_at = row.lease_expires_at - timedelta(hours=1)
    session.commit()
    future = datetime.now(timezone.utc) + timedelta(hours=2)
    recovered = recover_stale_leases(
        session, tenant_id="t-lease", now=future
    )
    session.commit()
    assert recovered >= 1
    reclaim = claim_next_evaluation(
        session,
        tenant_id="t-lease",
        lease_owner="worker-2",
        now=future + timedelta(hours=1, minutes=1),
    )
    session.commit()
    assert reclaim is not None
    assert reclaim.evaluation_id == claim.evaluation_id


def test_result_commit_idempotency_and_versioning(session: Session):
    batch = create_batch_with_evaluations(
        session,
        tenant_id="t-result",
        idempotency_key="batch-result",
        request_payload={"run": "result"},
        items=_items(1, prefix="res"),
    )
    session.commit()
    claim = claim_next_evaluation(
        session, tenant_id="t-result", lease_owner="worker-1"
    )
    session.commit()
    assert claim is not None
    first = commit_result(
        session,
        tenant_id="t-result",
        evaluation_id=claim.evaluation_id,
        methodology_version="evaluation-v4",
        snapshot_id=None,
        status="succeeded",
        result_payload={"value": "100000"},
    )
    session.commit()
    assert first.version == 1
    same = commit_result(
        session,
        tenant_id="t-result",
        evaluation_id=claim.evaluation_id,
        methodology_version="evaluation-v4",
        snapshot_id=None,
        status="succeeded",
        result_payload={"value": "100000"},
    )
    session.commit()
    assert same.id == first.id
    assert same.version == 1
    second = commit_result(
        session,
        tenant_id="t-result",
        evaluation_id=claim.evaluation_id,
        methodology_version="evaluation-v4",
        snapshot_id=None,
        status="succeeded",
        result_payload={"value": "110000"},
    )
    session.commit()
    assert second.version == 2
    progress = get_batch_progress(
        session, tenant_id="t-result", batch_id=batch.id
    )
    assert progress["succeeded"] == 1
    assert progress["total"] == 1


def test_per_property_failure_and_batch_counts(session: Session):
    batch = create_batch_with_evaluations(
        session,
        tenant_id="t-counts",
        idempotency_key="batch-counts",
        request_payload={"run": "counts"},
        items=_items(3, prefix="cnt"),
    )
    session.commit()
    claims = []
    for _ in range(3):
        claim = claim_next_evaluation(
            session, tenant_id="t-counts", lease_owner="worker-1"
        )
        session.commit()
        assert claim is not None
        claims.append(claim)
    commit_result(
        session,
        tenant_id="t-counts",
        evaluation_id=claims[0].evaluation_id,
        methodology_version="evaluation-v4",
        snapshot_id=None,
        status="succeeded",
        result_payload={"value": "1"},
    )
    commit_result(
        session,
        tenant_id="t-counts",
        evaluation_id=claims[1].evaluation_id,
        methodology_version="evaluation-v4",
        snapshot_id=None,
        status="failed",
        result_payload={"error": "bad-evidence"},
    )
    session.commit()
    progress = get_batch_progress(
        session, tenant_id="t-counts", batch_id=batch.id
    )
    assert progress["total"] == 3
    assert progress["succeeded"] == 1
    assert progress["failed"] == 1
    assert progress["status"] == "running"


def test_bounded_retry_scheduling_and_dead(session: Session):
    create_batch_with_evaluations(
        session,
        tenant_id="t-retry",
        idempotency_key="batch-retry",
        request_payload={"run": "retry"},
        items=[{"idempotency_key": "r-0", "payload": {"a": 1}, "max_attempts": 1}],
    )
    session.commit()
    claim = claim_next_evaluation(
        session, tenant_id="t-retry", lease_owner="worker-1"
    )
    session.commit()
    assert claim is not None
    status = fail_evaluation(
        session,
        evaluation_id=claim.evaluation_id,
        error_code="transient",
        error_detail="boom",
    )
    session.commit()
    assert status == "dead"
    row = session.get(Evaluation, claim.evaluation_id)
    assert row is not None
    assert row.status == "dead"


def test_retry_delay_is_bounded():
    assert repo._retry_delay(1) == timedelta(seconds=30)
    assert repo._retry_delay(100) <= timedelta(hours=1)


def test_postgresql_only_guard():
    with pytest.raises(NonPostgreSQLError):
        require_postgresql_url("sqlite:///:memory:")
