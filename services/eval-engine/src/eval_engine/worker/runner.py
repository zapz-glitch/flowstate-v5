"""Supervised worker: fair owner-scoped queue consumption.

A worker run is one supervised pass: recover stale leases owned by this
tenant scope, then claim evaluations one at a time and process each to
a terminal or queued-retry state. Claims are canonical
(:func:`claim_next_evaluation` with ``FOR UPDATE SKIP LOCKED``), fairness
is round-robin across batches (oldest-due batch first, excluding the
just-processed batch when alternatives exist) so one 50-property batch
cannot starve smaller batches, and every mutation is lease-fenced.

Execution per property is isolated: mark running, heartbeat during work,
persist acquisition checkpoints, evaluate the deterministic engine for
preloaded evidence, commit the result under the active lease (fenced
replay on duplicate delivery), and map unexpected exceptions to a
bounded retry or terminal non-retryable failure. provider_pending items
use the typed ProviderPort and persist acquisition checkpoints; when
external calls are disabled they resolve to a deferred REVIEW_REQUIRED
terminal without any provider call, never spin.
"""

from __future__ import annotations

import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..contracts.settings import to_persistence_status
from ..domain.evaluate import evaluate_v4
from ..persistence import repositories as repo
from ..persistence.models import Batch, Evaluation
from .limiter import ProviderLimiter


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


NON_RETRYABLE = frozenset({"invalid_evidence", "validation_error", "auth_denied"})
RETRYABLE = frozenset({"transient", "lease_expired", "provider_timeout"})

RETRY_BASE_SECONDS = 30.0
RETRY_MAX_SECONDS = 3600.0
# Bounded, testable jitter fraction: +/-10% of the nominal backoff.
JITTER_FRACTION = 0.10


def compute_backoff(attempts: int, *, rng: random.Random | None = None) -> timedelta:
    """Bounded exponential backoff with bounded jitter (testable).

    Nominal: 30s * 2**(attempts-1) capped at 1h. Jitter is uniform in
    +/-10% of nominal using the supplied RNG (default: module random).
    Never negative, never above the cap plus jitter.
    """
    shift = min(max(0, attempts - 1), 10)
    nominal = min(RETRY_BASE_SECONDS * (2**shift), RETRY_MAX_SECONDS)
    source = rng if rng is not None else random
    delta = source.uniform(-JITTER_FRACTION * nominal, JITTER_FRACTION * nominal)
    return timedelta(seconds=max(0.0, nominal + delta))


def classify_failure(error_code: str, attempts: int, max_attempts: int) -> tuple[str, bool]:
    """Map (error_code, attempts) to (terminal-or-retry, retriable).

    Non-retryable codes go terminal immediately. Retryable/unknown codes
    retry while attempts < max_attempts, else terminal. Returns
    (execution_status, retriable) where execution_status is one of
    "queued" (retry), "failed" (retryable exhausted), "dead"
    (non-retryable terminal).
    """
    if error_code in NON_RETRYABLE:
        return "dead", False
    if attempts < max_attempts:
        return "queued", True
    return "failed", True


@dataclass
class WorkerConfig:
    tenant_id: str
    lease_owner: str
    lease_ttl: timedelta = field(default_factory=lambda: repo.LEASE_TTL)
    heartbeat_interval: timedelta = field(default_factory=lambda: timedelta(seconds=30))
    poll_interval: timedelta = field(default_factory=lambda: timedelta(seconds=1))
    max_jobs: int | None = None
    external_calls_enabled: bool = False
    provider: Any | None = None
    limiter: ProviderLimiter | None = None
    retry_after_default: timedelta = field(default_factory=lambda: timedelta(seconds=60))
    now: Callable[[], datetime] = _utcnow


@dataclass
class WorkerStats:
    claimed: int = 0
    succeeded: int = 0
    deferred: int = 0
    retried: int = 0
    failed: int = 0
    dead: int = 0
    recovered: int = 0


@dataclass
class _ActiveClaim:
    evaluation_id: uuid.UUID
    batch_id: uuid.UUID
    requested_by_user_id: str
    input_payload: dict
    checkpoint: dict
    attempts: int
    max_attempts: int


def claim_next_fair(
    session: Session,
    *,
    tenant_id: str,
    lease_owner: str,
    exclude_batch_id: uuid.UUID | str | None = None,
    lease_ttl: timedelta = repo.LEASE_TTL,
    now: datetime | None = None,
) -> repo.Claim | None:
    """Claim the oldest-due evaluation from the oldest-due batch.

    Fairness: pick the batch holding the oldest due queued row (oldest
    created_at/oldest id, tenant scoped), excluding ``exclude_batch_id``
    when another due batch exists, then claim that batch's oldest due
    row canonically. A lone 50-property batch therefore yields to small
    batches on every other claim instead of starving them.
    """
    current = now or _utcnow()
    due_sub = (
        select(
            Evaluation.batch_id.label("batch_id"),
            func.min(Evaluation.created_at).label("oldest"),
            func.min(Evaluation.next_attempt_at).label("oldest_due"),
        )
        .where(
            Evaluation.tenant_id == tenant_id,
            Evaluation.status == "queued",
            (Evaluation.next_attempt_at.is_(None)) | (Evaluation.next_attempt_at <= current),
            (Evaluation.lease_expires_at.is_(None)) | (Evaluation.lease_expires_at <= current),
        )
        .group_by(Evaluation.batch_id)
        .subquery()
    )
    rows = session.execute(
        select(due_sub.c.batch_id, due_sub.c.oldest, due_sub.c.oldest_due)
        .order_by(
            due_sub.c.oldest_due.asc().nulls_first(),
            due_sub.c.oldest.asc(),
            due_sub.c.batch_id.asc(),
        )
    ).all()
    if not rows:
        return None
    wanted: Any = None
    if exclude_batch_id is not None:
        for row in rows:
            if str(row[0]) != str(exclude_batch_id):
                wanted = row[0]
                break
    if wanted is None:
        wanted = rows[0][0]
    target_id = session.execute(
        select(Evaluation.id)
        .where(
            Evaluation.tenant_id == tenant_id,
            Evaluation.batch_id == wanted,
            Evaluation.status == "queued",
            (Evaluation.next_attempt_at.is_(None)) | (Evaluation.next_attempt_at <= current),
            (Evaluation.lease_expires_at.is_(None)) | (Evaluation.lease_expires_at <= current),
        )
        .order_by(Evaluation.created_at.asc(), Evaluation.id.asc())
        .limit(1)
    ).scalar_one_or_none()
    if target_id is None:
        return None
    from sqlalchemy import text as _text
    from sqlalchemy import update as _update

    claimed_id = session.execute(
        _text(
            "SELECT id FROM v4_evaluations "
            "WHERE tenant_id = :tenant AND id = :id AND status = 'queued' "
            "AND (next_attempt_at IS NULL OR next_attempt_at <= :now) "
            "AND (lease_expires_at IS NULL OR lease_expires_at <= :now) "
            "LIMIT 1 FOR UPDATE SKIP LOCKED"
        ),
        {"tenant": tenant_id, "id": target_id, "now": current},
    ).scalar_one_or_none()
    if claimed_id is None:
        return None
    token = uuid.uuid4()
    expires = current + lease_ttl
    result = session.execute(
        _update(Evaluation)
        .where(
            Evaluation.id == claimed_id,
            Evaluation.tenant_id == tenant_id,
            Evaluation.status == "queued",
        )
        .values(
            status="claimed",
            lease_owner=lease_owner,
            lease_token=token,
            lease_generation=Evaluation.lease_generation + 1,
            lease_expires_at=expires,
            last_heartbeat_at=current,
            attempts=Evaluation.attempts + 1,
            updated_at=current,
        )
        .returning(Evaluation.lease_generation, Evaluation.attempts)
    ).one_or_none()
    if result is None:
        return None
    session.flush()
    return repo.Claim(
        evaluation_id=claimed_id,
        tenant_id=tenant_id,
        lease_owner=lease_owner,
        lease_token=token,
        lease_generation=int(result[0]),
        attempts=int(result[1]),
    )


class Worker:
    """Supervised worker process: graceful, heartbeat-driven, isolated."""

    def __init__(self, session_factory: Callable[[], Session], config: WorkerConfig):
        self._factory = session_factory
        self._config = config
        self._stop = threading.Event()
        self.stats = WorkerStats()

    def request_stop(self) -> None:
        self._stop.set()

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def run(self) -> WorkerStats:
        with self._factory() as session:
            try:
                self.stats.recovered += repo.recover_stale_leases(
                    session, tenant_id=self._config.tenant_id
                )
                session.commit()
            except Exception:
                session.rollback()
        processed = 0
        last_batch: uuid.UUID | None = None
        while not self._stop.is_set():
            if self._config.max_jobs is not None and processed >= self._config.max_jobs:
                break
            claim = self._claim(last_batch)
            if claim is None:
                if self._config.max_jobs is not None:
                    break
                self._sleep(self._config.poll_interval.total_seconds())
                continue
            outcome_batch = self._process_claim(claim)
            last_batch = outcome_batch or last_batch
            processed += 1
            if self._stop.is_set():
                break
        return self.stats

    def run_once(self, *, exclude_batch_id: uuid.UUID | str | None = None) -> bool:
        claim = self._claim(exclude_batch_id)
        if claim is None:
            return False
        self._process_claim(claim)
        return True

    def _sleep(self, seconds: float) -> None:
        end = time.monotonic() + max(0.0, seconds)
        while not self._stop.is_set():
            remaining = end - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.05, remaining))

    def _claim(self, exclude_batch_id: uuid.UUID | str | None) -> repo.Claim | None:
        with self._factory() as session:
            try:
                claim = claim_next_fair(
                    session,
                    tenant_id=self._config.tenant_id,
                    lease_owner=self._config.lease_owner,
                    exclude_batch_id=exclude_batch_id,
                    lease_ttl=self._config.lease_ttl,
                    now=self._config.now(),
                )
                session.commit()
                if claim is not None:
                    self.stats.claimed += 1
                return claim
            except Exception:
                session.rollback()
                return None

    def _process_claim(self, claim: repo.Claim) -> uuid.UUID | None:
        stop_heartbeat = threading.Event()
        heartbeats = self._start_heartbeat_thread(claim, stop_heartbeat)
        try:
            return self._execute_isolated(claim)
        finally:
            stop_heartbeat.set()
            heartbeats.join(timeout=10)

    def _start_heartbeat_thread(self, claim: repo.Claim, stop: threading.Event) -> threading.Thread:
        interval = max(0.05, self._config.heartbeat_interval.total_seconds())

        def _loop() -> None:
            while not stop.wait(interval):
                if self._stop.is_set():
                    break
                try:
                    with self._factory() as session:
                        try:
                            ok = repo.heartbeat_lease(
                                session,
                                tenant_id=claim.tenant_id,
                                evaluation_id=claim.evaluation_id,
                                lease_owner=claim.lease_owner,
                                lease_token=claim.lease_token,
                                lease_generation=claim.lease_generation,
                                lease_ttl=self._config.lease_ttl,
                            )
                            session.commit()
                            if not ok:
                                session.rollback()
                        except Exception:
                            session.rollback()
                except Exception:
                    continue

        thread = threading.Thread(target=_loop, daemon=True)
        thread.start()
        return thread

    def _execute_isolated(self, claim: repo.Claim) -> uuid.UUID | None:
        cfg = self._config
        try:
            with self._factory() as session:
                row = session.execute(
                    select(Evaluation).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == cfg.tenant_id,
                    )
                ).scalar_one_or_none()
                if row is None:
                    session.rollback()
                    return None
                active = _ActiveClaim(
                    evaluation_id=row.id,
                    batch_id=row.batch_id,
                    requested_by_user_id=row.requested_by_user_id,
                    input_payload=dict(row.input_payload or {}),
                    checkpoint=dict(row.checkpoint or {}),
                    attempts=int(row.attempts),
                    max_attempts=int(row.max_attempts),
                )
                batch_id = row.batch_id
                snapshot_id = self._batch_snapshot(session, row.batch_id)
                if not repo.mark_running(
                    session,
                    tenant_id=cfg.tenant_id,
                    evaluation_id=claim.evaluation_id,
                    lease_owner=claim.lease_owner,
                    lease_token=claim.lease_token,
                    lease_generation=claim.lease_generation,
                    now=cfg.now(),
                ):
                    session.rollback()
                    return batch_id
                session.commit()
        except Exception:
            return None
        try:
            return self._run_property(claim, active, batch_id, snapshot_id)
        except repo.LeaseMismatch:
            with self._factory() as session:
                session.rollback()
            return batch_id
        except Exception as exc:
            self._record_failure(claim, active, "transient", str(exc)[:500])
            return batch_id

    def _batch_snapshot(self, session: Session, batch_id: uuid.UUID):
        row = session.execute(
            select(Batch).where(
                Batch.id == batch_id, Batch.tenant_id == self._config.tenant_id
            )
        ).scalar_one()
        session.expire_all()
        fresh = session.execute(
            select(Batch).where(
                Batch.id == batch_id, Batch.tenant_id == self._config.tenant_id
            )
        ).scalar_one()
        return fresh.snapshot_id

    def _run_property(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID, snapshot_id: uuid.UUID
    ) -> uuid.UUID | None:
        cfg = self._config
        stored = dict(active.input_payload or {})
        mode = str(stored.get("evidence_mode") or "preloaded")
        if mode == "provider_pending":
            return self._run_provider_pending(claim, active, batch_id, snapshot_id, stored)
        return self._run_preloaded(claim, active, batch_id, snapshot_id, stored)

    def _typed_evaluation(self, session: Session, stored: dict, snapshot_id: uuid.UUID):
        from ..contracts.comps import CompCandidateV4
        from ..contracts.deal import AdditionalRenovationItemV4, MajorItemEvidenceV4
        from ..contracts.settings import SettingsSnapshotV4
        from ..contracts.subject import SubjectPropertyV4
        from ..contracts import EvaluationRequestV4
        from ..persistence.models import SettingsSnapshot as SnapshotModel

        snap = session.execute(
            select(SnapshotModel).where(
                SnapshotModel.id == snapshot_id,
                SnapshotModel.tenant_id == self._config.tenant_id,
            )
        ).scalar_one()
        settings_dict = dict(snap.content)
        settings_dict["snapshot_id"] = str(snap.id)
        settings_dict["content_hash"] = str(snap.content_hash)
        settings_dict["schema_version"] = snap.snapshot_version
        settings_dict["source_timestamps"] = dict((snap.source or {}).get("source_timestamps", {}))
        settings = SettingsSnapshotV4(**settings_dict)
        return (
            EvaluationRequestV4(
                subject=SubjectPropertyV4(**stored.get("subject", {})),
                comps=[CompCandidateV4(**raw) for raw in stored.get("comps", [])],
                renovation_level=stored.get("renovation_level", ""),
                settings=settings,
                major_item_evidence=[
                    MajorItemEvidenceV4(**raw) for raw in stored.get("major_item_evidence", [])
                ],
                additional_items=[
                    AdditionalRenovationItemV4(**raw) for raw in stored.get("additional_items", [])
                ],
                evaluation_date=stored.get("evaluation_date"),
            ),
            snap,
        )

    def _run_preloaded(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID,
        snapshot_id: uuid.UUID, stored: dict,
    ) -> uuid.UUID | None:
        cfg = self._config
        try:
            with self._factory() as session:
                typed, snap = self._typed_evaluation(session, stored, snapshot_id)
                session.rollback()
            result = evaluate_v4(typed)
        except Exception as exc:
            self._record_failure(claim, active, "invalid_evidence", str(exc)[:500])
            return batch_id
        bound = dict(result.model_dump(mode="json"))
        bound["settings_snapshot_id"] = str(snapshot_id)
        with self._factory() as session:
            snap_row = session.execute(
                select(Batch).where(Batch.id == batch_id)
            ).scalar_one_or_none()
            _ = snap_row
            from ..persistence.models import SettingsSnapshot as SnapshotModel

            snap_obj = session.execute(
                select(SnapshotModel).where(SnapshotModel.id == snapshot_id)
            ).scalar_one()
            bound["settings_content_hash"] = str(snap_obj.content_hash)
            try:
                _, created = repo.commit_result(
                    session,
                    tenant_id=cfg.tenant_id,
                    evaluation_id=claim.evaluation_id,
                    lease_owner=claim.lease_owner,
                    lease_token=claim.lease_token,
                    lease_generation=claim.lease_generation,
                    methodology_version="evaluation-v4",
                    snapshot_id=snapshot_id,
                    status=to_persistence_status(result.status),
                    result_payload=bound,
                    now=cfg.now(),
                )
                session.commit()
                self.stats.succeeded += 1
            except repo.TerminalReplay:
                session.rollback()
                self.stats.succeeded += 1
            except repo.LeaseMismatch:
                session.rollback()
            except Exception as exc:
                session.rollback()
                self._record_failure(claim, active, "transient", str(exc)[:500])
        return batch_id

    def _run_provider_pending(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID,
        snapshot_id: uuid.UUID, stored: dict,
    ) -> uuid.UUID | None:
        cfg = self._config
        checkpoint = dict(active.checkpoint or {})
        checkpoint.update(
            {
                "evidence_mode": "provider_pending",
                "stage": "acquisition",
                "acquisition": dict(stored.get("acquisition") or {}),
            }
        )
        with self._factory() as session:
            try:
                repo.save_checkpoint(
                    session,
                    tenant_id=cfg.tenant_id,
                    evaluation_id=claim.evaluation_id,
                    lease_owner=claim.lease_owner,
                    lease_token=claim.lease_token,
                    lease_generation=claim.lease_generation,
                    checkpoint=checkpoint,
                    now=cfg.now(),
                )
                session.commit()
            except Exception:
                session.rollback()
                return batch_id
        provider = cfg.provider
        if provider is None or not cfg.external_calls_enabled:
            self._defer_provider_pending(claim, active, batch_id, snapshot_id, stored, checkpoint)
            return batch_id
        return self._acquire_then_evaluate(claim, active, batch_id, snapshot_id, stored, provider)

    def _defer_provider_pending(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID,
        snapshot_id: uuid.UUID, stored: dict, checkpoint: dict,
    ) -> None:
        """External calls disabled: no provider call, deferred terminal."""
        cfg = self._config
        with self._factory() as session:
            try:
                from ..persistence.models import SettingsSnapshot as SnapshotModel

                snap = session.execute(
                    select(SnapshotModel).where(SnapshotModel.id == snapshot_id)
                ).scalar_one()
                payload = {
                    "status": "deferred",
                    "evidence_mode": "provider_pending",
                    "reason": "external calls disabled; awaiting provider",
                    "checkpoint": checkpoint,
                    "acquisition": dict(stored.get("acquisition") or {}),
                    "settings_snapshot_id": str(snapshot_id),
                    "settings_content_hash": str(snap.content_hash),
                }
                _, created = repo.commit_result(
                    session,
                    tenant_id=cfg.tenant_id,
                    evaluation_id=claim.evaluation_id,
                    lease_owner=claim.lease_owner,
                    lease_token=claim.lease_token,
                    lease_generation=claim.lease_generation,
                    methodology_version="evaluation-v4",
                    snapshot_id=snapshot_id,
                    status="REVIEW_REQUIRED",
                    result_payload=payload,
                    now=cfg.now(),
                )
                session.commit()
                self.stats.deferred += 1
                _ = created
            except repo.TerminalReplay:
                session.rollback()
                self.stats.deferred += 1
            except Exception:
                session.rollback()

    def _acquire_then_evaluate(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID,
        snapshot_id: uuid.UUID, stored: dict, provider: Any,
    ) -> uuid.UUID | None:
        cfg = self._config
        limiter = cfg.limiter
        lease = None
        try:
            if limiter is not None:
                lease = limiter.acquire(
                    owner=cfg.lease_owner,
                    evaluation_id=claim.evaluation_id,
                    attempt=int(active.attempts),
                )
                if lease is None:
                    self._record_retry_after(claim, active)
                    return batch_id
            subject = provider.acquire_subject(dict(stored.get("acquisition") or stored))
            comps = provider.acquire_comps(dict(stored.get("acquisition") or stored))
            provider.checkpoint(str(claim.evaluation_id), {"subject": True, "comps": True})
            merged = dict(stored)
            if isinstance(subject, dict) and subject:
                merged["subject"] = subject
            if isinstance(comps, list) and comps:
                merged["comps"] = comps
            try:
                with self._factory() as session:
                    repo.save_checkpoint(
                        session,
                        tenant_id=cfg.tenant_id,
                        evaluation_id=claim.evaluation_id,
                        lease_owner=claim.lease_owner,
                        lease_token=claim.lease_token,
                        lease_generation=claim.lease_generation,
                        checkpoint={
                            "evidence_mode": "provider_pending",
                            "stage": "acquired",
                            "acquisition": {"subject": True, "comps": True},
                        },
                        now=cfg.now(),
                    )
                    session.commit()
            except Exception:
                pass
            with self._factory() as session:
                try:
                    typed, _ = self._typed_evaluation(session, merged, snapshot_id)
                    session.rollback()
                except Exception as exc:
                    session.rollback()
                    self._record_failure(claim, active, "invalid_evidence", str(exc)[:500])
                    return batch_id
            try:
                result = evaluate_v4(typed)
            except Exception as exc:
                self._record_failure(claim, active, "invalid_evidence", str(exc)[:500])
                return batch_id
            bound = dict(result.model_dump(mode="json"))
            bound["settings_snapshot_id"] = str(snapshot_id)
            with self._factory() as session:
                from ..persistence.models import SettingsSnapshot as SnapshotModel

                snap = session.execute(
                    select(SnapshotModel).where(SnapshotModel.id == snapshot_id)
                ).scalar_one()
                bound["settings_content_hash"] = str(snap.content_hash)
                try:
                    repo.commit_result(
                        session,
                        tenant_id=cfg.tenant_id,
                        evaluation_id=claim.evaluation_id,
                        lease_owner=claim.lease_owner,
                        lease_token=claim.lease_token,
                        lease_generation=claim.lease_generation,
                        methodology_version="evaluation-v4",
                        snapshot_id=snapshot_id,
                        status=to_persistence_status(result.status),
                        result_payload=bound,
                        now=cfg.now(),
                    )
                    session.commit()
                    self.stats.succeeded += 1
                except repo.TerminalReplay:
                    session.rollback()
                    self.stats.succeeded += 1
                except Exception as exc:
                    session.rollback()
                    self._record_failure(claim, active, "transient", str(exc)[:500])
            return batch_id
        except _ProviderRateLimited as exc:
            if limiter is not None and lease is not None:
                try:
                    limiter.note_rate_limited(lease, retry_after=exc.retry_after)
                except Exception:
                    pass
            self._record_retry_after(claim, active, retry_after=exc.retry_after)
            return batch_id
        except _ProviderError as exc:
            self._record_failure(claim, active, exc.code, exc.detail)
            return batch_id
        except Exception as exc:
            retry_after = getattr(exc, "retry_after", None)
            if retry_after is not None or "ratelimit" in type(exc).__name__.lower():
                delay = retry_after if isinstance(retry_after, timedelta) else None
                if limiter is not None and lease is not None:
                    try:
                        limiter.note_rate_limited(lease, retry_after=delay)
                    except Exception:
                        pass
                self._record_retry_after(claim, active, retry_after=delay)
                return batch_id
            self._record_failure(claim, active, "transient", str(exc)[:500])
            return batch_id
        finally:
            if limiter is not None and lease is not None:
                try:
                    limiter.release(lease)
                except Exception:
                    pass

    def _record_retry_after(
        self, claim: repo.Claim, active: _ActiveClaim, retry_after: timedelta | None = None
    ) -> None:
        cfg = self._config
        delay = retry_after if retry_after is not None else cfg.retry_after_default
        with self._factory() as session:
            try:
                from sqlalchemy import update as _update

                row = session.execute(
                    select(Evaluation).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == cfg.tenant_id,
                    )
                    .with_for_update()
                ).scalar_one_or_none()
                if row is None:
                    session.rollback()
                    return
                now = cfg.now()
                if (
                    row.status not in ("claimed", "running")
                    or row.lease_owner != claim.lease_owner
                    or row.lease_token != claim.lease_token
                    or int(row.lease_generation) != int(claim.lease_generation)
                    or row.lease_expires_at is None
                    or row.lease_expires_at <= now
                ):
                    session.rollback()
                    return
                attempts = int(row.attempts)
                row.status = "queued"
                row.next_attempt_at = now + delay
                row.lease_owner = None
                row.lease_token = None
                row.lease_expires_at = None
                row.error_code = "provider_rate_limited"
                row.error_detail = f"retry after {delay.total_seconds():.0f}s"
                row.retriable = True
                row.updated_at = now
                session.flush()
                _ = _update
                session.commit()
                self.stats.retried += 1
                _ = attempts
            except Exception:
                session.rollback()

    def _record_failure(
        self, claim: repo.Claim, active: _ActiveClaim, error_code: str, detail: str
    ) -> None:
        cfg = self._config
        status, retriable = classify_failure(error_code, int(active.attempts), int(active.max_attempts))
        if status == "queued":
            delay = compute_backoff(int(active.attempts))
            with self._factory() as session:
                try:
                    row = session.execute(
                        select(Evaluation).where(
                            Evaluation.id == claim.evaluation_id,
                            Evaluation.tenant_id == cfg.tenant_id,
                        )
                        .with_for_update()
                    ).scalar_one_or_none()
                    if row is None:
                        session.rollback()
                        return
                    now = cfg.now()
                    if (
                        row.status not in ("claimed", "running")
                        or row.lease_owner != claim.lease_owner
                        or row.lease_token != claim.lease_token
                        or int(row.lease_generation) != int(claim.lease_generation)
                        or row.lease_expires_at is None
                        or row.lease_expires_at <= now
                    ):
                        session.rollback()
                        return
                    row.status = "queued"
                    row.next_attempt_at = now + delay
                    row.lease_owner = None
                    row.lease_token = None
                    row.lease_expires_at = None
                    row.error_code = error_code
                    row.error_detail = detail
                    row.retriable = True
                    row.updated_at = now
                    session.commit()
                    self.stats.retried += 1
                except Exception:
                    session.rollback()
            return
        with self._factory() as session:
            try:
                terminal = repo.fail_evaluation(
                    session,
                    tenant_id=cfg.tenant_id,
                    evaluation_id=claim.evaluation_id,
                    lease_owner=claim.lease_owner,
                    lease_token=claim.lease_token,
                    lease_generation=claim.lease_generation,
                    error_code=error_code,
                    error_detail=detail,
                    retriable=retriable,
                    now=cfg.now(),
                )
                session.commit()
                if terminal == "dead":
                    self.stats.dead += 1
                else:
                    self.stats.failed += 1
            except repo.LeaseMismatch:
                session.rollback()
            except Exception:
                session.rollback()


class _ProviderError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


class _ProviderRateLimited(Exception):
    def __init__(self, retry_after: timedelta | None = None):
        super().__init__("provider rate limited")
        self.retry_after = retry_after


def run_worker(session_factory: Callable[[], Session], config: WorkerConfig) -> WorkerStats:
    return Worker(session_factory, config).run()


__all__ = [
    "JITTER_FRACTION",
    "Worker",
    "WorkerConfig",
    "WorkerStats",
    "classify_failure",
    "claim_next_fair",
    "compute_backoff",
    "run_worker",
]
