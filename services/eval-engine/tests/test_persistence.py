"""Isolated PostgreSQL persistence tests for V4 (no SQLite fallback).

Uses a distinct temporary database per session on the isolated test
container (v4-persist-pg-102, 127.0.0.1:55440). Never touches production
or Neon integration stores. Set V4_TEST_DATABASE_URL to override the
maintenance URL; the harness always creates and drops a unique database.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from eval_engine.persistence import repositories as repo
from eval_engine.persistence.db import (
    NonPostgreSQLError,
    canonical_hash,
    normalize_postgresql_url,
    require_postgresql_url,
)
from eval_engine.persistence.models import (
    Base,
    Batch,
    Evaluation,
    EvaluationResult,
    SettingsSnapshot,
)
from eval_engine.persistence.repositories import (
    IdempotencyConflict,
    LeaseMismatch,
    TerminalReplay,
    claim_next_evaluation,
    commit_result,
    create_batch_with_evaluations,
    fail_evaluation,
    get_batch_progress,
    get_evaluation,
    heartbeat_lease,
    mark_running,
    recover_stale_leases,
    save_checkpoint,
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


def _apply_schema(engine, url: str | None = None) -> None:
    from alembic.config import Config
    from alembic import command

    ini = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
    cfg = Config(ini)
    cfg.set_main_option(
        "script_location", os.path.join(os.path.dirname(__file__), "..", "alembic")
    )
    target = url or str(engine.url)
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = target
    try:
        command.upgrade(cfg, "head")
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old


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
    _apply_schema(engine, url)
    yield engine
    engine.dispose()
    with maint.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    maint.dispose()


@pytest.fixture()
def maker(test_engine):
    return sessionmaker(bind=test_engine, expire_on_commit=False)


@pytest.fixture()
def session(maker):
    with maker() as sess:
        yield sess
        sess.rollback()


@pytest.fixture()
def snapshot(session: Session):
    row = store_settings_snapshot(
        session,
        tenant_id="t-default",
        snapshot_version="v1",
        content={"rate": "12.5", "tiers": [1, 2]},
        source={"rate": "user_default"},
    )
    session.commit()
    return row


def _items(n: int, prefix: str = "prop") -> list[dict]:
    return [
        {
            "idempotency_key": f"{prefix}-{i}",
            "payload": {"address": f"{i} Main St", "n": i},
        }
        for i in range(n)
    ]


def _tenant_snapshot(session: Session, tenant: str):
    row = store_settings_snapshot(
        session,
        tenant_id=tenant,
        snapshot_version="v1",
        content={"rate": "12.5", "tiers": [1, 2]},
        source={"rate": "user_default"},
    )
    session.commit()
    return row


def _bound_payload(session: Session, tenant: str, snapshot_id, extra: dict) -> dict:
    snap = session.execute(
        select(SettingsSnapshot).where(
            SettingsSnapshot.id == snapshot_id,
            SettingsSnapshot.tenant_id == tenant,
        )
    ).scalar_one()
    payload = dict(extra)
    payload["settings_snapshot_id"] = str(snapshot_id)
    payload["settings_content_hash"] = str(snap.content_hash)
    return payload


def _make_batch(session: Session, tenant: str, key: str, n: int = 1,
                prefix: str = "p", snapshot=None, payload=None, user: str = "u-legacy"):
    if snapshot is None or snapshot.tenant_id != tenant:
        snapshot = _tenant_snapshot(session, tenant)
    batch, _ = create_batch_with_evaluations(
        session,
        tenant_id=tenant,
        requested_by_user_id=user,
        idempotency_key=key,
        request_payload=payload or {"run": key},
        items=_items(n, prefix=prefix),
        snapshot_id=snapshot.id,
    )
    session.commit()
    return batch


def test_owner_scoped_idempotency_no_cross_user_reuse(session: Session):
    tenant = f"t-owner-{uuid.uuid4().hex[:6]}"
    snap = _tenant_snapshot(session, tenant)
    first, created = create_batch_with_evaluations(
        session, tenant_id=tenant,
        requested_by_user_id="u-1",
        idempotency_key="shared-key",
        request_payload={"run": "owner"},
        items=_items(1, prefix="own"),
        snapshot_id=snap.id,
    )
    session.commit()
    assert created
    second, created_again = create_batch_with_evaluations(
        session, tenant_id=tenant,
        requested_by_user_id="u-2",
        idempotency_key="shared-key",
        request_payload={"run": "owner"},
        items=_items(1, prefix="own"),
        snapshot_id=snap.id,
    )
    session.commit()
    assert created_again and second.id != first.id
    replayed, created_replay = create_batch_with_evaluations(
        session, tenant_id=tenant,
        requested_by_user_id="u-1",
        idempotency_key="shared-key",
        request_payload={"run": "owner"},
        items=_items(1, prefix="own"),
        snapshot_id=snap.id,
    )
    session.commit()
    assert replayed.id == first.id and created_replay is False
    with pytest.raises(KeyError):
        get_batch_progress(session, tenant_id=tenant, requested_by_user_id="u-2", batch_id=first.id)
    with pytest.raises(KeyError):
        get_evaluation(
            session, tenant_id=tenant, requested_by_user_id="u-2",
            evaluation_id=first.evaluations[0].id,
        )


def test_url_normalization_rejects_non_psycopg3():
    assert normalize_postgresql_url(
        "postgresql://u:p@127.0.0.1:55440/db"
    ) == "postgresql+psycopg://u:p@127.0.0.1:55440/db"
    with pytest.raises(NonPostgreSQLError):
        normalize_postgresql_url("sqlite:///:memory:")
    with pytest.raises(NonPostgreSQLError):
        normalize_postgresql_url("postgresql+psycopg2://u:p@127.0.0.1/db")


def test_snapshot_full_content_addressed(session: Session):
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
    changed_source = store_settings_snapshot(
        session,
        tenant_id="t-snap",
        snapshot_version="v1",
        content={"rate": "12.5", "tiers": [1, 2]},
        source={"rate": "zip_override"},
    )
    session.commit()
    assert changed_source.id != first.id
    changed_content = store_settings_snapshot(
        session,
        tenant_id="t-snap",
        snapshot_version="v1",
        content={"rate": "13.5", "tiers": [1, 2]},
        source={"rate": "user_default"},
    )
    session.commit()
    assert changed_content.id != first.id


def test_snapshot_decimal_and_key_order_canonicalization(session: Session):
    from decimal import Decimal

    first = store_settings_snapshot(
        session,
        tenant_id="t-canon",
        snapshot_version="v1",
        content={"rate": Decimal("12.50")},
        source={"b": 1, "a": 2},
    )
    session.commit()
    again = store_settings_snapshot(
        session,
        tenant_id="t-canon",
        snapshot_version="v1",
        content={"rate": Decimal("12.5")},
        source={"a": 2, "b": 1},
    )
    session.commit()
    assert again.id == first.id
    expected = canonical_hash(
        {
            "version": "v1",
            "content": {"rate": "12.5"},
            "source": {"a": 2, "b": 1},
        }
    )
    assert first.content_hash == expected


def test_snapshot_trigger_blocks_update_and_delete(session: Session):
    row = store_settings_snapshot(
        session,
        tenant_id="t-imm",
        snapshot_version="v1",
        content={"a": 1},
        source={"a": "sys"},
    )
    session.commit()
    with pytest.raises(Exception):
        session.execute(
            text("UPDATE v4_settings_snapshots SET content = :c WHERE id = :i"),
            {"c": json.dumps({"a": 2}), "i": row.id},
        )
    session.rollback()
    with pytest.raises(Exception):
        session.execute(
            text("DELETE FROM v4_settings_snapshots WHERE id = :i"),
            {"i": row.id},
        )
    session.rollback()


def test_batch_requires_snapshot_and_range(session: Session):
    with pytest.raises(ValueError):
        create_batch_with_evaluations(
            session,
            tenant_id="t-req",
                requested_by_user_id="u-legacy",
            idempotency_key="no-snap",
            request_payload={},
            items=_items(1),
            snapshot_id=None,
        )
    snap = store_settings_snapshot(
        session, tenant_id="t-req", snapshot_version="v1",
        content={"a": 1}, source={"a": "sys"},
    )
    session.commit()
    with pytest.raises(ValueError):
        create_batch_with_evaluations(
            session, tenant_id="t-req",
                requested_by_user_id="u-legacy", idempotency_key="empty",
            request_payload={}, items=[], snapshot_id=snap.id,
        )
    with pytest.raises(ValueError):
        create_batch_with_evaluations(
            session, tenant_id="t-req",
                requested_by_user_id="u-legacy", idempotency_key="big",
            request_payload={}, items=_items(51, prefix="big"),
            snapshot_id=snap.id,
        )


def test_batch_idempotency_same_key_same_payload_reuses(session: Session):
    payload = {"run": "a", "props": 2}
    snap = _tenant_snapshot(session, "t-idem")
    first, created = create_batch_with_evaluations(
        session, tenant_id="t-idem",
                requested_by_user_id="u-legacy", idempotency_key="batch-1",
        request_payload=payload, items=_items(2), snapshot_id=snap.id,
    )
    session.commit()
    assert created is True
    persisted = session.execute(
        select(func.count()).select_from(Evaluation).where(
            Evaluation.tenant_id == "t-idem", Evaluation.batch_id == first.id
        )
    ).scalar()
    assert persisted == 2
    second, reused = create_batch_with_evaluations(
        session, tenant_id="t-idem",
                requested_by_user_id="u-legacy", idempotency_key="batch-1",
        request_payload=payload, items=_items(2), snapshot_id=snap.id,
    )
    session.commit()
    assert second.id == first.id
    assert reused is False


def test_batch_rejects_duplicate_property_keys(session: Session):
    snap = _tenant_snapshot(session, "t-dupe")
    items = [
        {"idempotency_key": "same-prop", "payload": {"address": "1 Main St"}},
        {"idempotency_key": "same-prop", "payload": {"address": "2 Main St"}},
    ]
    with pytest.raises(ValueError, match="duplicate property idempotency key"):
        create_batch_with_evaluations(
            session, tenant_id="t-dupe",
                requested_by_user_id="u-legacy", idempotency_key="batch-dupe",
            request_payload={"run": "dupe"}, items=items,
            snapshot_id=snap.id,
        )
    session.rollback()
    absent = session.execute(
        select(func.count()).select_from(Batch).where(
            Batch.tenant_id == "t-dupe",
            Batch.idempotency_key == "batch-dupe",
        )
    ).scalar()
    assert absent == 0


def test_batch_rejects_property_key_owned_by_other_batch(session: Session):
    snap = _tenant_snapshot(session, "t-xbatch")
    first, created = create_batch_with_evaluations(
        session, tenant_id="t-xbatch",
                requested_by_user_id="u-legacy", idempotency_key="batch-first",
        request_payload={"run": "first"},
        items=[{"idempotency_key": "shared-prop", "payload": {"n": 1}}],
        snapshot_id=snap.id,
    )
    session.commit()
    assert created is True and first.id is not None
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session, tenant_id="t-xbatch",
                requested_by_user_id="u-legacy", idempotency_key="batch-second",
            request_payload={"run": "second"},
            items=[{"idempotency_key": "shared-prop", "payload": {"n": 1}}],
            snapshot_id=snap.id,
        )
    session.rollback()


def test_batch_idempotency_same_key_different_payload_conflicts(
    session: Session,
):
    snap = _tenant_snapshot(session, "t-conf")
    create_batch_with_evaluations(
        session, tenant_id="t-conf",
                requested_by_user_id="u-legacy", idempotency_key="batch-c",
        request_payload={"run": "a"}, items=_items(1), snapshot_id=snap.id,
    )
    session.commit()
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session, tenant_id="t-conf",
                requested_by_user_id="u-legacy", idempotency_key="batch-c",
            request_payload={"run": "b"}, items=_items(1), snapshot_id=snap.id,
        )
    session.rollback()


def test_batch_hash_covers_items_and_snapshot(session: Session):
    snap = _tenant_snapshot(session, "t-hash")
    other = store_settings_snapshot(
        session, tenant_id="t-hash", snapshot_version="v1",
        content={"rate": "99"}, source={"rate": "sys"},
    )
    session.commit()
    create_batch_with_evaluations(
        session, tenant_id="t-hash",
                requested_by_user_id="u-legacy", idempotency_key="batch-h",
        request_payload={"run": "h"}, items=_items(1, prefix="h1"),
        snapshot_id=snap.id,
    )
    session.commit()
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session, tenant_id="t-hash",
                requested_by_user_id="u-legacy", idempotency_key="batch-h",
            request_payload={"run": "h"}, items=_items(1, prefix="h2"),
            snapshot_id=snap.id,
        )
    session.rollback()
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session, tenant_id="t-hash",
                requested_by_user_id="u-legacy", idempotency_key="batch-h",
            request_payload={"run": "h"}, items=_items(1, prefix="h1"),
            snapshot_id=other.id,
        )
    session.rollback()


def test_idempotency_race_same_key_concurrent(maker):
    key = f"race-{uuid.uuid4().hex[:8]}"
    outcomes: list = []

    race_snap_id = _tenant_snapshot(maker(), "t-race").id
    maker().close()

    def worker():
        sess = maker()
        try:
            batch, _ = create_batch_with_evaluations(
                sess, tenant_id="t-race",
                requested_by_user_id="u-legacy", idempotency_key=key,
                request_payload={"run": "race"}, items=_items(1, prefix="rc"),
                snapshot_id=race_snap_id,
            )
            sess.commit()
            outcomes.append(("ok", str(batch.id)))
        except IdempotencyConflict as exc:
            sess.rollback()
            outcomes.append(("conflict", str(exc)))
        except Exception as exc:  # raw IntegrityError must not escape
            sess.rollback()
            outcomes.append(("raw", f"{type(exc).__name__}: {exc}"))
        finally:
            sess.close()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert outcomes and all(kind == "ok" for kind, _ in outcomes)
    assert len({batch_id for _, batch_id in outcomes}) == 1


def test_tenant_isolation(session: Session):
    payload = {"run": "shared"}
    other = store_settings_snapshot(
        session, tenant_id="tenant-b", snapshot_version="v1",
        content={"rate": "12.5"}, source={"rate": "sys"},
    )
    session.commit()
    snap_a = _tenant_snapshot(session, "tenant-a")
    batch_a, _ = create_batch_with_evaluations(
        session, tenant_id="tenant-a",
                requested_by_user_id="u-legacy", idempotency_key="shared-key",
        request_payload=payload, items=_items(1, prefix="a"),
        snapshot_id=snap_a.id,
    )
    batch_b, _ = create_batch_with_evaluations(
        session, tenant_id="tenant-b",
                requested_by_user_id="u-legacy", idempotency_key="shared-key",
        request_payload=payload, items=_items(1, prefix="b"),
        snapshot_id=other.id,
    )
    session.commit()
    assert batch_a.id != batch_b.id
    progress = get_batch_progress(session, tenant_id="tenant-a", batch_id=batch_a.id)
    assert progress["tenant_id"] == "tenant-a"
    with pytest.raises(KeyError):
        get_batch_progress(session, tenant_id="tenant-b", batch_id=batch_a.id)
    with pytest.raises(KeyError):
        get_evaluation(
            session,
            tenant_id="tenant-b",
            evaluation_id=batch_a.evaluations[0].id,
        )


def test_tenant_fk_enforced_by_direct_sql(session: Session):
    batch = _make_batch(session, "t-fk", "fk-1", n=1, prefix="fk")
    other_tenant_eval = session.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-fk", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    with pytest.raises(Exception):
        session.execute(
            text(
                "INSERT INTO v4_evaluations (id, tenant_id, batch_id, "
                " idempotency_key, request_hash, status, attempts, "
                " max_attempts, lease_generation, retriable, created_at, "
                " updated_at) VALUES (:id, 'intruder', :batch, 'x', 'h', "
                " 'queued', 0, 5, 0, true, now(), now())"
            ),
            {"id": uuid.uuid4(), "batch": batch.id},
        )
    session.rollback()
    with pytest.raises(Exception):
        session.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:id, 'intruder', :eval, 1, 'm', :snap, 'VALUED', "
                " '{}', 'h', now())"
            ),
            {"id": uuid.uuid4(), "eval": other_tenant_eval, "snap": batch.snapshot_id},
        )
    session.rollback()


def test_atomic_claims_no_double_claim(session: Session):
    batch = _make_batch(
        session, "t-claim", "batch-claim", n=2, prefix="claim"
    )
    first = claim_next_evaluation(session, tenant_id="t-claim", lease_owner="w-1")
    session.commit()
    assert first is not None and first.lease_token is not None
    second = claim_next_evaluation(session, tenant_id="t-claim", lease_owner="w-2")
    session.commit()
    assert second is not None
    assert second.evaluation_id != first.evaluation_id
    third = claim_next_evaluation(session, tenant_id="t-claim", lease_owner="w-3")
    session.commit()
    assert third is None
    assert batch.id is not None


def test_claim_contention_single_winner(maker):
    sess = maker()
    batch = _make_batch(
        sess, "t-cont", f"cont-{uuid.uuid4().hex[:8]}", n=1,
        prefix="ct",
    )
    cont_eval_id = sess.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-cont", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    sess.close()
    winners: list = []

    def worker(name: str):
        sess = maker()
        try:
            claim = claim_next_evaluation(
                sess, tenant_id="t-cont", lease_owner=name
            )
            sess.commit()
            if claim is not None:
                winners.append((name, str(claim.evaluation_id)))
        finally:
            sess.close()

    threads = [threading.Thread(target=worker, args=(f"w-{i}",)) for i in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(winners) == 1
    assert winners[0][1] == str(cont_eval_id)


def test_stale_worker_cannot_mutate(session: Session):
    batch = _make_batch(
        session, "t-fence", "fence-1", n=1, prefix="fn"
    )
    claim = claim_next_evaluation(session, tenant_id="t-fence", lease_owner="w-1")
    session.commit()
    assert claim is not None
    assert heartbeat_lease(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
    )
    assert not heartbeat_lease(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="impostor", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
    )
    assert not heartbeat_lease(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=uuid.uuid4(),
        lease_generation=claim.lease_generation,
    )
    assert not heartbeat_lease(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation + 1,
    )
    assert not mark_running(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=uuid.uuid4(),
        lease_generation=claim.lease_generation,
    )
    with pytest.raises(LeaseMismatch):
        save_checkpoint(
            session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
            lease_owner="w-1", lease_token=uuid.uuid4(),
            lease_generation=claim.lease_generation, checkpoint={"s": 1},
        )
    session.rollback()
    with pytest.raises(LeaseMismatch):
        fail_evaluation(
            session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
            lease_owner="w-1", lease_token=uuid.uuid4(),
            lease_generation=claim.lease_generation,
            error_code="transient",
        )
    session.rollback()
    row = session.get(Evaluation, claim.evaluation_id)
    row.lease_expires_at = row.lease_expires_at - timedelta(hours=1)
    session.commit()
    assert not heartbeat_lease(
        session, tenant_id="t-fence", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        now=datetime.now(timezone.utc) + timedelta(hours=2),
    )
    assert batch.id is not None


def test_lease_expiry_recovery(session: Session):
    _make_batch(
        session, "t-lease", "batch-lease", n=1, prefix="lease"
    )
    claim = claim_next_evaluation(session, tenant_id="t-lease", lease_owner="w-1")
    session.commit()
    assert claim is not None
    row = session.get(Evaluation, claim.evaluation_id)
    assert row is not None
    row.lease_expires_at = row.lease_expires_at - timedelta(hours=1)
    session.commit()
    future = datetime.now(timezone.utc) + timedelta(hours=2)
    recovered = recover_stale_leases(session, tenant_id="t-lease", now=future)
    session.commit()
    assert recovered >= 1
    reclaim = claim_next_evaluation(
        session, tenant_id="t-lease", lease_owner="w-2",
        now=future + timedelta(hours=1, minutes=1),
    )
    session.commit()
    assert reclaim is not None
    assert reclaim.evaluation_id == claim.evaluation_id
    assert reclaim.lease_generation > claim.lease_generation


def test_result_commit_identity_versioning_and_statuses(
    session: Session,
):
    batch = _make_batch(
        session, "t-result", "batch-result", n=1, prefix="res"
    )
    claim = claim_next_evaluation(session, tenant_id="t-result", lease_owner="w-1")
    session.commit()
    assert claim is not None
    first, created = commit_result(
        session, tenant_id="t-result", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED",
        result_payload=_bound_payload(
            session, "t-result", batch.snapshot_id, {"value": "100000"}
        ),
    )
    session.commit()
    assert created and first.version == 1
    fresh = claim_next_evaluation(session, tenant_id="t-result", lease_owner="w-9")
    session.commit()
    assert fresh is None
    progress = get_batch_progress(session, tenant_id="t-result", batch_id=batch.id)
    assert progress["succeeded"] == 1
    row = get_evaluation(
        session, tenant_id="t-result", evaluation_id=claim.evaluation_id
    )
    assert row.result_status == "VALUED"


def test_result_reevaluation_new_version_and_status_change(
    session: Session,
):
    batch = _make_batch(
        session, "t-reval", "batch-reval", n=1, prefix="rv"
    )
    claim = claim_next_evaluation(session, tenant_id="t-reval", lease_owner="w-1")
    session.commit()
    first, _ = commit_result(
        session, tenant_id="t-reval", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED",
        result_payload=_bound_payload(
            session, "t-reval", batch.snapshot_id, {"value": "100000"}
        ),
    )
    session.commit()
    assert first.version == 1
    claim2 = claim_next_evaluation(session, tenant_id="t-reval", lease_owner="w-1")
    session.commit()
    assert claim2 is None
    row = session.get(Evaluation, claim.evaluation_id)
    row.status = "queued"
    row.next_attempt_at = datetime.now(timezone.utc)
    session.commit()
    claim3 = claim_next_evaluation(session, tenant_id="t-reval", lease_owner="w-2")
    session.commit()
    assert claim3 is not None
    second, created = commit_result(
        session, tenant_id="t-reval", evaluation_id=claim3.evaluation_id,
        lease_owner="w-2", lease_token=claim3.lease_token,
        lease_generation=claim3.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="REVIEW_REQUIRED",
        result_payload=_bound_payload(
            session, "t-reval", batch.snapshot_id, {"value": "100000"}
        ),
    )
    session.commit()
    assert created and second.version == 2
    assert batch.id is not None


def test_result_race_identical_and_different(maker):
    sess = maker()
    batch = _make_batch(
        sess, "t-rrace", f"rr-{uuid.uuid4().hex[:8]}", n=1,
        prefix="rrz",
    )
    eval_id = sess.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-rrace", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    triplet = (batch.snapshot_id, batch.id)
    snap_hash = str(sess.execute(
        select(SettingsSnapshot.content_hash).where(
            SettingsSnapshot.id == batch.snapshot_id
        )
    ).scalar_one())
    sess.close()

    def claim_for(owner: str):
        sess = maker()
        claim = claim_next_evaluation(sess, tenant_id="t-rrace", lease_owner=owner)
        sess.commit()
        sess.close()
        return claim

    first_claim = claim_for("w-first")
    assert first_claim is not None
    snap_id = batch.snapshot_id
    barrier = threading.Barrier(4)
    results: list = []

    def commit_same():
        sess = maker()
        try:
            barrier.wait(timeout=10)
            record, created = commit_result(
                sess, tenant_id="t-rrace", evaluation_id=eval_id,
                lease_owner="w-first", lease_token=first_claim.lease_token,
                lease_generation=first_claim.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=snap_id,
                status="VALUED", result_payload={
                    "value": "7",
                    "settings_snapshot_id": str(snap_id),
                    "settings_content_hash": snap_hash,
                },
            )
            sess.commit()
            results.append((str(record.id), record.version, created))
        except (LeaseMismatch, TerminalReplay) as exc:
            sess.rollback()
            results.append(("fenced", type(exc).__name__, str(exc)[:100]))
        except Exception as exc:
            sess.rollback()
            results.append(("err", type(exc).__name__, str(exc)[:100]))
        finally:
            sess.close()

    threads = [threading.Thread(target=commit_same) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    winners = [entry for entry in results if entry[0] not in ("err", "fenced")]
    fenced = [entry for entry in results if entry[0] == "fenced"]
    assert not [entry for entry in results if entry[0] == "err"]
    assert not fenced
    assert len(winners) == 4
    assert {entry[0] for entry in winners} == {winners[0][0]}
    assert all(entry[1] == 1 for entry in winners)
    assert sum(1 for entry in winners if entry[2] is True) == 1
    assert sum(1 for entry in winners if entry[2] is False) == 3
    # Exact replay of the committed terminal identity is idempotent and
    # changes neither state nor timestamps.
    sess = maker()
    before = sess.execute(
        select(Evaluation).where(Evaluation.id == eval_id)
    ).scalar_one()
    before_updated = before.updated_at
    sess.close()
    sess = maker()
    record, created = commit_result(
        sess, tenant_id="t-rrace", evaluation_id=eval_id,
        lease_owner="stale-owner",
        lease_token=uuid.uuid4(),
        lease_generation=0,
        methodology_version="evaluation-v4", snapshot_id=snap_id,
        status="VALUED", result_payload={
            "value": "7",
            "settings_snapshot_id": str(snap_id),
            "settings_content_hash": snap_hash,
        },
    )
    sess.commit()
    assert created is False and record.version == 1
    after = sess.execute(
        select(Evaluation).where(Evaluation.id == eval_id)
    ).scalar_one()
    assert after.updated_at == before_updated and after.status == "succeeded"
    sess.close()
    # A different identity on the terminal row is fenced, even with a
    # fabricated lease.
    sess = maker()
    with sess.no_autoflush:
        try:
            commit_result(
                sess, tenant_id="t-rrace", evaluation_id=eval_id,
                lease_owner="stale-owner",
                lease_token=uuid.uuid4(),
                lease_generation=0,
                methodology_version="evaluation-v4", snapshot_id=snap_id,
                status="REVIEW_REQUIRED", result_payload={
                    "value": "7",
                    "settings_snapshot_id": str(snap_id),
                    "settings_content_hash": snap_hash,
                },
            )
        except TerminalReplay as exc:
            assert exc.existing_version == 1
        else:
            raise AssertionError("different terminal identity must be fenced")
        finally:
            sess.rollback()
    sess.close()

    sess = maker()
    row = sess.get(Evaluation, eval_id)
    row.status = "queued"
    row.next_attempt_at = datetime.now(timezone.utc)
    sess.commit()
    sess.close()
    second_claim = claim_for("w-second")
    assert second_claim is not None
    sess = maker()
    record, created = commit_result(
        sess, tenant_id="t-rrace", evaluation_id=eval_id,
        lease_owner="w-second", lease_token=second_claim.lease_token,
        lease_generation=second_claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=snap_id,
        status="INSUFFICIENT_COMPS", result_payload={
            "value": "7",
            "settings_snapshot_id": str(snap_id),
            "settings_content_hash": snap_hash,
        },
    )
    sess.commit()
    sess.close()
    assert created and record.version == 2


def test_per_property_failure_and_batch_counts(session: Session):
    batch = _make_batch(
        session, "t-counts", "batch-counts", n=3, prefix="cnt"
    )
    claims = []
    for _ in range(3):
        claim = claim_next_evaluation(
            session, tenant_id="t-counts", lease_owner="w-1"
        )
        session.commit()
        assert claim is not None
        claims.append(claim)
    commit_result(
        session, tenant_id="t-counts", evaluation_id=claims[0].evaluation_id,
        lease_owner="w-1", lease_token=claims[0].lease_token,
        lease_generation=claims[0].lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED",
        result_payload=_bound_payload(
            session, "t-counts", batch.snapshot_id, {"value": "1"}
        ),
    )
    commit_result(
        session, tenant_id="t-counts", evaluation_id=claims[1].evaluation_id,
        lease_owner="w-1", lease_token=claims[1].lease_token,
        lease_generation=claims[1].lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="INSUFFICIENT_COMPS",
        result_payload=_bound_payload(
            session, "t-counts", batch.snapshot_id,
            {"error": "thin-market"},
        ),
    )
    session.commit()
    progress = get_batch_progress(session, tenant_id="t-counts", batch_id=batch.id)
    assert progress["total"] == 3
    assert progress["succeeded"] == 2
    assert progress["failed"] == 0
    assert progress["status"] == "running"


def test_non_retriable_terminal_failure(session: Session):
    _make_batch(
        session, "t-nr", "batch-nr", n=1, prefix="nr"
    )
    claim = claim_next_evaluation(session, tenant_id="t-nr", lease_owner="w-1")
    session.commit()
    assert claim is not None
    status = fail_evaluation(
        session, tenant_id="t-nr", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        error_code="invalid_evidence", error_detail="no verified price",
        result_status="INCOMPLETE",
    )
    session.commit()
    assert status == "dead"
    row = session.get(Evaluation, claim.evaluation_id)
    assert row is not None and row.status == "dead" and row.retriable is False
    assert row.result_status == "INCOMPLETE"


def test_bounded_retry_scheduling_and_dead(session: Session):
    sess_batch, _ = create_batch_with_evaluations(
        session, tenant_id="t-retry",
                requested_by_user_id="u-legacy", idempotency_key="batch-retry",
        request_payload={"run": "retry"},
        items=[{"idempotency_key": "r-0", "payload": {"a": 1}, "max_attempts": 1}],
        snapshot_id=_tenant_snapshot(session, "t-retry").id,
    )
    assert sess_batch.id is not None
    claim = claim_next_evaluation(session, tenant_id="t-retry", lease_owner="w-1")
    session.commit()
    assert claim is not None
    status = fail_evaluation(
        session, tenant_id="t-retry", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        error_code="transient", error_detail="boom",
    )
    session.commit()
    assert status == "failed"
    row = session.get(Evaluation, claim.evaluation_id)
    assert row is not None and row.status == "failed"


def test_counter_serialization_under_threads(maker):
    sess = maker()
    batch, _ = create_batch_with_evaluations(
        sess, tenant_id="t-ser",
                requested_by_user_id="u-legacy", idempotency_key=f"ser-{uuid.uuid4().hex[:8]}",
        request_payload={"run": "ser"}, items=_items(4, prefix="sz"),
        snapshot_id=_tenant_snapshot(sess, "t-ser").id,
    )
    batch_id = batch.id
    snap_hash = str(sess.execute(
        select(SettingsSnapshot.content_hash).where(
            SettingsSnapshot.id == batch.snapshot_id
        )
    ).scalar_one())
    sess.commit()
    sess.close()
    claims = []
    sess = maker()
    for _ in range(4):
        claim = claim_next_evaluation(sess, tenant_id="t-ser", lease_owner="w-1")
        sess.commit()
        claims.append(claim)
    sess.close()

    def finish(claim, status):
        sess = maker()
        try:
            commit_result(
                sess, tenant_id="t-ser", evaluation_id=claim.evaluation_id,
                lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
                status=status, result_payload={
                    "v": status,
                    "settings_snapshot_id": str(batch.snapshot_id),
                    "settings_content_hash": snap_hash,
                },
            )
            sess.commit()
        finally:
            sess.close()

    threads = [
        threading.Thread(target=finish, args=(claims[0], "VALUED")),
        threading.Thread(target=finish, args=(claims[1], "REVIEW_REQUIRED")),
        threading.Thread(target=finish, args=(claims[2], "INSUFFICIENT_INVESTOR_DATA")),
        threading.Thread(target=finish, args=(claims[3], "VALUED")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    sess = maker()
    progress = get_batch_progress(sess, tenant_id="t-ser", batch_id=batch_id)
    sess.close()
    assert progress["total"] == 4
    assert progress["succeeded"] == 4
    assert progress["status"] == "succeeded"


def test_retry_delay_is_bounded():
    assert repo._retry_delay(1) == timedelta(seconds=30)
    assert repo._retry_delay(100) <= timedelta(hours=1)


def test_postgresql_only_guard():
    with pytest.raises(NonPostgreSQLError):
        require_postgresql_url("sqlite:///:memory:")
    with pytest.raises(NonPostgreSQLError):
        require_postgresql_url("postgresql+psycopg2://u:p@127.0.0.1/db")


def test_lease_reassignment_pauses_stale_commit(maker):
    sess = maker()
    batch = _make_batch(
        sess, "t-pause", f"pz-{uuid.uuid4().hex[:8]}", n=1, prefix="pz",
    )
    eval_id = sess.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-pause", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    snap_id = batch.snapshot_id
    snap_hash = str(sess.execute(
        select(SettingsSnapshot.content_hash).where(
            SettingsSnapshot.id == snap_id
        )
    ).scalar_one())
    sess.close()

    sess = maker()
    stale = claim_next_evaluation(sess, tenant_id="t-pause", lease_owner="w-old")
    sess.commit()
    sess.close()
    assert stale is not None

    ready = threading.Event()
    go = threading.Event()
    outcome: list = []

    def stale_commit():
        sess = maker()
        try:
            sess.execute(
                select(Evaluation.id).where(Evaluation.id == eval_id).with_for_update()
            ).scalar_one()
            ready.set()
            if not go.wait(timeout=10):
                outcome.append("raw:gate-timeout")
                return
            commit_result(
                sess, tenant_id="t-pause", evaluation_id=eval_id,
                lease_owner="w-old", lease_token=stale.lease_token,
                lease_generation=stale.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=snap_id,
                status="VALUED", result_payload={
                    "value": "1",
                    "settings_snapshot_id": str(snap_id),
                    "settings_content_hash": snap_hash,
                },
            )
            sess.commit()
            outcome.append("committed")
        except LeaseMismatch:
            sess.rollback()
            outcome.append("fenced")
        except Exception as exc:
            sess.rollback()
            outcome.append(f"raw:{type(exc).__name__}")
        finally:
            sess.close()

    thread = threading.Thread(target=stale_commit, daemon=True)
    thread.start()
    assert ready.wait(timeout=10)
    go.set()
    thread.join(timeout=20)
    sess = maker()
    row = sess.get(Evaluation, eval_id)
    row.status = "queued"
    row.lease_owner = "w-new"
    row.lease_token = uuid.uuid4()
    row.lease_generation = int(row.lease_generation) + 1
    row.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    row.next_attempt_at = datetime.now(timezone.utc)
    sess.commit()
    fresh = sess.execute(
        select(Evaluation).where(Evaluation.id == eval_id)
    ).scalar_one()
    fresh_gen = int(fresh.lease_generation)
    sess.close()
    sess = maker()
    try:
        commit_result(
            sess, tenant_id="t-pause", evaluation_id=eval_id,
            lease_owner="w-old", lease_token=stale.lease_token,
            lease_generation=stale.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=snap_id,
            status="VALUED", result_payload={
                "value": "1",
                "settings_snapshot_id": str(snap_id),
                "settings_content_hash": snap_hash,
            },
        )
        sess.commit()
        outcome.append("committed-after-reassign")
    except LeaseMismatch:
        sess.rollback()
        outcome.append("fenced-after-reassign")
    except Exception as exc:
        sess.rollback()
        outcome.append(f"raw:{type(exc).__name__}")
    finally:
        sess.close()
    assert outcome[0] == "committed"
    assert outcome[1] == "fenced-after-reassign"
    assert fresh_gen == stale.lease_generation + 1


def test_simultaneous_different_result_single_terminal(maker):
    sess = maker()
    batch = _make_batch(
        sess, "t-sdr", f"sdr-{uuid.uuid4().hex[:8]}", n=1, prefix="sd",
    )
    eval_id = sess.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-sdr", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    snap_id = batch.snapshot_id
    snap_hash = str(sess.execute(
        select(SettingsSnapshot.content_hash).where(
            SettingsSnapshot.id == snap_id
        )
    ).scalar_one())
    sess.close()
    sess = maker()
    claim = claim_next_evaluation(sess, tenant_id="t-sdr", lease_owner="w-1")
    sess.commit()
    sess.close()
    assert claim is not None
    barrier = threading.Barrier(2)
    outcomes: list = []

    def commit_as(status: str):
        sess = maker()
        try:
            barrier.wait(timeout=10)
            record, created = commit_result(
                sess, tenant_id="t-sdr", evaluation_id=eval_id,
                lease_owner="w-1", lease_token=claim.lease_token,
                lease_generation=claim.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=snap_id,
                status=status, result_payload={
                    "value": status,
                    "settings_snapshot_id": str(snap_id),
                    "settings_content_hash": snap_hash,
                },
            )
            sess.commit()
            outcomes.append((status, record.version, created))
        except (LeaseMismatch, TerminalReplay):
            sess.rollback()
            outcomes.append((status, "fenced", False))
        except Exception as exc:
            sess.rollback()
            outcomes.append((status, f"raw:{type(exc).__name__}", False))
        finally:
            sess.close()

    threads = [
        threading.Thread(target=commit_as, args=("VALUED",)),
        threading.Thread(target=commit_as, args=("REVIEW_REQUIRED",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(outcomes) == 2
    assert not [entry for entry in outcomes if str(entry[1]).startswith("raw")]
    created = [entry for entry in outcomes if entry[2] is True]
    assert len(created) == 1
    sess = maker()
    row = sess.get(Evaluation, eval_id)
    assert row is not None and row.status == "succeeded"
    assert row.lease_owner is None and row.lease_token is None
    versions = sess.execute(
        select(EvaluationResult.version).where(
            EvaluationResult.evaluation_id == eval_id
        ).order_by(EvaluationResult.version)
    ).scalars().all()
    sess.close()
    assert versions == [1]


def test_batch_status_counts_check_rejects_mismatch(session: Session):
    batch = _make_batch(session, "t-ck", "ck-1", n=2, prefix="ck")
    with pytest.raises(Exception):
        session.execute(
            text("UPDATE v4_batches SET status = 'succeeded' "
                 "WHERE id = :id AND tenant_id = :t"),
            {"id": batch.id, "t": "t-ck"},
        )
    session.rollback()
    with pytest.raises(Exception):
        session.execute(
            text("UPDATE v4_batches SET succeeded_count = 99 "
                 "WHERE id = :id AND tenant_id = :t"),
            {"id": batch.id, "t": "t-ck"},
        )
    session.rollback()


def test_running_requires_active_lease_direct_sql(session: Session):
    batch = _make_batch(session, "t-run", "run-1", n=1, prefix="rn")
    eval_id = session.execute(
        select(Evaluation.id).where(
            Evaluation.tenant_id == "t-run", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    with pytest.raises(Exception):
        session.execute(
            text("UPDATE v4_evaluations SET status = 'running' "
                 "WHERE id = :id AND tenant_id = :t"),
            {"id": eval_id, "t": "t-run"},
        )
    session.rollback()


def test_commit_result_rejects_wrong_snapshot_same_tenant(session: Session):
    batch = _make_batch(
        session, "t-wsnap", f"wsnap-{uuid.uuid4().hex[:8]}", n=1,
        prefix="ws",
    )
    other = store_settings_snapshot(
        session, tenant_id="t-wsnap", snapshot_version="v1",
        content={"rate": "99"}, source={"rate": "override"},
    )
    session.commit()
    assert other.id != batch.snapshot_id
    claim = claim_next_evaluation(session, tenant_id="t-wsnap", lease_owner="w-1")
    session.commit()
    assert claim is not None
    with pytest.raises(IdempotencyConflict):
        commit_result(
            session, tenant_id="t-wsnap", evaluation_id=claim.evaluation_id,
            lease_owner="w-1", lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=other.id,
            status="VALUED",
            result_payload=_bound_payload(
                session, "t-wsnap", batch.snapshot_id, {"value": "1"}
            ),
        )
    session.rollback()
    row = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    assert row.status in {"claimed", "running", "queued"}
    assert session.execute(
        select(func.count()).select_from(EvaluationResult).where(
            EvaluationResult.evaluation_id == claim.evaluation_id
        )
    ).scalar() == 0


def test_commit_result_rejects_payload_snapshot_mismatch(session: Session):
    batch = _make_batch(
        session, "t-wpay", f"wpay-{uuid.uuid4().hex[:8]}", n=1,
        prefix="wp",
    )
    durable = session.execute(
        select(Evaluation).where(
            Evaluation.tenant_id == "t-wpay", Evaluation.batch_id == batch.id
        )
    ).scalar_one()
    assert durable.id is not None
    claim = claim_next_evaluation(session, tenant_id="t-wpay", lease_owner="w-1")
    session.commit()
    assert claim is not None
    bound = _bound_payload(session, "t-wpay", batch.snapshot_id, {"value": "1"})
    with pytest.raises(IdempotencyConflict):
        commit_result(
            session, tenant_id="t-wpay", evaluation_id=claim.evaluation_id,
            lease_owner="w-1", lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
            status="VALUED", result_payload={
                "value": "1",
                "settings_snapshot_id": str(uuid.uuid4()),
                "settings_content_hash": bound["settings_content_hash"],
            },
        )
    session.rollback()
    with pytest.raises(IdempotencyConflict):
        commit_result(
            session, tenant_id="t-wpay", evaluation_id=claim.evaluation_id,
            lease_owner="w-1", lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
            status="VALUED", result_payload={
                "value": "1",
                "settings_snapshot_id": str(batch.snapshot_id),
                "settings_content_hash": "bogus-hash",
            },
        )
    session.rollback()


def test_commit_result_rejects_missing_snapshot_binding(session: Session):
    batch = _make_batch(
        session, "t-nbind", f"nbind-{uuid.uuid4().hex[:8]}", n=1,
        prefix="nb",
    )
    claim = claim_next_evaluation(session, tenant_id="t-nbind", lease_owner="w-1")
    session.commit()
    assert claim is not None
    bound = _bound_payload(session, "t-nbind", batch.snapshot_id, {"value": "1"})
    cases = [
        {"value": "1"},
        {k: v for k, v in bound.items() if k != "settings_snapshot_id"},
        {k: v for k, v in bound.items() if k != "settings_content_hash"},
        {**bound, "settings_snapshot_id": ""},
        {**bound, "settings_content_hash": ""},
    ]
    for payload in cases:
        with pytest.raises(IdempotencyConflict):
            commit_result(
                session, tenant_id="t-nbind", evaluation_id=claim.evaluation_id,
                lease_owner="w-1", lease_token=claim.lease_token,
                lease_generation=claim.lease_generation,
                methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
                status="VALUED", result_payload=dict(payload),
            )
        session.rollback()
    assert session.execute(
        select(func.count()).select_from(EvaluationResult).where(
            EvaluationResult.evaluation_id == claim.evaluation_id
        )
    ).scalar() == 0
    row = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    assert row.status in {"claimed", "running", "queued"}
    record, created = commit_result(
        session, tenant_id="t-nbind", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED", result_payload=dict(bound),
    )
    session.commit()
    assert created and record.version == 1


def test_batch_replay_requested_count_must_equal_persisted(session: Session):
    snap = _tenant_snapshot(session, "t-rcount")
    first, created = create_batch_with_evaluations(
        session, tenant_id="t-rcount",
                requested_by_user_id="u-legacy", idempotency_key="batch-rcount",
        request_payload={"run": "a"}, items=_items(2, prefix="rc"),
        snapshot_id=snap.id,
    )
    session.commit()
    assert created is True
    with pytest.raises(IdempotencyConflict):
        create_batch_with_evaluations(
            session, tenant_id="t-rcount",
                requested_by_user_id="u-legacy", idempotency_key="batch-rcount",
            request_payload={"run": "a"}, items=_items(1, prefix="rc"),
            snapshot_id=snap.id,
        )
    session.rollback()
    replayed, created = create_batch_with_evaluations(
        session, tenant_id="t-rcount",
                requested_by_user_id="u-legacy", idempotency_key="batch-rcount",
        request_payload={"run": "a"}, items=_items(2, prefix="rc"),
        snapshot_id=snap.id,
    )
    session.commit()
    assert replayed.id == first.id and created is False


def test_terminal_replay_exact_idempotent_and_different_fenced(session: Session):
    batch = _make_batch(
        session, "t-replay", f"replay-{uuid.uuid4().hex[:8]}", n=1,
        prefix="rp",
    )
    claim = claim_next_evaluation(session, tenant_id="t-replay", lease_owner="w-1")
    session.commit()
    assert claim is not None
    first, created = commit_result(
        session, tenant_id="t-replay", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED",
        result_payload=_bound_payload(
            session, "t-replay", batch.snapshot_id, {"value": "42"}
        ),
    )
    session.commit()
    assert created and first.version == 1
    before = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    before_updated = before.updated_at
    # Exact terminal replay with a fabricated lease stays idempotent and
    # touches neither status nor timestamps.
    same, created = commit_result(
        session, tenant_id="t-replay", evaluation_id=claim.evaluation_id,
        lease_owner="anyone", lease_token=uuid.uuid4(),
        lease_generation=0,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED",
        result_payload=_bound_payload(
            session, "t-replay", batch.snapshot_id, {"value": "42"}
        ),
    )
    session.commit()
    assert created is False and same.id == first.id and same.version == 1
    after = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    assert after.status == "succeeded" and after.updated_at == before_updated
    # A different identity on the terminal row is fenced.
    with pytest.raises(TerminalReplay) as excinfo:
        commit_result(
            session, tenant_id="t-replay", evaluation_id=claim.evaluation_id,
            lease_owner="anyone", lease_token=uuid.uuid4(),
            lease_generation=0,
            methodology_version="evaluation-v4",
            snapshot_id=batch.snapshot_id,
            status="REVIEW_REQUIRED",
            result_payload=_bound_payload(
                session, "t-replay", batch.snapshot_id, {"value": "42"}
            ),
        )
    session.rollback()
    assert excinfo.value.existing_version == 1
    assert batch.id is not None


def test_active_fresh_lease_historical_reuse_completes(session: Session):
    batch = _make_batch(
        session, "t-hist", f"hist-{uuid.uuid4().hex[:8]}", n=1,
        prefix="hi",
    )
    claim = claim_next_evaluation(session, tenant_id="t-hist", lease_owner="w-1")
    session.commit()
    assert claim is not None
    snap_hash = str(session.execute(
        select(SettingsSnapshot.content_hash).where(
            SettingsSnapshot.id == batch.snapshot_id
        )
    ).scalar_one())
    payload = {
        "value": "7",
        "settings_snapshot_id": str(batch.snapshot_id),
        "settings_content_hash": snap_hash,
    }
    first, created = commit_result(
        session, tenant_id="t-hist", evaluation_id=claim.evaluation_id,
        lease_owner="w-1", lease_token=claim.lease_token,
        lease_generation=claim.lease_generation,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED", result_payload=dict(payload),
    )
    session.commit()
    assert created and first.version == 1
    # Requeue a new execution around the committed row (fresh lease) and
    # reuse the historical identity: completes the current execution
    # atomically without allocating a new version.
    row = session.get(Evaluation, claim.evaluation_id)
    row.status = "running"
    row.lease_owner = "w-2"
    row.lease_token = uuid.uuid4()
    row.lease_generation = int(row.lease_generation) + 1
    row.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    row.next_attempt_at = datetime.now(timezone.utc)
    session.commit()
    fresh = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    fresh_owner, fresh_token, fresh_gen = (
        fresh.lease_owner, fresh.lease_token, int(fresh.lease_generation),
    )
    same, created = commit_result(
        session, tenant_id="t-hist", evaluation_id=claim.evaluation_id,
        lease_owner=fresh_owner, lease_token=fresh_token,
        lease_generation=fresh_gen,
        methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
        status="VALUED", result_payload=dict(payload),
    )
    session.commit()
    assert created is False and same.id == first.id and same.version == 1
    done = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    assert done.status == "succeeded" and done.lease_owner is None
    versions = session.execute(
        select(EvaluationResult.version).where(
            EvaluationResult.evaluation_id == claim.evaluation_id
        ).order_by(EvaluationResult.version)
    ).scalars().all()
    assert versions == [1]


def test_locked_row_refresh_sees_reassigned_lease(session: Session, maker):
    batch = _make_batch(
        session, "t-pop", f"pop-{uuid.uuid4().hex[:8]}", n=1,
        prefix="pp",
    )
    claim = claim_next_evaluation(session, tenant_id="t-pop", lease_owner="w-1")
    session.commit()
    assert claim is not None
    eval_id = claim.evaluation_id
    # Load a stale identity-map copy in this session first: without
    # populate_existing the locked read would validate this stale copy.
    stale = session.execute(
        select(Evaluation).where(Evaluation.id == eval_id)
    ).scalar_one()
    assert stale.lease_token == claim.lease_token
    # Reassign the lease out of band in a second session.
    other = maker()
    row = other.execute(
        select(Evaluation).where(Evaluation.id == eval_id)
    ).scalar_one()
    row.lease_owner = "w-2"
    row.lease_token = uuid.uuid4()
    row.lease_generation = int(row.lease_generation) + 1
    row.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    other.commit()
    other.close()
    # The stale-session commit must be fenced by the refreshed locked read.
    with pytest.raises(LeaseMismatch):
        commit_result(
            session, tenant_id="t-pop", evaluation_id=eval_id,
            lease_owner="w-1", lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            methodology_version="evaluation-v4", snapshot_id=batch.snapshot_id,
            status="VALUED",
            result_payload=_bound_payload(
                session, "t-pop", batch.snapshot_id, {"value": "1"}
            ),
        )
    session.rollback()


def test_canonical_decimal_independent_of_context_and_form(session: Session):
    import decimal
    from decimal import Decimal

    from eval_engine.persistence.db import canonical_hash, canonical_json

    assert canonical_json(Decimal("12.50")) == "12.5"
    assert canonical_json(Decimal("1.25E+1")) == "12.5"
    assert canonical_json({"rate": Decimal("12.50")}) == {"rate": "12.5"}
    assert canonical_hash({"rate": Decimal("12.50")}) == canonical_hash(
        {"rate": Decimal("12.5")}
    )
    # A constrained localcontext (precision=2) must not change identity.
    with decimal.localcontext() as ctx:
        ctx.prec = 2
        assert canonical_json(Decimal("12.50")) == "12.5"
        assert canonical_hash({"rate": Decimal("12.50")}) == canonical_hash(
            {"rate": Decimal("1.25E+1")}
        )
    committed = store_settings_snapshot(
        session, tenant_id="t-dec", snapshot_version="v1",
        content={"rate": Decimal("12.50")}, source={"a": 1},
    )
    session.commit()
    again = store_settings_snapshot(
        session, tenant_id="t-dec", snapshot_version="v1",
        content={"rate": Decimal("1.25E+1")}, source={"a": 1},
    )
    session.commit()
    assert again.id == committed.id
    assert committed.content == {"rate": "12.5"}
    with pytest.raises(TypeError):
        canonical_json(Decimal("NaN"))


def test_snapshot_race_preserves_outer_transaction(session: Session):
    import uuid as _uuid

    snap = store_settings_snapshot(
        session, tenant_id="t-save", snapshot_version="v1",
        content={"k": "v"}, source={"s": 1},
    )
    session.commit()
    batch = _make_batch(
        session, "t-save", f"save-{_uuid.uuid4().hex[:8]}", n=1,
        prefix="sv", snapshot=snap,
    )
    claim = claim_next_evaluation(session, tenant_id="t-save", lease_owner="w-1")
    session.commit()
    assert claim is not None
    # Start outer transactional work, then hit the snapshot identity race;
    # the savepoint-scoped flush must preserve the outer work.
    row = session.execute(
        select(Evaluation).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one()
    marker = {"checkpoint": "outer-work"}
    row.checkpoint = dict(marker)
    raced = store_settings_snapshot(
        session, tenant_id="t-save", snapshot_version="v1",
        content={"k": "v"}, source={"s": 1},
    )
    assert raced.id == snap.id
    session.flush()
    assert session.execute(
        select(Evaluation.checkpoint).where(Evaluation.id == claim.evaluation_id)
    ).scalar_one() == marker
    session.rollback()
    assert batch.id is not None
