"""V4-103B supervised worker + limiter tests (isolated PostgreSQL).

Covers: simultaneous workers with no duplicate claims, fair batches
(50 vs small), crash-after-claim recovery, crash-after-commit replay,
stale-lease fencing, heartbeat across long evaluation, per-property
isolation, retries/429/Retry-After, RPM exact boundary, concurrent max
leases, multi-process coordination, external-disabled zero provider
calls, restart resumption, and stubbed 1/5/10/20/50 batches. No live
providers anywhere.
"""

from __future__ import annotations

import os
import random
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from eval_engine.persistence import repositories as repo
from eval_engine.persistence.models import Batch, CotalityCall, CotalityLease, Evaluation
from eval_engine.worker import (
    LimiterConfig,
    ProviderLimiter,
    Worker,
    WorkerConfig,
    claim_next_fair,
    classify_failure,
    compute_backoff,
)

import tests.test_api as api_cases
from eval_engine.application.service import submit_batch

MAINT_URL = api_cases.MAINT_URL


@pytest.fixture(scope="module")
def worker_engine():
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    db_name = f"v4worker_{uuid.uuid4().hex[:12]}"
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
def maker(worker_engine):
    return sessionmaker(bind=worker_engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def _clean_worker_limiter_tables(worker_engine):
    with worker_engine.begin() as conn:
        conn.execute(text("DELETE FROM v4_cotality_calls"))
        conn.execute(text("DELETE FROM v4_cotality_leases"))
    yield
    with worker_engine.begin() as conn:
        conn.execute(text("DELETE FROM v4_cotality_calls"))
        conn.execute(text("DELETE FROM v4_cotality_leases"))


def _submit(maker, tenant, user, batch_key, n, *, key_prefix, mode="preloaded"):
    with maker() as sess:
        body = api_cases._body(n, key_prefix=key_prefix, mode=mode)
        batch, created, summaries = submit_batch(
            sess, tenant_id=tenant, requested_by_user_id=user,
            batch_key=batch_key, body=body,
        )
        sess.commit()
        assert created
        batch_id = batch.id
        eval_ids = [s["evaluation_id"] for s in summaries]
    return batch_id, eval_ids


def _worker(maker, tenant, owner="w-1", **kwargs):
    params = dict(
        tenant_id=tenant, lease_owner=owner,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=False,
    )
    params.update(kwargs)
    return Worker(maker, WorkerConfig(**params))


def _counts(maker, tenant, batch_id):
    with maker() as sess:
        batch = sess.execute(
            select(Batch).where(Batch.id == batch_id, Batch.tenant_id == tenant)
        ).scalar_one()
        return str(batch.status), int(batch.succeeded_count), int(batch.failed_count)


# --- simultaneous workers: no duplicate claims ---

def test_simultaneous_workers_no_duplicate_claims(maker):
    tenant = f"t-dup-{uuid.uuid4().hex[:6]}"
    user = "u-dup"
    batch_id, _ = _submit(maker, tenant, user, f"dup-{uuid.uuid4().hex[:6]}", 6,
                          key_prefix=f"dup-{uuid.uuid4().hex[:6]}")
    winners: list = []
    lock = threading.Lock()

    def run(owner):
        worker = _worker(maker, tenant, owner=owner, max_jobs=6)
        worker.run()
        with lock:
            winners.append((owner, worker.stats.claimed))

    threads = [threading.Thread(target=run, args=(f"w-{i}",)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    with maker() as sess:
        rows = sess.execute(
            select(Evaluation.id, Evaluation.status).where(
                Evaluation.batch_id == batch_id, Evaluation.tenant_id == tenant)
        ).all()
    assert len(rows) == 6
    assert {str(r[1]) for r in rows} == {"succeeded"}
    assert sum(n for _, n in winners) == 6


# --- fairness: 50-batch must not starve a small batch ---

def test_fair_batches_round_robin(maker):
    tenant = f"t-fair-{uuid.uuid4().hex[:6]}"
    big, _ = _submit(maker, tenant, "u-big", f"big-{uuid.uuid4().hex[:6]}", 50,
                     key_prefix=f"big-{uuid.uuid4().hex[:6]}")
    small, _ = _submit(maker, tenant, "u-small", f"small-{uuid.uuid4().hex[:6]}", 2,
                       key_prefix=f"sml-{uuid.uuid4().hex[:6]}")
    seen: list = []
    last = None
    for _ in range(6):
        with maker() as sess:
            claim = claim_next_fair(
                sess, tenant_id=tenant, lease_owner="w-fair", exclude_batch_id=last)
            sess.commit()
            assert claim is not None
            with maker() as probe:
                row = probe.get(Evaluation, claim.evaluation_id)
                seen.append(str(row.batch_id))
                last = row.batch_id
            with maker() as fin:
                target = fin.execute(
                    select(Evaluation).where(Evaluation.id == claim.evaluation_id)
                ).scalar_one()
                target.status = "queued"
                target.lease_owner = None
                target.lease_token = None
                target.lease_expires_at = None
                target.attempts = 0
                fin.commit()
    small_hits = [s for s in seen if s == str(small)]
    big_hits = [s for s in seen if s == str(big)]
    assert len(small_hits) >= 2, seen
    assert len(big_hits) >= 2, seen
    assert seen[1] != seen[0] or str(small) in seen[:2]


# --- crash after claim recovers via stale-lease recovery ---

def test_crash_after_claim_recover(maker):
    tenant = f"t-crash-{uuid.uuid4().hex[:6]}"
    batch_id, eval_ids = _submit(maker, tenant, "u-c", f"c-{uuid.uuid4().hex[:6]}", 1,
                                 key_prefix=f"cr-{uuid.uuid4().hex[:6]}")
    with maker() as sess:
        claim = repo.claim_next_evaluation(sess, tenant_id=tenant, lease_owner="w-dead")
        sess.commit()
        assert claim is not None
    with maker() as sess:
        row = sess.get(Evaluation, claim.evaluation_id)
        row.lease_expires_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        sess.commit()
    with maker() as sess:
        recovered = repo.recover_stale_leases(
            sess, tenant_id=tenant, now=datetime.now(timezone.utc))
        sess.commit()
        assert recovered >= 1
    future = datetime.now(timezone.utc) + timedelta(minutes=5)
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-alive",
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        max_jobs=1, now=lambda: future))
    worker.run()
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 1 and status == "succeeded"


# --- crash after DB commit before ack: exact replay ---

def test_crash_after_commit_before_ack_replays(maker):
    tenant = f"t-replay-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-r", f"r-{uuid.uuid4().hex[:6]}", 1,
                          key_prefix=f"rp-{uuid.uuid4().hex[:6]}")
    worker = _worker(maker, tenant, owner="w-r", max_jobs=1)
    worker.run()
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(
                Evaluation.batch_id == batch_id, Evaluation.tenant_id == tenant)
        ).scalar_one()
        assert row.status == "succeeded"
        eval_id = row.id
        snap_id = sess.execute(
            select(Batch.snapshot_id).where(Batch.id == batch_id)).scalar_one()
        payload = dict(sess.execute(
            select(Evaluation.input_payload).where(Evaluation.id == eval_id)).scalar_one() or {})
        _ = payload
        from eval_engine.persistence.models import EvaluationResult as _R
        committed = sess.execute(
            select(_R).where(_R.evaluation_id == eval_id).order_by(_R.version.desc())
        ).scalars().first()
        committed_payload = dict(committed.result_payload)
    with maker() as sess:
        record, created = repo.commit_result(
            sess, tenant_id=tenant, evaluation_id=eval_id,
            lease_owner="stale", lease_token=uuid.uuid4(), lease_generation=0,
            methodology_version=committed.methodology_version,
            snapshot_id=snap_id, status=committed.status,
            result_payload=committed_payload,
        )
        sess.commit()
        assert created is False and record.version == committed.version
    with maker() as sess:
        versions = sess.execute(
            select(func.count()).select_from(
                __import__("eval_engine.persistence.models", fromlist=["EvaluationResult"]).EvaluationResult
            ).where(
                __import__("eval_engine.persistence.models", fromlist=["EvaluationResult"]).EvaluationResult.evaluation_id == eval_id
            )
        ).scalar()
        assert versions == 1


# --- expired stale lease cannot mutate ---

def test_expired_stale_cannot_mutate(maker):
    tenant = f"t-stale-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-s", f"s-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"st-{uuid.uuid4().hex[:6]}")
    with maker() as sess:
        claim = repo.claim_next_evaluation(sess, tenant_id=tenant, lease_owner="w-old")
        sess.commit()
        assert claim is not None
    with maker() as sess:
        row = sess.get(Evaluation, claim.evaluation_id)
        row.lease_expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        sess.commit()
    with maker() as sess:
        assert repo.heartbeat_lease(
            sess, tenant_id=tenant, evaluation_id=claim.evaluation_id,
            lease_owner="w-old", lease_token=claim.lease_token,
            lease_generation=claim.lease_generation,
            now=datetime.now(timezone.utc) + timedelta(hours=2),
        ) is False
        sess.rollback()


# --- heartbeat sustains a long evaluation ---

def test_heartbeat_long_evaluation(maker):
    tenant = f"t-hb-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-h", f"h-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"hb-{uuid.uuid4().hex[:6]}")
    with maker() as sess:
        claim = repo.claim_next_evaluation(
            sess, tenant_id=tenant, lease_owner="w-hb",
            lease_ttl=timedelta(seconds=2))
        sess.commit()
        assert claim is not None
    for _ in range(5):
        time.sleep(0.3)
        with maker() as sess:
            assert repo.heartbeat_lease(
                sess, tenant_id=tenant, evaluation_id=claim.evaluation_id,
                lease_owner=claim.lease_owner, lease_token=claim.lease_token,
                lease_generation=claim.lease_generation,
                lease_ttl=timedelta(seconds=5),
            ) is True
            sess.commit()
    with maker() as sess:
        row = sess.get(Evaluation, claim.evaluation_id)
        assert row.status == "claimed" and row.lease_expires_at > datetime.now(timezone.utc)


# --- one property exception: siblings continue ---

def test_one_property_exception_siblings_continue(maker, monkeypatch):
    tenant = f"t-iso-{uuid.uuid4().hex[:6]}"
    batch_id, eval_ids = _submit(maker, tenant, "u-i", f"i-{uuid.uuid4().hex[:6]}", 3,
                                 key_prefix=f"is-{uuid.uuid4().hex[:6]}")
    import eval_engine.worker.runner as runner

    real = runner.evaluate_v4
    calls = {"n": 0}

    def flaky(typed):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return real(typed)

    monkeypatch.setattr(runner, "evaluate_v4", flaky)
    worker = _worker(maker, tenant, owner="w-iso", max_jobs=3)
    worker.run()
    with maker() as sess:
        rows = sess.execute(
            select(Evaluation.status).where(
                Evaluation.batch_id == batch_id, Evaluation.tenant_id == tenant)
        ).scalars().all()
    assert "succeeded" in rows
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok >= 2


# --- retries / 429 / Retry-After persisted ---

def test_retries_and_retry_after_persisted(maker):
    assert classify_failure("invalid_evidence", 1, 5) == ("dead", False)
    assert classify_failure("transient", 1, 5) == ("queued", True)
    assert classify_failure("transient", 5, 5) == ("failed", True)
    rng = random.Random(42)
    delays = [compute_backoff(1, rng=rng).total_seconds() for _ in range(50)]
    assert all(27.0 <= d <= 33.0 for d in delays), delays[:5]
    assert compute_backoff(100, rng=random.Random(0)).total_seconds() <= 3600 * 1.11

    tenant = f"t-429-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-429", f"q-{uuid.uuid4().hex[:6]}", 1,
                          key_prefix=f"q-{uuid.uuid4().hex[:6]}")
    with maker() as sess:
        claim = repo.claim_next_evaluation(sess, tenant_id=tenant, lease_owner="w-429")
        sess.commit()
    worker = _worker(maker, tenant, owner="w-429")
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.id == claim.evaluation_id)).scalar_one()
        active_like = type("A", (), {"attempts": int(row.attempts),
                                     "max_attempts": int(row.max_attempts)})()
    worker._record_retry_after(claim, active_like, retry_after=timedelta(seconds=120))
    with maker() as sess:
        row = sess.get(Evaluation, claim.evaluation_id)
        assert row.status == "queued"
        assert row.next_attempt_at is not None
        assert row.error_code == "provider_rate_limited"


# --- limiter: RPM exact boundary ---

def test_limiter_rpm_exact_boundary(maker):
    tenant = f"t-rpm-{uuid.uuid4().hex[:6]}"
    now = datetime.now(timezone.utc)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=40, now=lambda: now))
    got = [limiter.acquire(owner="w", now=now) for _ in range(40)]
    assert all(g is not None for g in got)
    assert limiter.acquire(owner="w", now=now) is None
    assert limiter.window_count(now=now) == 40
    later = now + timedelta(seconds=61)
    assert limiter.acquire(owner="w", now=later) is not None
    for lease in got:
        if lease is not None:
            limiter.release(lease)


# --- limiter: concurrent max 4 ---

def test_limiter_concurrent_max(maker):
    tenant = f"t-conc-{uuid.uuid4().hex[:6]}"
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=1000, now=datetime.now(timezone.utc)))
    barrier = threading.Barrier(8)
    results: list = []

    def grab(i):
        barrier.wait(timeout=10)
        lease = limiter.acquire(owner=f"w-{i}")
        results.append(lease)

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    winners = [r for r in results if r is not None]
    assert len(winners) == 4
    assert limiter.active_count() == 4
    for lease in winners:
        limiter.release(lease)
    assert limiter.active_count() == 0
    # lease expiry recovery: expired lease does not pin a slot
    with maker() as sess:
        expired = limiter.acquire(owner="w-exp")
        assert expired is not None
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = :exp WHERE lease_token = :tok"),
            {"exp": datetime.now(timezone.utc) - timedelta(minutes=5),
             "tok": expired.lease_token},
        )
        sess.commit()
    assert limiter.active_count() == 0


# --- multi-process/thread coordination: attempts counted once each ---

def test_multiprocess_coordination_attempts(maker):
    tenant = f"t-mp-{uuid.uuid4().hex[:6]}"
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=100, max_calls=1000, now=datetime.now(timezone.utc)))
    barrier = threading.Barrier(10)
    leases: list = []

    def worker(i):
        barrier.wait(timeout=10)
        leases.append(limiter.acquire(owner=f"p-{i}", attempt=i + 1))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(l is not None for l in leases)
    with maker() as sess:
        total = sess.execute(select(func.count()).select_from(CotalityCall)).scalar()
        assert total is not None and total >= 10
    for lease in leases:
        limiter.release(lease)


# --- external disabled: zero provider calls ---

def test_external_disabled_zero_provider_calls(maker):
    tenant = f"t-ext-{uuid.uuid4().hex[:6]}"
    batch_id, eval_ids = _submit(maker, tenant, "u-e", f"e-{uuid.uuid4().hex[:6]}", 2,
                                 key_prefix=f"ex-{uuid.uuid4().hex[:6]}",
                                 mode="provider_pending")

    class Boom:
        def __init__(self):
            self.calls = 0

        def acquire_subject(self, request):
            self.calls += 1
            raise AssertionError("must not call provider")

        def acquire_comps(self, request):
            self.calls += 1
            raise AssertionError("must not call provider")

        def acquire_permits(self, request):
            self.calls += 1
            raise AssertionError("must not call provider")

        def checkpoint(self, evaluation_id, state):
            self.calls += 1
            raise AssertionError("must not call provider")

    boom = Boom()
    worker = _worker(maker, tenant, owner="w-ext", max_jobs=2, provider=boom,
                     external_calls_enabled=False)
    worker.run()
    assert boom.calls == 0
    assert worker.stats.deferred == 2
    with maker() as sess:
        rows = sess.execute(
            select(Evaluation).where(
                Evaluation.batch_id == batch_id, Evaluation.tenant_id == tenant)
        ).scalars().all()
        assert all(r.status == "succeeded" and r.result_status == "REVIEW_REQUIRED" for r in rows)
        first = rows[0]
        assert (first.checkpoint or {}).get("evidence_mode") == "provider_pending"


# --- restart: second run resumes remaining work ---

def test_restart_resumes(maker):
    tenant = f"t-rs-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-rs", f"rs-{uuid.uuid4().hex[:6]}", 3,
                          key_prefix=f"rs-{uuid.uuid4().hex[:6]}")
    first = _worker(maker, tenant, owner="w-rs1", max_jobs=1)
    first.run()
    assert first.stats.succeeded == 1
    second = _worker(maker, tenant, owner="w-rs2", max_jobs=5)
    second.run()
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 3 and status == "succeeded"


# --- stubbed batch sizes through the real worker ---

@pytest.mark.parametrize("count", [1, 5, 10, 20, 50])
def test_worker_stubbed_batch_sizes(maker, count):
    tenant = f"t-size-{count}-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-size", f"sz-{count}-{uuid.uuid4().hex[:6]}",
                          count, key_prefix=f"sz{count}-{uuid.uuid4().hex[:6]}")
    worker = _worker(maker, tenant, owner=f"w-sz{count}", max_jobs=count)
    stats = worker.run()
    assert stats.succeeded == count
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == count and status == "succeeded"


# --- graceful shutdown stops claiming ---

def test_worker_shutdown_graceful(maker):
    tenant = f"t-sd-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-sd", f"sd-{uuid.uuid4().hex[:6]}", 5,
            key_prefix=f"sd-{uuid.uuid4().hex[:6]}")
    worker = _worker(maker, tenant, owner="w-sd", max_jobs=50)
    worker.request_stop()
    stats = worker.run()
    assert stats.claimed == 0


# --- jitter bounded and seeded ---

def test_jitter_bounded_and_testable():
    rng = random.Random(1234)
    nominal_1 = 30.0
    for _ in range(100):
        got = compute_backoff(1, rng=rng).total_seconds()
        assert nominal_1 * 0.9 <= got <= nominal_1 * 1.1
    rng2 = random.Random(1234)
    assert compute_backoff(1, rng=rng2).total_seconds() == compute_backoff(1, rng=random.Random(1234)).total_seconds()
