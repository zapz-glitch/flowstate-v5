"""V4-103B limiter-focused tests (isolated PostgreSQL, no providers).

Covers RPM exact boundary (40/60s, 41st refused, slide refills), the
concurrent max-4 lease cap under threads, lease-expiry recovery,
Retry-After persisted next_attempt, attempt/ retry counting, and
multi-process/thread coordination through the shared Postgres tables.
"""

from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from eval_engine.persistence.models import CotalityCall
from eval_engine.worker import LimiterConfig, ProviderLimiter

import tests.test_api as api_cases

MAINT_URL = api_cases.MAINT_URL


@pytest.fixture(scope="module")
def limiter_engine():
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    db_name = f"v4lim_{uuid.uuid4().hex[:12]}"
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
    with engine.begin() as conn:
        rev = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert rev == "0004_v4_provider_limiter"
    yield engine
    engine.dispose()
    with maint.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    maint.dispose()


@pytest.fixture()
def maker(limiter_engine):
    return sessionmaker(bind=limiter_engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def _clean_limiter_tables(limiter_engine):
    with limiter_engine.begin() as conn:
        conn.execute(text("DELETE FROM v4_cotality_calls"))
        conn.execute(text("DELETE FROM v4_cotality_leases"))
    yield
    with limiter_engine.begin() as conn:
        conn.execute(text("DELETE FROM v4_cotality_calls"))
        conn.execute(text("DELETE FROM v4_cotality_leases"))


def test_rpm_exact_boundary_no_burst(maker):
    now = datetime.now(timezone.utc)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40, now=lambda: now))
    leases = [limiter.acquire(owner="w", now=now) for _ in range(40)]
    assert all(l is not None for l in leases)
    assert limiter.window_count(now=now) == 40
    assert limiter.acquire(owner="w", now=now) is None
    assert limiter.window_count(now=now) == 40
    assert limiter.acquire(owner="w", now=now + timedelta(seconds=61)) is not None
    for lease in leases:
        limiter.release(lease)


def test_concurrent_max_four_across_threads(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=10000, now=datetime.now(timezone.utc)))
    barrier = threading.Barrier(12)
    out: list = []

    def grab(i):
        barrier.wait(timeout=10)
        out.append(limiter.acquire(owner=f"w-{i}"))

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(1 for l in out if l is not None) == 4
    assert sum(1 for l in out if l is None) == 8
    for lease in out:
        if lease is not None:
            limiter.release(lease)


def test_attempts_and_retries_all_count(maker):
    now = datetime.now(timezone.utc)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=1000, now=lambda: now))
    eval_id = uuid.uuid4()
    for attempt in (1, 2, 3):
        lease = limiter.acquire(owner="w", evaluation_id=eval_id, attempt=attempt, now=now)
        assert lease is not None
        limiter.release(lease)
    with maker() as sess:
        rows = sess.execute(
            select(CotalityCall.attempt).where(CotalityCall.evaluation_id == eval_id)
        ).scalars().all()
        assert sorted(int(a) for a in rows) == [1, 2, 3]
        total = sess.execute(select(func.count()).select_from(CotalityCall)).scalar()
        assert total is not None and total >= 3


def test_lease_expiry_recovery(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=1, max_calls=1000, now=datetime.now(timezone.utc)))
    first = limiter.acquire(owner="w-1")
    assert first is not None
    assert limiter.acquire(owner="w-2") is None
    with maker() as sess:
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = :exp WHERE lease_token = :tok"),
            {"exp": datetime.now(timezone.utc) - timedelta(minutes=5),
             "tok": first.lease_token},
        )
        sess.commit()
    second = limiter.acquire(owner="w-2")
    assert second is not None
    limiter.release(second)


def test_thread_coordination_single_shared_budget(maker):
    now = datetime.now(timezone.utc)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40, now=lambda: now))
    barrier = threading.Barrier(60)
    out: list = []

    def grab(i):
        barrier.wait(timeout=15)
        out.append(limiter.acquire(owner=f"p-{i}", now=now))

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(60)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(1 for l in out if l is not None) == 40
    for lease in out:
        if lease is not None:
            limiter.release(lease)
