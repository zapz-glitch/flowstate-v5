"""V4-103B limiter-focused tests (isolated PostgreSQL, no providers).

Contract under test: one permit == exactly one outbound provider HTTP
request. Every successful acquire persists exactly one request-window
row, including retries, so a subject fetch plus a comps fetch is TWO
acquires / TWO rows. Covers:

- subject+comps style two-permit acquisition counts as two requests
- RPM exact boundary (40 accepted, 41st refused) across processes
- long-lived renewed permits block a fifth past the original TTL
- DB transaction clock resists skewed process clocks
- forged renew/release fails (token + owner fenced)
- expiry recovers an unrenewed slot; renewal consumes no window budget
- true multiprocessing coordination (spawned processes, not threads)

All timing uses short TTLs/test windows against real database time;
explicit ``now`` is exercised only as a forward test-time advance and
never moves a decision backwards past the database clock.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from eval_engine.persistence.models import CotalityCall
from eval_engine.worker import LimiterConfig, ProviderLimiter
from eval_engine.worker.limiter import ProviderLease

import tests.test_api as api_cases

import pytest

MAINT_URL = api_cases.MAINT_URL


@pytest.fixture(scope="module")
def limiter_engine(isolated_pg):
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


def _child_acquire(url: str, queue, owner: str, max_calls: int):
    """Top-level (picklable) child: one acquire attempt, report outcome."""
    try:
        from sqlalchemy import create_engine as _ce
        from sqlalchemy.orm import sessionmaker as _sm

        from eval_engine.worker import LimiterConfig as _Cfg
        from eval_engine.worker import ProviderLimiter as _Lim

        engine = _ce(url, pool_pre_ping=True)
        maker = _sm(bind=engine, expire_on_commit=False)
        limiter = _Lim(
            maker,
            _Cfg(max_active=4, max_calls=max_calls,
                 lease_ttl=timedelta(seconds=30)),
        )
        lease = limiter.acquire(owner=owner)
        if lease is not None:
            queue.put(("ok", str(lease.lease_token), owner))
        else:
            queue.put(("refused", None, owner))
        engine.dispose()
    except Exception as exc:  # pragma: no cover - surfaced via queue
        try:
            queue.put(("error", repr(exc), owner))
        except Exception:
            pass


def _child_burst(url: str, queue, owner: str, attempts: int):
    """Top-level child: N sequential acquires for the cross-process RPM test."""
    try:
        from sqlalchemy import create_engine as _ce
        from sqlalchemy.orm import sessionmaker as _sm

        from eval_engine.worker import LimiterConfig as _Cfg
        from eval_engine.worker import ProviderLimiter as _Lim

        engine = _ce(url, pool_pre_ping=True)
        maker = _sm(bind=engine, expire_on_commit=False)
        limiter = _Lim(
            maker,
            _Cfg(max_active=1000, max_calls=40,
                 lease_ttl=timedelta(seconds=30)),
        )
        wins = 0
        for _ in range(attempts):
            lease = limiter.acquire(owner=owner)
            if lease is not None:
                wins += 1
        queue.put(("ok", wins, owner))
        engine.dispose()
    except Exception as exc:  # pragma: no cover - surfaced via queue
        try:
            queue.put(("error", repr(exc), owner))
        except Exception:
            pass


def test_subject_plus_comps_counts_as_two_requests(maker):
    """Two permits (subject fetch + comps fetch) persist two window rows."""
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=40))
    eval_id = uuid.uuid4()
    subject = limiter.acquire(owner="w", evaluation_id=eval_id, attempt=1)
    assert subject is not None
    comps = limiter.acquire(owner="w", evaluation_id=eval_id, attempt=1)
    assert comps is not None
    assert limiter.window_count() == 2
    assert limiter.active_count() == 2
    with maker() as sess:
        rows = sess.execute(
            select(CotalityCall.evaluation_id).where(
                CotalityCall.evaluation_id == eval_id)
        ).scalars().all()
        assert len(rows) == 2
    assert limiter.release(subject) is True
    assert limiter.release(comps) is True
    assert limiter.active_count() == 0
    # Window rows stay after release: attempts already happened.
    assert limiter.window_count() == 2


def test_rpm_exact_boundary_no_burst(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40))
    leases = [limiter.acquire(owner="w") for _ in range(40)]
    assert all(lease is not None for lease in leases)
    assert limiter.window_count() == 40
    # 41st refused and consumes no budget.
    assert limiter.acquire(owner="w") is None
    assert limiter.window_count() == 40
    assert limiter.acquire(owner="w") is None
    assert limiter.window_count() == 40
    for lease in leases:
        assert lease is not None
        limiter.release(lease)
    assert limiter.active_count() == 0


def _db_url(engine) -> str:
    """Render the engine URL with the password intact for child processes.

    ``str(engine.url)`` masks the password; children need the real one.
    """
    return engine.url.render_as_string(hide_password=False)


def test_rpm_boundary_across_processes(maker, limiter_engine):
    """Exact 40 accepted then 41st refused across spawned processes."""
    url = _db_url(limiter_engine)
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    # 5 processes x 10 sequential acquires against one shared budget of 40.
    procs = [
        ctx.Process(target=_child_burst, args=(url, queue, f"proc-{i}", 10))
        for i in range(5)
    ]
    for proc in procs:
        proc.start()
    for proc in procs:
        proc.join(120)
    assert all(proc.exitcode == 0 for proc in procs)
    total = 0
    for _ in procs:
        status, wins, _owner = queue.get(timeout=30)
        assert status == "ok", wins
        total += int(wins)
    assert total == 40
    assert limiter_engine is not None
    with maker() as sess:
        count = sess.execute(
            select(func.count()).select_from(CotalityCall)).scalar()
        assert int(count or 0) == 40
    # Budget exhausted: one more acquire from this process is refused.
    extra = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40))
    assert extra.acquire(owner="late") is None


def test_concurrent_max_four_across_threads(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=10000))
    barrier = threading.Barrier(12)
    out: list = []

    def grab(i):
        barrier.wait(timeout=10)
        out.append(limiter.acquire(owner=f"w-{i}"))

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(1 for lease in out if lease is not None) == 4
    assert sum(1 for lease in out if lease is None) == 8
    for lease in out:
        if lease is not None:
            assert limiter.release(lease) is True
    assert limiter.active_count() == 0


def test_long_lived_renewed_permits_block_fifth_past_ttl(maker):
    """4 renewed permits hold 4 slots past the original TTL; 5th refused.

    Deterministic: no wall-clock sleeps. Time passage is simulated with
    DB-relative backdates (``statement_timestamp()`` arithmetic), so NTP
    steps or scheduler jitter cannot flake it. With a 60s TTL, two
    simulated 50s passages put the decision 100s after acquire -- past
    the ORIGINAL 60s TTL -- while renewals keep all four slots live.
    """
    ttl = timedelta(seconds=60)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=10000, lease_ttl=ttl))
    held = [limiter.acquire(owner=f"w-{n}") for n in range(4)]
    assert all(lease is not None for lease in held)
    assert limiter.acquire(owner="fifth") is None
    # Simulate 50s passing: backdate expiries DB-relatively, slots live.
    with maker() as sess:
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = "
                 "statement_timestamp() + interval '10 seconds'"))
        sess.commit()
    first_renew = [limiter.renew(lease) for lease in held]
    assert all(lease is not None for lease in first_renew)
    renewed_exp = [lease.expires_at for lease in first_renew
                   if lease is not None]
    with maker() as sess:
        db_now = sess.execute(
            select(func.statement_timestamp())).scalar_one()
        sess.rollback()
    # Renewal extended from renewal time, not the backdated near-expiry.
    assert all(exp > db_now + timedelta(seconds=50)
               for exp in renewed_exp)
    # Simulate 50 more seconds (100s total, past the original 60s TTL).
    with maker() as sess:
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = "
                 "statement_timestamp() + interval '10 seconds'"))
        sess.commit()
    renewed = [limiter.renew(lease) for lease in first_renew]
    assert all(lease is not None for lease in renewed), (
        "renewal must keep live slots past the ORIGINAL ttl")
    # A fifth request is still refused: renewal never frees a live slot.
    assert limiter.acquire(owner="fifth") is None
    assert limiter.active_count() == 4
    # Renewal consumed no window budget.
    assert limiter.window_count() == 4
    for lease in renewed:
        assert lease is not None
        assert limiter.release(lease) is True
    assert limiter.active_count() == 0


def test_expiry_recovers_unrenewed_slot(maker):
    """An expired, unrenewed lease is never resurrected; slot is reclaimed.

    Deterministic: expiry is set with a DB-relative backdate instead of
    a wall-clock sleep, so NTP steps or scheduler jitter cannot flake
    it (a ~1s backward clock step previously let a 1s-TTL lease read as
    live ~9ms before expiry after a 2s sleep).
    """
    ttl = timedelta(seconds=60)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=1, max_calls=1000, lease_ttl=ttl))
    first = limiter.acquire(owner="w-1")
    assert first is not None
    assert limiter.acquire(owner="w-2") is None
    # Simulate the TTL elapsing with no renewal, DB-authoritatively.
    with maker() as sess:
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = "
                 "statement_timestamp() - interval '5 seconds' "
                 "WHERE lease_token = :tok"),
            {"tok": first.lease_token},
        )
        sess.commit()
    # Unrenewed lease expired: renew reports the slot is gone (no resurrect).
    assert limiter.renew(first) is None
    second = limiter.acquire(owner="w-2")
    assert second is not None
    assert limiter.active_count() == 1
    assert limiter.release(second) is True


def test_db_clock_resists_skewed_process_clock(maker):
    """A backward-skewed explicit clock cannot shrink the window or leases.

    A process whose clock lags the database by minutes still sees the
    true window count and still gets a full-TTL lease stamped from
    database time, so two processes with disagreeing clocks agree.
    """
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=1000))
    leases = [limiter.acquire(owner="w") for _ in range(3)]
    assert all(lease is not None for lease in leases)
    skewed = datetime.now(timezone.utc) - timedelta(minutes=30)
    # Skewed read still reports the real window.
    assert limiter.window_count(now=skewed) == 3
    assert limiter.active_count(now=skewed) == 3
    # A skewed acquire gets a full database-time TTL, not a short one.
    fresh = limiter.acquire(owner="skewed", now=skewed)
    assert fresh is not None
    assert fresh.expires_at.tzinfo is not None
    with maker() as sess:
        db_now = sess.execute(select(func.now())).scalar()
        assert fresh.expires_at >= db_now + timedelta(minutes=1, seconds=30)
    for lease in leases + [fresh]:
        assert lease is not None
        limiter.release(lease)


def test_forward_test_time_still_slides_window(maker, limiter_engine):
    """Explicit forward time remains usable to advance the window in tests."""
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=2,
                             window=timedelta(seconds=5)))
    assert limiter.acquire(owner="w") is not None
    assert limiter.acquire(owner="w") is not None
    assert limiter.acquire(owner="w") is None
    with limiter_engine.begin() as conn:
        db_now = conn.execute(text("SELECT now()")).scalar()
    ahead = db_now + timedelta(seconds=30)
    assert limiter.window_count(now=ahead) == 0
    assert limiter.acquire(owner="w", now=ahead) is not None


def test_forged_renew_and_release_fail(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=1000))
    real = limiter.acquire(owner="victim")
    assert real is not None
    forged_token = ProviderLease(
        id=real.id, provider=real.provider, owner=real.owner,
        lease_token=uuid.uuid4(), expires_at=real.expires_at)
    assert limiter.renew(forged_token) is None
    assert limiter.release(forged_token) is False
    forged_owner = ProviderLease(
        id=real.id, provider=real.provider, owner="intruder",
        lease_token=real.lease_token, expires_at=real.expires_at)
    assert limiter.renew(forged_owner) is None
    assert limiter.release(forged_owner) is False
    # Victim slot untouched and still held.
    assert limiter.active_count() == 1
    assert limiter.renew(real) is not None
    assert limiter.release(real) is True
    assert limiter.release(real) is False
    assert limiter.active_count() == 0


def test_attempts_and_retries_all_count(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=1000))
    eval_id = uuid.uuid4()
    for attempt in (1, 2, 3):
        lease = limiter.acquire(
            owner="w", evaluation_id=eval_id, attempt=attempt)
        assert lease is not None
        limiter.release(lease)
    with maker() as sess:
        rows = sess.execute(
            select(CotalityCall.attempt).where(CotalityCall.evaluation_id == eval_id)
        ).scalars().all()
        assert sorted(int(attempt) for attempt in rows) == [1, 2, 3]
        total = sess.execute(select(func.count()).select_from(CotalityCall)).scalar()
        assert total is not None and total >= 3


def test_multiprocess_max_four_not_threads(maker, limiter_engine):
    """Spawned processes (separate connections) share one 4-slot budget."""
    url = _db_url(limiter_engine)
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    procs = [
        ctx.Process(target=_child_acquire,
                    args=(url, queue, f"proc-{i}", 100000))
        for i in range(8)
    ]
    for proc in procs:
        proc.start()
    for proc in procs:
        proc.join(120)
    assert all(proc.exitcode == 0 for proc in procs)
    wins = 0
    tokens = []
    for _ in procs:
        status, token, _owner = queue.get(timeout=30)
        assert status in {"ok", "refused"}, status
        if status == "ok":
            wins += 1
            tokens.append(token)
    assert wins == 4, f"expected exactly 4 cross-process winners, got {wins}"
    assert len(set(tokens)) == 4
    assert limiter_engine is not None
    assert ProviderLimiter(maker, LimiterConfig()).active_count() == 4


def test_thread_coordination_single_shared_budget(maker):
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40))
    barrier = threading.Barrier(60)
    out: list = []

    def grab(i):
        barrier.wait(timeout=15)
        out.append(limiter.acquire(owner=f"p-{i}"))

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(60)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sum(1 for lease in out if lease is not None) == 40
    for lease in out:
        if lease is not None:
            limiter.release(lease)
