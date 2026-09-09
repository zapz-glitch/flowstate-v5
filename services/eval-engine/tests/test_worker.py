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
    RunOutcome,
    Worker,
    WorkerConfig,
    WorkerConfigError,
    ClaimRetryExhausted,
    claim_next_fair,
    classify_failure,
    compute_backoff,
)

import tests.test_api as api_cases
from eval_engine.application.service import submit_batch

MAINT_URL = api_cases.MAINT_URL


@pytest.fixture(scope="module")
def worker_engine(isolated_pg):
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


def _worker(maker, tenant, owner="w-1", user=None, **kwargs):
    params = dict(
        tenant_id=tenant, lease_owner=owner,
        requested_by_user_id=user or owner_user(tenant),
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=False,
    )
    params.update(kwargs)
    return Worker(maker, WorkerConfig(**params))


@pytest.mark.parametrize("selection,expected_ids,expected_arv", [
    (["c2"], ["c2"], "580000"),
    (None, ["c1"], "590000"),
])
def test_supervised_worker_preserves_manual_selection(maker, selection, expected_ids, expected_arv):
    from eval_engine.application.service import read_evaluation

    tenant = f"manual-{uuid.uuid4().hex}"
    user = "staging-user"
    key = uuid.uuid4().hex
    body = api_cases._body(1, key_prefix=key)
    body["evaluations"][0]["selected_comp_ids"] = selection
    with maker() as session:
        _, _, summaries = submit_batch(session, tenant_id=tenant,
            requested_by_user_id=user, batch_key=key, body=body)
        session.commit()
    stats = _worker(maker, tenant, user=user, max_jobs=1).run()
    assert stats.succeeded == 1
    with maker() as session:
        result = read_evaluation(session, tenant_id=tenant,
            requested_by_user_id=user, evaluation_id=summaries[0]["evaluation_id"])
    assert result["result"]["arv"]["accepted_comp_ids"] == expected_ids
    assert result["result"]["arv"]["final_arv"] == expected_arv


def owner_user(tenant):
    return f"u-{tenant[-6:]}" if len(tenant) > 6 else f"u-{tenant}"


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
        worker = _worker(maker, tenant, owner=owner, user="u-dup", max_jobs=6)
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
                sess, tenant_id=tenant, lease_owner="w-fair", exclude_batch_id=last,
                requested_by_user_id=None)
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
        tenant_id=tenant, lease_owner="w-alive", requested_by_user_id="u-c",
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
    worker = _worker(maker, tenant, owner="w-r", user="u-r", max_jobs=1)
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
    worker = _worker(maker, tenant, owner="w-iso", user="u-i", max_jobs=3)
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
    worker = _worker(maker, tenant, owner="w-429", user="u-429")
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
    worker = _worker(maker, tenant, owner="w-ext", user="u-e", max_jobs=2, provider=boom,
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
    first = _worker(maker, tenant, owner="w-rs1", user="u-rs", max_jobs=1)
    first.run()
    assert first.stats.succeeded == 1
    second = _worker(maker, tenant, owner="w-rs2", user="u-rs", max_jobs=5)
    second.run()
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 3 and status == "succeeded"


# --- regression: non-monotonic app clock must not strand queued rows ---
# (V4-103B repair: claim due comparisons use max(app now, DB now)) ---

def test_worker_survives_non_monotonic_clock(maker):
    tenant = f"t-clock-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-ck", f"ck-{uuid.uuid4().hex[:6]}", 5,
                          key_prefix=f"ck-{uuid.uuid4().hex[:6]}")
    base = datetime.now(timezone.utc)
    calls = {"n": 0}

    def backward_now():
        calls["n"] += 1
        if calls["n"] > 1:
            return base - timedelta(minutes=10)
        return base

    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-ck", requested_by_user_id="u-ck",
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=False, max_jobs=5, now=backward_now))
    stats = worker.run()
    assert stats.succeeded == 5
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 5 and status == "succeeded"


# --- regression: transient claim DB errors must not end a bounded run ---

def test_worker_retries_transient_claim_failures(maker, monkeypatch):
    import eval_engine.worker.runner as runner

    tenant = f"t-tc-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-tc", f"tc-{uuid.uuid4().hex[:6]}", 3,
                          key_prefix=f"tc-{uuid.uuid4().hex[:6]}")
    real = runner.claim_next_fair
    calls = {"n": 0}

    def flaky(session, **kwargs):
        calls["n"] += 1
        if calls["n"] <= 3:
            raise runner._ClaimTransient("boom")
        return real(session, **kwargs)

    monkeypatch.setattr(runner, "claim_next_fair", flaky)
    worker = _worker(maker, tenant, owner="w-tc", user="u-tc", max_jobs=3)
    stats = worker.run()
    assert stats.succeeded == 3
    assert calls["n"] >= 4
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 3 and status == "succeeded"


# --- stubbed batch sizes through the real worker ---

@pytest.mark.parametrize("count", [1, 5, 10, 20, 50])
def test_worker_stubbed_batch_sizes(maker, count):
    tenant = f"t-size-{count}-{uuid.uuid4().hex[:6]}"
    batch_id, _ = _submit(maker, tenant, "u-size", f"sz-{count}-{uuid.uuid4().hex[:6]}",
                          count, key_prefix=f"sz{count}-{uuid.uuid4().hex[:6]}")
    worker = _worker(maker, tenant, owner=f"w-sz{count}", user="u-size", max_jobs=count)
    stats = worker.run()
    assert stats.succeeded == count
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == count and status == "succeeded"


# --- graceful shutdown stops claiming ---

def test_worker_shutdown_graceful(maker):
    tenant = f"t-sd-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-sd", f"sd-{uuid.uuid4().hex[:6]}", 5,
            key_prefix=f"sd-{uuid.uuid4().hex[:6]}")
    worker = _worker(maker, tenant, owner="w-sd", user="u-sd", max_jobs=50)
    worker.request_stop()
    stats = worker.run()
    assert stats.claimed == 0


# --- owner scope: same tenant, different user is isolated ---

def test_owner_scope_claim_isolation(maker):
    tenant = f"t-own-{uuid.uuid4().hex[:6]}"
    batch_a, _ = _submit(maker, tenant, "u-a", f"oa-{uuid.uuid4().hex[:6]}", 2,
                         key_prefix=f"oa-{uuid.uuid4().hex[:6]}")
    batch_b, _ = _submit(maker, tenant, "u-b", f"ob-{uuid.uuid4().hex[:6]}", 2,
                         key_prefix=f"ob-{uuid.uuid4().hex[:6]}")
    worker_a = _worker(maker, tenant, owner="w-a", user="u-a", max_jobs=10)
    stats_a = worker_a.run()
    assert stats_a.succeeded == 2
    with maker() as sess:
        left_b = sess.execute(
            select(func.count()).select_from(Evaluation).where(
                Evaluation.batch_id == batch_b, Evaluation.tenant_id == tenant,
                Evaluation.status == "queued")
        ).scalar()
        assert left_b == 2
        other = sess.execute(
            select(Evaluation).where(
                Evaluation.batch_id == batch_b, Evaluation.tenant_id == tenant)
        ).scalars().all()
        assert all(r.requested_by_user_id == "u-b" for r in other)
    worker_b = _worker(maker, tenant, owner="w-b", user="u-b", max_jobs=10)
    assert worker_b.run().succeeded == 2
    for batch_id in (batch_a, batch_b):
        status, ok, _ = _counts(maker, tenant, batch_id)
        assert ok == 2 and status == "succeeded"


def test_owner_scope_recovery_isolation(maker):
    import eval_engine.worker.runner as runner

    tenant = f"t-ownr-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-a", f"ra-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"ra-{uuid.uuid4().hex[:6]}")
    _submit(maker, tenant, "u-b", f"rb-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"rb-{uuid.uuid4().hex[:6]}")
    claims = {}
    for user, owner in (("u-a", "w-a"), ("u-b", "w-b")):
        with maker() as sess:
            claim = repo.claim_next_evaluation(sess, tenant_id=tenant, lease_owner=owner)
            sess.commit()
            claims[user] = claim
    with maker() as sess:
        for claim in claims.values():
            row = sess.get(Evaluation, claim.evaluation_id)
            row.lease_expires_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        sess.commit()
    with maker() as sess:
        recovered = repo.recover_stale_leases(
            sess, tenant_id=tenant, requested_by_user_id="u-a",
            now=datetime.now(timezone.utc))
        sess.commit()
        assert recovered == 1
        row_a = sess.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant,
                Evaluation.requested_by_user_id == "u-a")
        ).scalar_one()
        row_a.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        sess.commit()
    with maker() as sess:
        rows = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)
        ).scalars().all()
        by_user = {r.requested_by_user_id: r.status for r in rows}
        assert by_user["u-a"] == "queued"
        assert by_user["u-b"] in ("claimed", "running")
    # u-b's own row is still under its original (now stale) lease, so
    # rewind its next_attempt_at only if recovery scheduled one, then
    # prove the u-b scoped claim sees exactly its own row and never
    # u-a's queued row: expire the stale lease first (owner-scoped
    # recovery for u-b), then claim in-scope.
    with maker() as sess:
        only_b = repo.recover_stale_leases(
            sess, tenant_id=tenant, requested_by_user_id="u-b",
            now=datetime.now(timezone.utc))
        sess.commit()
        assert only_b == 1
        row_bq = sess.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant,
                Evaluation.requested_by_user_id == "u-b")
        ).scalar_one()
        row_bq.next_attempt_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        sess.commit()
    own_claims: list = []
    with maker() as sess:
        own = claim_next_fair(
            sess, tenant_id=tenant, lease_owner="w-b2",
            requested_by_user_id="u-b")
        sess.commit()
        assert own is not None
        assert str(own.evaluation_id) == str(claims["u-b"].evaluation_id)
        own_claims.append(own)
        other = claim_next_fair(
            sess, tenant_id=tenant, lease_owner="w-b2",
            requested_by_user_id="u-b")
        sess.rollback()
        assert other is None, "u-b scope must not see u-a's queued row"
    with maker() as sess:
        back = sess.get(Evaluation, own_claims[0].evaluation_id)
        assert back is not None and back.requested_by_user_id == "u-b"
    with maker() as sess:
        row_b = sess.execute(
            select(Evaluation).where(
                Evaluation.tenant_id == tenant,
                Evaluation.requested_by_user_id == "u-b")
        ).scalar_one()
        assert row_b.status in ("claimed", "running")


# --- periodic recovery: worker B recovers A's abandoned lease ---

def test_periodic_recovery_mid_run(maker):
    tenant = f"t-prec-{uuid.uuid4().hex[:6]}"
    user = "u-prec"
    batch_id, _ = _submit(maker, tenant, user, f"pr-{uuid.uuid4().hex[:6]}", 2,
                          key_prefix=f"pr-{uuid.uuid4().hex[:6]}")
    with maker() as sess:
        claim = repo.claim_next_evaluation(
            sess, tenant_id=tenant, lease_owner="w-abandoned",
            lease_ttl=timedelta(seconds=1))
        sess.commit()
        assert claim is not None
        abandoned_id = claim.evaluation_id
    time.sleep(1.2)
    worker_b = _worker(
        maker, tenant, owner="w-b", user=user, max_jobs=10,
        recovery_interval=timedelta(seconds=0.2),
        poll_interval=timedelta(seconds=0.05),
        empty_claim_polls=600,
    )
    stats = worker_b.run()
    assert stats.recovered >= 1
    assert stats.succeeded == 2
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 2 and status == "succeeded"


# --- heartbeat continues across shutdown until claim finishes ---

def test_heartbeat_survives_shutdown_until_complete(maker, monkeypatch):
    import eval_engine.worker.runner as runner

    tenant = f"t-hbsd-{uuid.uuid4().hex[:6]}"
    user = "u-hbsd"
    batch_id, _ = _submit(maker, tenant, user, f"hs-{uuid.uuid4().hex[:6]}", 1,
                          key_prefix=f"hs-{uuid.uuid4().hex[:6]}")
    release_eval = threading.Event()
    real_execute = runner.Worker._execute_isolated
    worker_holder: dict = {}

    def blocking_execute(self, claim):
        worker_holder["worker"] = self
        self.request_stop()
        assert release_eval.wait(timeout=30)
        return real_execute(self, claim)

    monkeypatch.setattr(runner.Worker, "_execute_isolated", blocking_execute)
    worker = _worker(
        maker, tenant, owner="w-hbsd", user=user, max_jobs=1,
        lease_ttl=timedelta(seconds=2),
        heartbeat_interval=timedelta(seconds=0.2),
        poll_interval=timedelta(seconds=0.01),
    )
    done: dict = {}

    def run_worker():
        done["stats"] = worker.run()

    thread = threading.Thread(target=run_worker)
    thread.start()
    time.sleep(1.0)
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(
                Evaluation.batch_id == batch_id, Evaluation.tenant_id == tenant)
        ).scalar_one()
        assert row.status in ("claimed", "running")
        assert row.lease_expires_at is not None
        assert row.lease_expires_at > datetime.now(timezone.utc), (
            "heartbeat must keep the in-flight lease alive across shutdown")
        unclaimable = sess.execute(
            select(Evaluation.id).where(
                Evaluation.id == row.id, Evaluation.tenant_id == tenant,
                Evaluation.status == "queued")
        ).scalar_one_or_none()
        assert unclaimable is None
    release_eval.set()
    thread.join(timeout=60)
    assert not thread.is_alive()
    assert done["stats"].succeeded == 1
    status, ok, _ = _counts(maker, tenant, batch_id)
    assert ok == 1 and status == "succeeded"


# --- per-request limiter permits with renewal ---

def test_provider_permits_per_request_with_renewal(maker):
    tenant = f"t-perm-{uuid.uuid4().hex[:6]}"
    user = "u-perm"
    batch_id, _ = _submit(maker, tenant, user, f"pm-{uuid.uuid4().hex[:6]}", 1,
                          key_prefix=f"pm-{uuid.uuid4().hex[:6]}",
                          mode="provider_pending")
    acquired_labels: list = []
    real_acquire = ProviderLimiter.acquire
    real_renew = ProviderLimiter.renew

    def spy_acquire(self, **kwargs):
        lease = real_acquire(self, **kwargs)
        if lease is not None:
            acquired_labels.append(str(kwargs.get("evaluation_id")))
        return lease

    renewals = {"n": 0}

    def spy_renew(self, lease, **kwargs):
        renewals["n"] += 1
        return real_renew(self, lease, **kwargs)

    import eval_engine.worker.runner as runner
    monkeypatch_spy = pytest.MonkeyPatch()
    monkeypatch_spy.setattr(ProviderLimiter, "acquire", spy_acquire)
    monkeypatch_spy.setattr(ProviderLimiter, "renew", spy_renew)
    try:
        class StubProvider:
            def acquire_subject(self, request):
                time.sleep(0.35)
                subject = dict(request.get("subject", {}) or {})
                subject.setdefault("beds", "3")
                subject.setdefault("baths", "2")
                subject.setdefault("year_built", 1990)
                return subject

            def acquire_comps(self, request):
                time.sleep(0.35)
                return [dict(c) for c in (request.get("comps") or [])]

            def acquire_permits(self, request):
                raise AssertionError("permits must not be called without request")

            def checkpoint(self, evaluation_id, state):
                return None

        limiter = ProviderLimiter(
            maker, LimiterConfig(max_active=4, max_calls=1000,
                                 lease_ttl=timedelta(seconds=1)))
        worker = Worker(maker, WorkerConfig(
            tenant_id=tenant, lease_owner="w-perm", requested_by_user_id=user,
            heartbeat_interval=timedelta(seconds=60),
            poll_interval=timedelta(seconds=0.01),
            external_calls_enabled=True, provider=StubProvider(),
            limiter=limiter, max_jobs=1,
            provider_lease_renew_interval=timedelta(seconds=0.1),
        ))
        stats = worker.run()
        assert stats.succeeded == 1
    finally:
        monkeypatch_spy.undo()
    with maker() as sess:
        calls = sess.execute(select(func.count()).select_from(CotalityCall)).scalar()
        assert calls == 2, calls
        assert renewals["n"] >= 1


def test_provider_output_discarded_when_permit_lost(maker, monkeypatch):
    import eval_engine.worker.runner as runner

    tenant = f"t-plost-{uuid.uuid4().hex[:6]}"
    user = "u-plost"
    _submit(maker, tenant, user, f"pl-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"pl-{uuid.uuid4().hex[:6]}", mode="provider_pending")

    class StubProvider:
        def acquire_subject(self, request):
            subject = dict(request.get("subject", {}) or {})
            subject.setdefault("beds", "3")
            subject.setdefault("baths", "2")
            subject.setdefault("year_built", 1990)
            return subject

        def acquire_comps(self, request):
            return [dict(c) for c in (request.get("comps") or [])]

        def checkpoint(self, evaluation_id, state):
            return None

    class SlowProvider(StubProvider):
        def acquire_subject(self, request):
            time.sleep(0.3)
            return super().acquire_subject(request)

    def dead_renew(self, lease, **kwargs):
        return None

    monkeypatch.setattr(ProviderLimiter, "renew", dead_renew)
    limiter = ProviderLimiter(maker, LimiterConfig(max_active=4, max_calls=1000))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-plost", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=SlowProvider(),
        limiter=limiter, max_jobs=1,
        provider_lease_renew_interval=timedelta(seconds=0.01),
    ))
    stats = worker.run()
    assert stats.succeeded == 0
    assert stats.retried >= 1
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)
        ).scalar_one()
        assert row.status == "queued"
        assert row.error_code == "transient"


def test_stale_permit_output_rejected_after_reclaim(maker, monkeypatch):
    """Blocker 1: renewal failure past confirmed expiry + reclaim => reject.

    Deterministic PostgreSQL fencing test (no wall-clock flake):
    tiny permit TTL with renewal hard-failing; the test backdates the
    old lease row past expiry in the DB (DB-relative reclaim), a second
    limiter handle (another process) reclaims and acquires the slot, the
    old stubbed provider then returns, and the old output must be
    rejected: no checkpoint/commit/advance for the stale worker while
    the new owner's authoritative result stands.
    """
    import eval_engine.worker.runner as runner
    from eval_engine.persistence.models import EvaluationResult

    tenant = f"t-stale-{uuid.uuid4().hex[:6]}"
    user = "u-stale"
    _submit(maker, tenant, user, f"sp-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"sp-{uuid.uuid4().hex[:6]}", mode="provider_pending")
    with maker() as sess:
        eval_id = sess.execute(
            select(Evaluation.id).where(Evaluation.tenant_id == tenant)
        ).scalar_one()

    stale_payload = {"stale": True, "marker": "old-owner-output"}
    release_call = threading.Event()
    entered_call = threading.Event()

    class StaleProvider:
        def acquire_subject(self, request):
            entered_call.set()
            assert release_call.wait(timeout=30)
            subject = dict(request.get("subject", {}) or {})
            subject.setdefault("beds", "3")
            subject.setdefault("baths", "2")
            subject.setdefault("year_built", 1990)
            return subject

        def acquire_comps(self, request):
            return [dict(c) for c in (request.get("comps") or [])]

        def checkpoint(self, evaluation_id, state):
            return None

    def failing_renew(self, lease, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    from sqlalchemy.exc import OperationalError
    monkeypatch.setattr(ProviderLimiter, "renew", failing_renew)

    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=1, max_calls=1000,
                             lease_ttl=timedelta(seconds=3600)))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-stale", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=StaleProvider(),
        limiter=limiter, max_jobs=1,
        provider_lease_extend=timedelta(seconds=1),
        provider_lease_renew_interval=timedelta(seconds=0.05),
    ))

    # Grab the real claim the worker will process so the test can
    # backdate the *permit* lease row (not the evaluation lease) past
    # expiry while the provider call is in flight.
    outcome: dict = {}

    def run_worker():
        outcome["stats"] = worker.run()

    thread = threading.Thread(target=run_worker)
    thread.start()
    assert entered_call.wait(timeout=30)
    # DB-relative expiry: move every live permit row for this limiter
    # provider past the DB clock so reclaim fires deterministically.
    with maker() as sess:
        sess.execute(
            text("UPDATE v4_cotality_leases SET expires_at = "
                 "statement_timestamp() - make_interval(secs => 5)")
        )
        sess.commit()
    # Another process reclaims the expired slot and holds it.
    other_limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=1, max_calls=1000,
                             lease_ttl=timedelta(seconds=3600)))
    new_permit = other_limiter.acquire(owner="w-new-owner",
                                       evaluation_id=eval_id, attempt=1)
    assert new_permit is not None
    release_call.set()
    thread.join(timeout=60)
    assert not thread.is_alive()
    assert outcome["stats"].succeeded == 0
    assert outcome["stats"].retried >= 1
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.id == eval_id)
        ).scalar_one()
        # Stale output never checkpointed/committed/advanced the row.
        assert row.status == "queued"
        assert row.error_code == "transient"
        assert (row.checkpoint or {}).get("stale") is None
        results = sess.execute(
            select(func.count()).select_from(EvaluationResult).where(
                EvaluationResult.evaluation_id == eval_id)
        ).scalar()
        assert results == 0
        # The new owner's permit is authoritative and still held.
        live = sess.execute(
            select(CotalityLease.lease_token).where(
                CotalityLease.lease_token == new_permit.lease_token)
        ).scalar_one_or_none()
        assert live is not None
    other_limiter.release(new_permit)


def test_accepted_after_renew_failure_repro_rejected(maker, monkeypatch):
    """Direct repro of the prior ACCEPTED_AFTER_RENEW_FAILURE defect.

    Renewal raises (DB outage) for the whole call, the call outlasts a
    short real TTL (expiry forced DB-relative), and the provider returns
    usable output. The old code swallowed the renew exception, never set
    `lost`, and accepted the output. The fixed worker must reject it.
    """
    from sqlalchemy.exc import OperationalError

    tenant = f"t-aarf-{uuid.uuid4().hex[:6]}"
    user = "u-aarf"
    _submit(maker, tenant, user, f"aa-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"aa-{uuid.uuid4().hex[:6]}", mode="provider_pending")

    class SlowGoodProvider:
        def acquire_subject(self, request):
            # Outlasts the 1s confirmed permit TTL below while every
            # renewal raises: authority lapses mid-call, so the usable
            # output returned afterwards must be rejected.
            time.sleep(2.0)
            subject = dict(request.get("subject", {}) or {})
            subject.setdefault("beds", "3")
            subject.setdefault("baths", "2")
            subject.setdefault("year_built", 1990)
            return subject

        def acquire_comps(self, request):
            return [dict(c) for c in (request.get("comps") or [])]

        def checkpoint(self, evaluation_id, state):
            return None

    def boom_renew(self, lease, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    monkeypatch.setattr(ProviderLimiter, "renew", boom_renew)
    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=1000,
                             lease_ttl=timedelta(seconds=1)))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-aarf", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=SlowGoodProvider(),
        limiter=limiter, max_jobs=1,
        provider_lease_extend=timedelta(seconds=30),
        provider_lease_renew_interval=timedelta(seconds=0.05),
    ))
    stats = worker.run()
    assert stats.succeeded == 0, "stale output must not be accepted"
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)
        ).scalar_one()
        assert row.status == "queued"
        assert row.error_code == "transient"
        assert (row.checkpoint or {}).get("stage") != "acquired"


def test_uncertain_renewal_rejected_despite_live_fence(maker, monkeypatch):
    """Blocker 1 follow-up: transient renew failure + live fence => reject.

    The renewal thread raises transiently (authority uncertain) but the
    final token-fenced is_live still returns True (slot row intact, not
    reclaimed). Policy per the fenced-permit contract: renewal
    uncertainty resolves against acceptance, so the usable provider
    output must be discarded with no checkpoint/commit, and the
    evaluation requeues as a bounded transient retry.
    """
    from sqlalchemy.exc import OperationalError
    from eval_engine.persistence.models import EvaluationResult

    tenant = f"t-unct-{uuid.uuid4().hex[:6]}"
    user = "u-unct"
    _submit(maker, tenant, user, f"un-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"un-{uuid.uuid4().hex[:6]}", mode="provider_pending")
    with maker() as sess:
        eval_id = sess.execute(
            select(Evaluation.id).where(Evaluation.tenant_id == tenant)
        ).scalar_one()

    fence_calls = {"n": 0}
    real_is_live = ProviderLimiter.is_live

    def spy_is_live(self, lease):
        fence_calls["n"] += 1
        live = real_is_live(self, lease)
        assert live is True, "test requires the slot to still be held"
        return live

    def flaky_renew(self, lease, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("db down"))

    monkeypatch.setattr(ProviderLimiter, "renew", flaky_renew)
    monkeypatch.setattr(ProviderLimiter, "is_live", spy_is_live)

    class QuickGoodProvider:
        def acquire_subject(self, request):
            # Long enough for several failing renewal ticks (0.01s
            # interval) but far short of the 3600s permit TTL, so the
            # slot row stays live and only the uncertainty flag rejects.
            time.sleep(0.3)
            subject = dict(request.get("subject", {}) or {})
            subject.setdefault("beds", "3")
            subject.setdefault("baths", "2")
            subject.setdefault("year_built", 1990)
            return subject

        def acquire_comps(self, request):
            return [dict(c) for c in (request.get("comps") or [])]

        def checkpoint(self, evaluation_id, state):
            return None

    limiter = ProviderLimiter(
        maker, LimiterConfig(max_active=4, max_calls=1000,
                             lease_ttl=timedelta(seconds=3600)))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-unct", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=QuickGoodProvider(),
        limiter=limiter, max_jobs=1,
        provider_lease_renew_interval=timedelta(seconds=0.01),
    ))
    import eval_engine.worker.runner as runner
    orig_permit_call = runner.Worker._permit_call
    seen_uncertain: dict = {}

    def spy_permit_call(self, limiter_arg, **kwargs):
        try:
            return orig_permit_call(self, limiter_arg, **kwargs)
        except runner._PermitLost:
            seen_uncertain["raised"] = True
            raise

    monkeypatch.setattr(runner.Worker, "_permit_call", spy_permit_call)
    stats = worker.run()
    assert stats.succeeded == 0, "uncertain output must not be accepted"
    assert stats.retried >= 1
    assert seen_uncertain.get("raised") is True
    assert fence_calls["n"] >= 1, "final token-fenced check must have run"
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.id == eval_id)
        ).scalar_one()
        assert row.status == "queued"
        assert row.error_code == "transient"
        assert (row.checkpoint or {}).get("stage") != "acquired"
        results = sess.execute(
            select(func.count()).select_from(EvaluationResult).where(
                EvaluationResult.evaluation_id == eval_id)
        ).scalar()
        assert results == 0


# --- Retry-After normalization + exhaustion ---

def test_normalize_retry_after_forms(maker):
    worker = _worker(maker, "t-ra-forms", owner="w-ra", user="u-ra")
    assert worker._normalize_retry_after(timedelta(seconds=5)).total_seconds() == 5
    assert worker._normalize_retry_after(7).total_seconds() == 7
    assert worker._normalize_retry_after("9").total_seconds() == 9
    assert worker._normalize_retry_after("12s").total_seconds() == 12
    future = datetime.now(timezone.utc) + timedelta(seconds=30)
    assert 25 <= worker._normalize_retry_after(future).total_seconds() <= 30
    assert worker._normalize_retry_after(future.isoformat()).total_seconds() > 0
    with pytest.raises(ValueError):
        worker._normalize_retry_after(-3)
    with pytest.raises(ValueError):
        worker._normalize_retry_after("-5s")
    assert worker._normalize_retry_after("not-a-date") == worker._config.retry_after_default


def test_provider_retry_exhaustion_terminal(maker):
    tenant = f"t-exh-{uuid.uuid4().hex[:6]}"
    user = "u-exh"
    _submit(maker, tenant, user, f"ex-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"ex-{uuid.uuid4().hex[:6]}", mode="provider_pending")

    class Always429:
        def acquire_subject(self, request):
            import eval_engine.worker.runner as runner
            raise runner._ProviderRateLimited(retry_after=timedelta(seconds=1))

        def acquire_comps(self, request):
            raise AssertionError("unreachable")

        def checkpoint(self, evaluation_id, state):
            return None

    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)).scalar_one()
        row.max_attempts = 1
        sess.commit()
    limiter = ProviderLimiter(maker, LimiterConfig(max_active=4, max_calls=1000))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-exh", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=Always429(),
        limiter=limiter, max_jobs=5,
    ))
    stats = worker.run()
    assert stats.failed == 1
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)).scalar_one()
        assert row.status == "failed"
        assert row.retriable is True


def test_limiter_capacity_deferral_bounded_terminal(maker):
    tenant = f"t-cap-{uuid.uuid4().hex[:6]}"
    user = "u-cap"
    _submit(maker, tenant, user, f"cp-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"cp-{uuid.uuid4().hex[:6]}", mode="provider_pending")

    class NeverCalled:
        def acquire_subject(self, request):
            raise AssertionError("provider must not be called without a permit")

        def acquire_comps(self, request):
            raise AssertionError("provider must not be called without a permit")

        def checkpoint(self, evaluation_id, state):
            raise AssertionError("unreachable")

    limiter = ProviderLimiter(maker, LimiterConfig(max_active=4, max_calls=1000))
    worker = Worker(maker, WorkerConfig(
        tenant_id=tenant, lease_owner="w-cap", requested_by_user_id=user,
        heartbeat_interval=timedelta(seconds=60),
        poll_interval=timedelta(seconds=0.01),
        external_calls_enabled=True, provider=NeverCalled(),
        limiter=limiter, max_jobs=50, max_limiter_defers=2,
        retry_after_default=timedelta(seconds=0),
        recovery_interval=timedelta(seconds=3600),
    ))
    real_acquire = ProviderLimiter.acquire
    import eval_engine.worker.runner as runner
    with maker() as sess:
        row = sess.execute(
            select(Evaluation).where(Evaluation.tenant_id == tenant)).scalar_one()
        eval_id = row.id
    calls = {"n": 0}

    def refuse_once(self, **kwargs):
        calls["n"] += 1
        return None

    limiter.acquire = refuse_once.__get__(limiter, ProviderLimiter)
    try:
        stats = worker.run()
    finally:
        limiter.acquire = real_acquire.__get__(limiter, ProviderLimiter)
    assert stats.failed == 1
    with maker() as sess:
        row = sess.get(Evaluation, eval_id)
        assert row.error_code == "limiter_exhausted"
        assert calls["n"] >= 3, "each deferral must re-attempt a fresh permit"
        checkpoint = dict(row.checkpoint or {})
        assert int(checkpoint.get("limiter_defers", 0)) >= 2


# --- run_once distinguishes empty from failed ---

def test_run_once_empty_vs_failed(maker, monkeypatch):
    import eval_engine.worker.runner as runner

    tenant = f"t-once-{uuid.uuid4().hex[:6]}"
    worker = _worker(maker, tenant, owner="w-once", user="u-once", max_jobs=5)
    assert worker.run_once() == RunOutcome.EMPTY

    def boom(session, **kwargs):
        raise runner._ClaimTransient("db down")

    monkeypatch.setattr(runner, "claim_next_fair", boom)
    assert worker.run_once() == RunOutcome.FAILED


# --- fatal claim failures propagate; budget exhaustion raises ---

def test_fatal_claim_error_propagates(maker, monkeypatch):
    import eval_engine.worker.runner as runner
    from sqlalchemy.exc import ProgrammingError

    tenant = f"t-fatal-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-f", f"fa-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"fa-{uuid.uuid4().hex[:6]}")

    def fatal(session, **kwargs):
        raise ProgrammingError("SELECT 1", {}, Exception("no such column"))

    monkeypatch.setattr(runner, "claim_next_fair", fatal)
    worker = _worker(maker, tenant, owner="w-f", user="u-f", max_jobs=5)
    with pytest.raises(ProgrammingError):
        worker.run()


def test_claim_retry_budget_exhaustion_raises(maker, monkeypatch):
    import eval_engine.worker.runner as runner

    tenant = f"t-bud-{uuid.uuid4().hex[:6]}"
    _submit(maker, tenant, "u-b", f"bu-{uuid.uuid4().hex[:6]}", 1,
            key_prefix=f"bu-{uuid.uuid4().hex[:6]}")

    def down(session, **kwargs):
        raise runner._ClaimTransient("db down")

    monkeypatch.setattr(runner, "claim_next_fair", down)
    worker = _worker(maker, tenant, owner="w-b", user="u-b", max_jobs=5,
                     claim_retry_budget=2,
                     claim_retry_delay=timedelta(seconds=0.001))
    with pytest.raises(ClaimRetryExhausted):
        worker.run()


def test_worker_config_requires_user():
    with pytest.raises(WorkerConfigError):
        WorkerConfig(tenant_id="t", lease_owner="w")


# --- jitter bounded and seeded ---

def test_jitter_bounded_and_testable():
    rng = random.Random(1234)
    nominal_1 = 30.0
    for _ in range(100):
        got = compute_backoff(1, rng=rng).total_seconds()
        assert nominal_1 * 0.9 <= got <= nominal_1 * 1.1
    rng2 = random.Random(1234)
    assert compute_backoff(1, rng=rng2).total_seconds() == compute_backoff(1, rng=random.Random(1234)).total_seconds()
