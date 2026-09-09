"""Supervised worker: fair owner-scoped queue consumption.

A worker run is one supervised pass over one durable owner scope
(tenant + requesting user): recover that scope's stale leases, then
claim evaluations one at a time and process each to a terminal or
queued-retry state. Claims are canonical (``FOR UPDATE SKIP LOCKED``),
fairness is round-robin across batches (oldest-due batch first,
excluding the just-processed batch when alternatives exist) so one
50-property batch cannot starve smaller batches, and every mutation is
lease-fenced.

Execution per property is isolated: mark running, heartbeat during work,
persist acquisition checkpoints, evaluate the deterministic engine for
preloaded evidence, commit the result under the active lease (fenced
replay on duplicate delivery), and map unexpected exceptions to a
bounded retry or terminal non-retryable failure. provider_pending items
use the typed ProviderPort and persist acquisition checkpoints; when
external calls are disabled they resolve to a deferred REVIEW_REQUIRED
terminal without any provider call, never spin.

Provider discipline (one limiter permit per outbound request): each of
acquire_subject / acquire_comps (/ acquire_permits when the acquisition
request carries one) holds its own limiter lease, released in a
``finally``; a background renewal keeps a held permit alive across slow
calls and provider output is discarded when the permit was lost. A
provider 429 keeps its window count and frees the slot; limiter
capacity refusal consumes the claim attempt and requeues with a bounded
delay, terminally failing at attempts exhaustion.

Failure surfacing: only retryable DB operational/disconnect failures
are treated as transient claim failures (bounded retry budget, then
raise); fatal programming/schema/config/permission failures propagate
so the process exits nonzero instead of reporting success. Periodic
owner-scoped recovery runs on a DB-authoritative clock inside short
transactions. Global shutdown stops new claims only; in-flight
heartbeats continue until the active claim finishes.
"""

from __future__ import annotations

import logging
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import func, select, text
from sqlalchemy.exc import (
    DBAPIError,
    DisconnectionError,
    InterfaceError,
    OperationalError,
    TimeoutError,
)
from sqlalchemy.orm import Session

from ..contracts.settings import to_persistence_status
from ..domain.evaluate import evaluate_v4
from ..persistence import repositories as repo
from ..persistence.models import Batch, Evaluation
from .limiter import ProviderLimiter

log = logging.getLogger("v4.worker.runner")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class WorkerConfigError(ValueError):
    """Fatal worker misconfiguration (missing owner scope, bad values)."""


class ClaimRetryExhausted(Exception):
    """Claim retry budget exhausted: repeated transient DB failures."""


def _is_transient_db_error(exc: BaseException) -> bool:
    """True only for retryable DB operational/disconnect failures.

    Fatal programming/schema/config/permission failures (ProgrammingError,
    IntegrityError, DataError, ArgumentError, ...) return False and must
    propagate so they surface instead of being mistaken for an empty
    queue or a retryable blip.
    """
    if isinstance(exc, (DisconnectionError, OperationalError, TimeoutError, InterfaceError)):
        return True
    if isinstance(exc, DBAPIError) and exc.connection_invalidated:
        return True
    return False


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


class RunOutcome:
    EMPTY = "empty"
    CLAIMED = "claimed"
    FAILED = "failed"


@dataclass
class WorkerConfig:
    tenant_id: str
    lease_owner: str
    requested_by_user_id: str = ""
    lease_ttl: timedelta = field(default_factory=lambda: repo.LEASE_TTL)
    heartbeat_interval: timedelta = field(default_factory=lambda: timedelta(seconds=30))
    poll_interval: timedelta = field(default_factory=lambda: timedelta(seconds=1))
    max_jobs: int | None = None
    external_calls_enabled: bool = False
    provider: Any | None = None
    limiter: ProviderLimiter | None = None
    retry_after_default: timedelta = field(default_factory=lambda: timedelta(seconds=60))
    claim_retry_budget: int = 25
    claim_retry_delay: timedelta = field(default_factory=lambda: timedelta(seconds=0.05))
    empty_claim_polls: int = 60
    recovery_interval: timedelta = field(default_factory=lambda: timedelta(seconds=30))
    max_limiter_defers: int = 25
    max_provider_retries: int = 10
    provider_lease_extend: timedelta | None = None
    provider_lease_renew_interval: timedelta = field(
        default_factory=lambda: timedelta(seconds=30)
    )
    now: Callable[[], datetime] = _utcnow

    def __post_init__(self) -> None:
        if not (self.requested_by_user_id or "").strip():
            raise WorkerConfigError(
                "requested_by_user_id is required: the worker consumes one "
                "durable owner scope (tenant + requesting user), never a "
                "default user that could cross ownership."
            )
        if self.max_limiter_defers is not None and int(self.max_limiter_defers) < 1:
            raise WorkerConfigError("max_limiter_defers must be >= 1")
        if self.max_provider_retries is not None and int(self.max_provider_retries) < 1:
            raise WorkerConfigError("max_provider_retries must be >= 1")


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


class _ClaimTransient(Exception):
    """Internal: claim attempt hit a transient DB failure (not empty queue)."""


def _owner_filters(
    *,
    tenant_id: str,
    requested_by_user_id: str | None = None,
) -> list:
    """Owner-scope predicates: tenant always, plus requesting user when set.

    The worker always sets a user (config validation forbids a blank
    one); the parameter stays optional so direct callers / legacy tests
    without a user keep tenant-only semantics.
    """
    wanted = (requested_by_user_id or "").strip()
    if wanted:
        return [
            Evaluation.tenant_id == tenant_id,
            Evaluation.requested_by_user_id == wanted,
        ]
    return [Evaluation.tenant_id == tenant_id]


def _resolve_claim_clock(
    session: Session, *, now: datetime | None
) -> datetime:
    """DB-authoritative claim clock: later of DB now and caller now."""
    try:
        db_now = session.execute(text("SELECT now()")).scalar_one()
    except Exception as exc:
        if _is_transient_db_error(exc):
            raise _ClaimTransient(f"claim clock read failed: {exc}") from exc
        raise
    requested = now or _utcnow()
    try:
        return requested if requested >= db_now else db_now
    except TypeError:
        return db_now


def claim_next_fair(
    session: Session,
    *,
    tenant_id: str,
    lease_owner: str,
    exclude_batch_id: uuid.UUID | str | None = None,
    lease_ttl: timedelta = repo.LEASE_TTL,
    now: datetime | None = None,
    requested_by_user_id: str | None = None,
) -> repo.Claim | None:
    """Claim the oldest-due evaluation from the oldest-due batch.

    Fairness: pick the batch holding the oldest due queued row (oldest
    created_at/oldest id, tenant scoped), excluding ``exclude_batch_id``
    when another due batch exists, then claim that batch's oldest due
    row canonically. A lone 50-property batch therefore yields to small
    batches on every other claim instead of starving them. When
    ``requested_by_user_id`` is set, due batches, target rows, and the
    fenced claim are all filtered to that durable owner scope
    (tenant + requesting user).

    Due comparisons use the later of the database transaction clock
    and the caller-supplied ``now`` so app/DB clock skew — including a
    non-monotonic app clock where a later call reads an earlier wall
    time than the timestamps the database stamped at insert — cannot
    hide rows that are already claimable, while deliberate forward
    time-travel (recovery tests) keeps working. The same clock stamps
    the new lease. Raises :class:`_ClaimTransient` only on retryable DB
    operational/disconnect failures; fatal programming/schema/config/
    permission failures propagate.
    """
    current = _resolve_claim_clock(session, now=now)
    scope = _owner_filters(
        tenant_id=tenant_id, requested_by_user_id=requested_by_user_id
    )
    due_sub = (
        select(
            Evaluation.batch_id.label("batch_id"),
            func.min(Evaluation.created_at).label("oldest"),
            func.min(Evaluation.next_attempt_at).label("oldest_due"),
        )
        .where(
            *scope,
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
            *scope,
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

    claim_predicates = ["tenant_id = :tenant", "id = :id", "status = 'queued'"]
    claim_params: dict[str, Any] = {"tenant": tenant_id, "id": target_id, "now": current}
    owner_user = (requested_by_user_id or "").strip()
    if owner_user:
        claim_predicates.append("requested_by_user_id = :owner_user")
        claim_params["owner_user"] = owner_user
    claimed_id = session.execute(
        _text(
            "SELECT id FROM v4_evaluations "
            f"WHERE {' AND '.join(claim_predicates)} "
            "AND (next_attempt_at IS NULL OR next_attempt_at <= :now) "
            "AND (lease_expires_at IS NULL OR lease_expires_at <= :now) "
            "LIMIT 1 FOR UPDATE SKIP LOCKED"
        ),
        claim_params,
    ).scalar_one_or_none()
    if claimed_id is None:
        return None
    token = uuid.uuid4()
    expires = current + lease_ttl
    claim_update = _update(Evaluation).where(
        Evaluation.id == claimed_id,
        Evaluation.tenant_id == tenant_id,
        Evaluation.status == "queued",
    )
    if owner_user:
        claim_update = claim_update.where(
            Evaluation.requested_by_user_id == owner_user
        )
    result = session.execute(
        claim_update
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

    def _recover_owned_stale_leases(self) -> int:
        """One short owner-scoped recovery pass on the DB clock.

        Fatal DB/config failures propagate (no silent successful exit);
        transient operational failures return 0 so the run continues.
        """
        try:
            with self._factory() as session:
                try:
                    db_now = session.execute(text("SELECT now()")).scalar_one()
                except Exception as exc:
                    if _is_transient_db_error(exc):
                        session.rollback()
                        log.warning("worker recovery clock read transiently failed")
                        return 0
                    session.rollback()
                    raise
                try:
                    recovered = repo.recover_stale_leases(
                        session,
                        tenant_id=self._config.tenant_id,
                        requested_by_user_id=self._config.requested_by_user_id,
                        now=db_now,
                    )
                    session.commit()
                except Exception as exc:
                    session.rollback()
                    if _is_transient_db_error(exc):
                        log.warning("worker recovery transiently failed")
                        return 0
                    raise
                return int(recovered)
        except (_ClaimTransient, ClaimRetryExhausted):
            raise
        except Exception:
            raise

    def run(self) -> WorkerStats:
        self.stats.recovered += self._recover_owned_stale_leases()
        processed = 0
        last_batch: uuid.UUID | None = None
        empty_polls = 0
        transient_streak = 0
        last_recovery = time.monotonic()
        recovery_every = max(
            1.0, self._config.recovery_interval.total_seconds()
        )
        while not self._stop.is_set():
            if self._config.max_jobs is not None and processed >= self._config.max_jobs:
                break
            if time.monotonic() - last_recovery >= recovery_every:
                # Periodic owner-scoped recovery inside one short
                # transaction so leases abandoned mid-run are picked up
                # without restarting the worker.
                self.stats.recovered += self._recover_owned_stale_leases()
                last_recovery = time.monotonic()
            try:
                claim = self._claim(last_batch)
            except _ClaimTransient as exc:
                # Transient DB failure: not an empty queue. Retry with a
                # bounded budget so a flapping database cannot spin the
                # runaway loop, and never mistake it for "queue drained".
                # Budget exhaustion raises so the process exits nonzero.
                transient_streak += 1
                if transient_streak > max(1, self._config.claim_retry_budget):
                    raise ClaimRetryExhausted(
                        f"claim retry budget exhausted after "
                        f"{transient_streak - 1} transient failures: {exc}"
                    ) from exc
                self._sleep(self._config.claim_retry_delay.total_seconds())
                continue
            transient_streak = 0
            if claim is None:
                if self._config.max_jobs is not None:
                    # Bounded runs must not exit on one empty poll: commit
                    # visibility, clock skew, and fair-exclusion races can
                    # all produce a transient empty read while queued rows
                    # still exist. Re-poll a bounded number of times, but
                    # break immediately when the queue is provably empty so
                    # drained runs still terminate promptly.
                    empty_polls += 1
                    if not self._queue_may_hold_work():
                        break
                    if empty_polls >= max(1, self._config.empty_claim_polls):
                        break
                    self._sleep(self._config.poll_interval.total_seconds())
                    continue
                self._sleep(self._config.poll_interval.total_seconds())
                continue
            empty_polls = 0
            outcome_batch = self._process_claim(claim)
            last_batch = outcome_batch or last_batch
            processed += 1
            if self._stop.is_set():
                break
        return self.stats

    def run_once(self, *, exclude_batch_id: uuid.UUID | str | None = None) -> str:
        """Process at most one claim; distinguish empty/claimed/failed.

        Returns one of :class:`RunOutcome` members: ``"empty"`` when no
        claimable row exists, ``"claimed"`` after one claim is
        processed, ``"failed"`` when the claim attempt hit a transient
        DB failure. Fatal failures propagate (never reported as empty).
        """
        try:
            claim = self._claim(exclude_batch_id)
        except _ClaimTransient:
            return RunOutcome.FAILED
        if claim is None:
            return RunOutcome.EMPTY
        self._process_claim(claim)
        return RunOutcome.CLAIMED

    def _sleep(self, seconds: float) -> None:
        end = time.monotonic() + max(0.0, seconds)
        while not self._stop.is_set():
            remaining = end - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.05, remaining))

    def _queue_may_hold_work(self) -> bool:
        """Best-effort probe: True unless the scope queue is drained.

        Counts non-terminal rows for this durable owner scope
        (tenant + requesting user). Any live (claimed / running) rows
        mean work may reappear via recovery/lease expiry; on probe
        failure conservatively assume work remains so bounded runs keep
        polling instead of exiting early.
        """
        try:
            with self._factory() as session:
                remaining = session.execute(
                    select(func.count())
                    .select_from(Evaluation)
                    .where(
                        Evaluation.tenant_id == self._config.tenant_id,
                        Evaluation.requested_by_user_id
                        == self._config.requested_by_user_id,
                        Evaluation.status.in_(["queued", "claimed", "running"]),
                    )
                ).scalar() or 0
                return int(remaining) > 0
        except Exception:
            return True

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
                    requested_by_user_id=self._config.requested_by_user_id,
                )
                session.commit()
                if claim is not None:
                    self.stats.claimed += 1
                return claim
            except _ClaimTransient:
                session.rollback()
                raise
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    raise _ClaimTransient(f"claim failed: {exc}") from exc
                raise

    def _process_claim(self, claim: repo.Claim) -> uuid.UUID | None:
        stop_heartbeat = threading.Event()
        heartbeats = self._start_heartbeat_thread(claim, stop_heartbeat)
        try:
            return self._execute_isolated(claim)
        finally:
            stop_heartbeat.set()
            heartbeats.join(timeout=10)

    def _start_heartbeat_thread(self, claim: repo.Claim, stop: threading.Event) -> threading.Thread:
        # Graceful shutdown stops new claims only: the in-flight
        # heartbeat deliberately ignores the global stop event and runs
        # until _process_claim signals `stop` in its finally block.
        interval = max(0.05, self._config.heartbeat_interval.total_seconds())

        def _loop() -> None:
            while not stop.wait(interval):
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
                        except Exception as exc:
                            session.rollback()
                            if not _is_transient_db_error(exc):
                                log.warning("worker heartbeat failed")
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
                        Evaluation.requested_by_user_id == cfg.requested_by_user_id,
                    )
                ).scalar_one_or_none()
                if row is None:
                    session.rollback()
                    log.warning("worker claim target missing; skipping")
                    return None
                if row.lease_owner != claim.lease_owner or row.lease_token != claim.lease_token:
                    session.rollback()
                    log.warning("worker claim lease no longer held; skipping")
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
        except Exception as exc:
            if _is_transient_db_error(exc):
                log.warning("worker claim setup transiently failed")
                self._record_failure_transient(claim, "transient", "claim setup failed")
                return None
            log.warning("worker claim setup failed")
            try:
                self._record_failure_fenced(claim, "transient", "claim setup failed")
            except Exception:
                log.warning("worker claim setup failure could not be persisted")
            raise
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
                Batch.id == batch_id,
                Batch.tenant_id == self._config.tenant_id,
                Batch.requested_by_user_id == self._config.requested_by_user_id,
            )
        ).scalar_one()
        session.expire_all()
        fresh = session.execute(
            select(Batch).where(
                Batch.id == batch_id,
                Batch.tenant_id == self._config.tenant_id,
                Batch.requested_by_user_id == self._config.requested_by_user_id,
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
                selected_comp_ids=stored.get("selected_comp_ids"),
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
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    log.warning("worker acquisition checkpoint transiently failed")
                    self._record_failure_transient(claim, "transient", "checkpoint failed")
                else:
                    log.warning("worker acquisition checkpoint failed")
                    try:
                        self._record_failure_fenced(claim, "transient", "checkpoint failed")
                    except Exception:
                        log.warning("worker checkpoint failure could not be persisted")
                        raise
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

    def _permit_call(
        self,
        limiter: ProviderLimiter,
        *,
        claim: repo.Claim,
        attempts: int,
        label: str,
        call,
    ):
        """Run one outbound provider request under its own limiter permit.

        One permit == one request: acquire before the call, release in a
        ``finally``. A background renewal keeps the permit alive across
        slow calls; if renewal reports the slot lost, the output is
        discarded and the evaluation requeues as a bounded transient
        retry. Raises :class:`_LimiterCapacity` when no permit is
        available and :class:`_ProviderRateLimited` on provider 429.
        """
        cfg = self._config
        lease = limiter.acquire(
            owner=cfg.lease_owner,
            evaluation_id=claim.evaluation_id,
            attempt=max(1, int(attempts)),
        )
        if lease is None:
            raise _LimiterCapacity(label)
        state_lock = threading.Lock()
        # Last DB-confirmed permit expiry. Authority to accept output
        # extends no further than this timestamp: once the clock passes
        # it without a successful DB-confirmed renewal, another process
        # may have reclaimed the slot, so the output must be discarded
        # even if no renewal thread ever reported a failure.
        confirmed_expiry: list = [lease.expires_at]
        uncertain: list = [False]
        lost = threading.Event()
        stop_renew = threading.Event()
        extend = cfg.provider_lease_extend or limiter._config.lease_ttl
        renew_every = max(
            0.05, cfg.provider_lease_renew_interval.total_seconds()
        )

        def _renew_loop() -> None:
            # Renew at most until the call finishes. A lost/expired slot
            # flips `lost` so the caller discards unheld-permit output.
            # A renewal *error* flips `uncertain`: authority is unknown
            # until the next DB-confirmed success, and must be treated
            # as lost no later than the last confirmed expiry.
            while not stop_renew.wait(renew_every):
                try:
                    renewed = limiter.renew(lease, extend=extend)
                except Exception:
                    with state_lock:
                        uncertain[0] = True
                    continue
                if renewed is None:
                    lost.set()
                    break
                with state_lock:
                    confirmed_expiry[0] = renewed.expires_at
                    uncertain[0] = False

        def _confirmed_expired(now: datetime) -> bool:
            with state_lock:
                expiry = confirmed_expiry[0]
            try:
                return now >= expiry
            except TypeError:
                return False

        def _authority_uncertain() -> bool:
            with state_lock:
                return bool(uncertain[0])

        def _sync_fence() -> bool:
            """Synchronous pre-accept fence: token-fenced live check.

            Returns True only when the DB confirms this exact
            (provider, owner, token) slot is still held. Any error or a
            missing row means discard: renewal failures leave authority
            uncertain, and uncertainty resolves against acceptance.
            """
            try:
                return bool(limiter.is_live(lease))
            except Exception:
                return False

        renewer = threading.Thread(target=_renew_loop, daemon=True)
        renewer.start()
        try:
            outcome = call()
        except BaseException:
            stop_renew.set()
            renewer.join(timeout=10)
            try:
                limiter.release(lease)
            except Exception:
                pass
            raise
        stop_renew.set()
        renewer.join(timeout=10)
        fence_ok = _sync_fence()
        try:
            limiter.release(lease)
        except Exception:
            pass
        # Ordering matters: the synchronous fence runs BEFORE release,
        # so acceptance is decided while this permit is still ours to
        # check. Release after the decision cannot retroactively hand
        # authority to another owner for output already accepted, and a
        # failed fence discards before release either way. The
        # evaluation lease/fence still guards persistence downstream, so
        # a newly owning evaluation worker cannot be overwritten.
        if lost.is_set() or not fence_ok:
            # The slot expired mid-call, was reclaimed, or authority is
            # uncertain (renewal errors with no confirming success): the
            # provider output was produced under an unheld or uncertain
            # permit and must be discarded, never accepted or committed.
            raise _PermitLost(label)
        if _authority_uncertain() or _confirmed_expired(_utcnow()):
            # Renewal errors left a gap in DB confirmation reaching past
            # the last confirmed expiry: treat as lost even if the final
            # fence read live (fence and expiry race), to close the
            # renew-failure -> reclaim -> stale-accept window.
            raise _PermitLost(label)
        return outcome

    def _acquire_then_evaluate(
        self, claim: repo.Claim, active: _ActiveClaim, batch_id: uuid.UUID,
        snapshot_id: uuid.UUID, stored: dict, provider: Any,
    ) -> uuid.UUID | None:
        cfg = self._config
        limiter = cfg.limiter
        request = dict(stored.get("acquisition") or stored)
        wants_permits = bool((stored.get("acquisition") or {}).get("permits"))
        steps: list[tuple[str, Any]] = [
            ("subject", lambda: provider.acquire_subject(dict(request))),
            ("comps", lambda: provider.acquire_comps(dict(request))),
        ]
        if wants_permits:
            steps.append(
                ("permits", lambda: provider.acquire_permits(dict(request)))
            )
        fetched: dict[str, Any] = {}
        if limiter is not None:
            for label, call in steps:
                try:
                    fetched[label] = self._permit_call(
                        limiter,
                        claim=claim,
                        attempts=int(active.attempts),
                        label=label,
                        call=call,
                    )
                except _LimiterCapacity:
                    self._record_limiter_deferral(claim, active, label)
                    return batch_id
                except _PermitLost:
                    self._record_failure(
                        claim, active, "transient",
                        f"provider permit lost during {label}",
                    )
                    return batch_id
                except _ProviderRateLimited as exc:
                    self._record_retry_after(
                        claim, active, retry_after=exc.retry_after,
                        detail=f"provider 429 during {label}",
                    )
                    return batch_id
                except _ProviderError as exc:
                    self._record_failure(claim, active, exc.code, exc.detail)
                    return batch_id
                except Exception as exc:
                    retry_after = getattr(exc, "retry_after", None)
                    if retry_after is not None or "ratelimit" in type(exc).__name__.lower():
                        self._record_retry_after(
                            claim, active,
                            retry_after=self._normalize_retry_after(retry_after),
                            detail=f"provider rate limited during {label}",
                        )
                        return batch_id
                    self._record_failure(claim, active, "transient", str(exc)[:500])
                    return batch_id
        else:
            try:
                for label, call in steps:
                    fetched[label] = call()
            except _ProviderRateLimited as exc:
                self._record_retry_after(
                    claim, active, retry_after=exc.retry_after,
                    detail="provider 429",
                )
                return batch_id
            except _ProviderError as exc:
                self._record_failure(claim, active, exc.code, exc.detail)
                return batch_id
            except Exception as exc:
                retry_after = getattr(exc, "retry_after", None)
                if retry_after is not None or "ratelimit" in type(exc).__name__.lower():
                    self._record_retry_after(
                        claim, active,
                        retry_after=self._normalize_retry_after(retry_after),
                        detail="provider rate limited",
                    )
                    return batch_id
                self._record_failure(claim, active, "transient", str(exc)[:500])
                return batch_id
        subject = fetched.get("subject")
        comps = fetched.get("comps")
        try:
            provider.checkpoint(str(claim.evaluation_id), {"subject": True, "comps": True})
        except Exception as exc:
            self._record_failure(claim, active, "transient", str(exc)[:500])
            return batch_id
        merged = dict(stored)
        if isinstance(subject, dict) and subject:
            merged["subject"] = subject
        if isinstance(comps, list) and comps:
            merged["comps"] = comps
        if "permits" in fetched and isinstance(fetched["permits"], list):
            merged["permits"] = fetched["permits"]
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
        except Exception as exc:
            if _is_transient_db_error(exc):
                log.warning("worker acquired checkpoint transiently failed")
                self._record_failure_transient(claim, "transient", "checkpoint failed")
            else:
                log.warning("worker acquired checkpoint failed")
                try:
                    self._record_failure_fenced(claim, "transient", "checkpoint failed")
                except Exception:
                    log.warning("worker acquired checkpoint failure not persisted")
                    raise
            return batch_id
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
                if _is_transient_db_error(exc):
                    log.warning("worker result commit transiently failed")
                    self._record_failure_transient(claim, "transient", str(exc)[:500])
                else:
                    log.warning("worker result commit failed")
                    try:
                        self._record_failure_fenced(claim, "transient", str(exc)[:500])
                    except Exception:
                        log.warning("worker commit failure could not be persisted")
                        raise
        return batch_id

    def _normalize_retry_after(self, retry_after: Any) -> timedelta:
        """Normalize Retry-After hints to a non-negative bounded delay.

        Accepts timedeltas, numeric seconds, numeric strings (optionally
        suffixed with ``s``), and HTTP-date / ISO-8601 datetime forms.
        Rejects negatives and NaN/inf with ValueError; unparseable
        strings fall back to the configured default. Datetimes are
        measured against the worker clock and clamped at zero.
        """
        default = self._config.retry_after_default
        if retry_after is None:
            return default
        if isinstance(retry_after, timedelta):
            seconds = retry_after.total_seconds()
        elif isinstance(retry_after, datetime):
            moment = retry_after
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            seconds = (moment - self._config.now()).total_seconds()
        elif isinstance(retry_after, bool):
            raise ValueError("retry_after must not be boolean")
        elif isinstance(retry_after, (int, float)):
            seconds = float(retry_after)
        elif isinstance(retry_after, str):
            candidate = retry_after.strip()
            if not candidate:
                return default
            lowered = candidate.lower()
            if lowered.endswith("s"):
                candidate = candidate[:-1].strip()
            try:
                seconds = float(candidate)
            except ValueError:
                parsed: datetime | None = None
                for parser in (
                    lambda v: datetime.fromisoformat(v),
                    lambda v: datetime.strptime(v, "%a, %d %b %Y %H:%M:%S %Z"),
                    lambda v: datetime.strptime(v, "%a, %d %b %Y %H:%M:%S GMT"),
                ):
                    try:
                        parsed = parser(candidate)
                        break
                    except (ValueError, TypeError):
                        continue
                if parsed is None:
                    return default
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                seconds = (parsed - self._config.now()).total_seconds()
        else:
            return default
        try:
            value = float(seconds)
        except (TypeError, ValueError):
            return default
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("retry_after must be finite")
        if value < 0:
            raise ValueError("retry_after must not be negative")
        return timedelta(seconds=value)

    def _persisted_attempts(self, claim: repo.Claim) -> tuple[int, int] | None:
        """Best-effort live (attempts, max_attempts); None when unknown.

        Unknown covers a missing row and a transient read failure (the
        lease will expire and recovery will requeue); fatal read
        failures propagate.
        """
        with self._factory() as session:
            try:
                row = session.execute(
                    select(Evaluation.attempts, Evaluation.max_attempts).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == self._config.tenant_id,
                        Evaluation.requested_by_user_id
                        == self._config.requested_by_user_id,
                    )
                ).one_or_none()
            except Exception as exc:
                if _is_transient_db_error(exc):
                    log.warning("worker attempts read transiently failed")
                    return None
                raise
            if row is None:
                return None
            return int(row[0]), int(row[1])

    def _record_limiter_deferral(
        self, claim: repo.Claim, active: _ActiveClaim, label: str
    ) -> None:
        """Bounded limiter-capacity deferral without consuming attempts.

        A refused limiter acquire means the provider was never called, so
        the evaluation attempt counter must not advance. The deferral is
        still bounded and persisted: each deferral bumps a
        ``limiter_defers`` counter in the checkpoint, requeues with a
        short delay, and terminally fails the evaluation once
        ``max_limiter_defers`` is exceeded (using persisted attempts for
        the exhaustion decision, never the stale claim snapshot).
        """
        cfg = self._config
        persisted = self._persisted_attempts(claim)
        if persisted is None:
            log.warning("worker limiter deferral target unknown; keeping lease")
            self._sleep(cfg.retry_after_default.total_seconds())
            return
        _, max_attempts = persisted
        with self._factory() as session:
            try:
                row = session.execute(
                    select(Evaluation).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == cfg.tenant_id,
                        Evaluation.requested_by_user_id == cfg.requested_by_user_id,
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
                checkpoint = dict(row.checkpoint or {})
                defers = int(checkpoint.get("limiter_defers", 0) or 0) + 1
                checkpoint["limiter_defers"] = defers
                checkpoint["last_limiter_deferral"] = label
                max_defers = max(1, int(cfg.max_limiter_defers))
                if defers > max_defers or int(row.attempts) >= int(row.max_attempts):
                    session.rollback()
                    try:
                        terminal = repo.fail_evaluation(
                            session,
                            tenant_id=cfg.tenant_id,
                            evaluation_id=claim.evaluation_id,
                            lease_owner=claim.lease_owner,
                            lease_token=claim.lease_token,
                            lease_generation=claim.lease_generation,
                            error_code="limiter_exhausted",
                            error_detail=(
                                f"limiter capacity refused {label} "
                                f"after {defers} deferrals"
                            )[:500],
                            retriable=True,
                            now=now,
                        )
                        session.commit()
                        if terminal == "dead":
                            self.stats.dead += 1
                        else:
                            self.stats.failed += 1
                    except repo.LeaseMismatch:
                        session.rollback()
                    return
                row.checkpoint = checkpoint
                row.status = "queued"
                row.next_attempt_at = now + cfg.retry_after_default
                row.lease_owner = None
                row.lease_token = None
                row.lease_expires_at = None
                row.error_code = "limiter_capacity"
                row.error_detail = f"limiter refused {label}; deferral {defers}"
                row.retriable = True
                row.updated_at = now
                session.commit()
                self.stats.retried += 1
                _ = max_attempts
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    log.warning("worker limiter deferral transiently failed")
                    return
                log.warning("worker limiter deferral failed")
                raise

    def _record_retry_after(
        self, claim: repo.Claim, active: _ActiveClaim,
        retry_after: Any = None, detail: str | None = None,
    ) -> None:
        cfg = self._config
        persisted = self._persisted_attempts(claim)
        if persisted is None:
            log.warning("worker retry-after target unknown; keeping lease")
            self._sleep(cfg.retry_after_default.total_seconds())
            return
        live_attempts, live_max = persisted
        if live_attempts >= live_max:
            # Provider retry exhaustion is terminal: do not requeue past
            # max_attempts; record a fenced terminal failure instead.
            self._record_failure(
                claim, active, "provider_timeout",
                (detail or "provider retry budget exhausted")[:500],
            )
            return
        hinted = self._normalize_retry_after(retry_after)
        backoff = compute_backoff(max(1, live_attempts))
        delay = hinted if hinted >= backoff else backoff
        with self._factory() as session:
            try:
                row = session.execute(
                    select(Evaluation).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == cfg.tenant_id,
                        Evaluation.requested_by_user_id == cfg.requested_by_user_id,
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
                if int(row.attempts) >= int(row.max_attempts):
                    session.rollback()
                    self._record_failure(
                        claim, active, "provider_timeout",
                        (detail or "provider retry budget exhausted")[:500],
                    )
                    return
                row.status = "queued"
                row.next_attempt_at = now + delay
                row.lease_owner = None
                row.lease_token = None
                row.lease_expires_at = None
                row.error_code = "provider_rate_limited"
                row.error_detail = (
                    detail or f"retry after {delay.total_seconds():.0f}s"
                )[:500]
                row.retriable = True
                row.updated_at = now
                session.commit()
                self.stats.retried += 1
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    log.warning("worker retry-after persist transiently failed")
                    return
                log.warning("worker retry-after persist failed")
                raise

    def _record_failure_transient(
        self, claim: repo.Claim, error_code: str, detail: str
    ) -> None:
        """Best-effort fenced retry/terminal persist after a transient DB hit.

        Used when the primary persistence path itself failed transiently:
        re-reads persisted attempts inside a fresh short transaction and
        records either a bounded retry or a terminal failure. Fatal
        persistence errors propagate. Unknown attempts keep the lease so
        recovery requeues.
        """
        persisted = self._persisted_attempts(claim)
        if persisted is None:
            log.warning("worker failure target unknown; keeping lease")
            self._sleep(self._config.retry_after_default.total_seconds())
            return
        live_attempts, live_max = persisted
        active = _ActiveClaim(
            evaluation_id=claim.evaluation_id,
            batch_id=claim.evaluation_id,
            requested_by_user_id="",
            input_payload={},
            checkpoint={},
            attempts=live_attempts,
            max_attempts=live_max,
        )
        self._record_failure(claim, active, error_code, detail)

    def _record_failure_fenced(
        self, claim: repo.Claim, error_code: str, detail: str
    ) -> None:
        """Persist a fenced retry/terminal state; fatal errors propagate."""
        persisted = self._persisted_attempts(claim)
        if persisted is None:
            log.warning("worker failure target unknown; keeping lease")
            self._sleep(self._config.retry_after_default.total_seconds())
            return
        live_attempts, live_max = persisted
        active = _ActiveClaim(
            evaluation_id=claim.evaluation_id,
            batch_id=claim.evaluation_id,
            requested_by_user_id="",
            input_payload={},
            checkpoint={},
            attempts=live_attempts,
            max_attempts=live_max,
        )
        self._record_failure(claim, active, error_code, detail)

    def _record_failure(
        self, claim: repo.Claim, active: _ActiveClaim, error_code: str, detail: str
    ) -> None:
        cfg = self._config
        persisted = self._persisted_attempts(claim)
        if persisted is None:
            log.warning("worker failure target unknown; keeping lease")
            self._sleep(cfg.retry_after_default.total_seconds())
            return
        live_attempts, live_max = persisted
        provider_codes = {"provider_timeout", "provider_rate_limited", "transient"}
        if error_code in provider_codes:
            provider_retries = int(
                dict(self._provider_retry_counts(claim)).get(
                    str(claim.evaluation_id), 0
                )
                or 0
            )
            if provider_retries >= max(1, int(cfg.max_provider_retries)):
                self._record_terminal(
                    claim, error_code,
                    f"provider retry budget exhausted: {detail}"[:500],
                    retriable=True,
                )
                return
            self._bump_provider_retries(claim)
        status, retriable = classify_failure(error_code, live_attempts, live_max)
        if status == "queued":
            delay = compute_backoff(max(1, live_attempts))
            with self._factory() as session:
                try:
                    row = session.execute(
                        select(Evaluation).where(
                            Evaluation.id == claim.evaluation_id,
                            Evaluation.tenant_id == cfg.tenant_id,
                            Evaluation.requested_by_user_id == cfg.requested_by_user_id,
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
                    if int(row.attempts) >= int(row.max_attempts):
                        session.rollback()
                        self._record_terminal(claim, error_code, detail, retriable=True)
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
                except Exception as exc:
                    session.rollback()
                    if _is_transient_db_error(exc):
                        log.warning("worker failure persist transiently failed")
                        return
                    log.warning("worker failure persist failed")
                    raise
            return
        self._record_terminal(claim, error_code, detail, retriable=retriable)

    def _provider_retry_counts(self, claim: repo.Claim) -> dict:
        with self._factory() as session:
            try:
                row = session.execute(
                    select(Evaluation.checkpoint).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == self._config.tenant_id,
                    )
                ).one_or_none()
            except Exception as exc:
                if _is_transient_db_error(exc):
                    raise _ClaimTransient(f"checkpoint read failed: {exc}") from exc
                raise
            if row is None:
                return {}
            checkpoint = dict(row[0] or {})
            return {str(claim.evaluation_id): int(checkpoint.get("provider_retries", 0) or 0)}

    def _bump_provider_retries(self, claim: repo.Claim) -> None:
        with self._factory() as session:
            try:
                target = session.execute(
                    select(Evaluation).where(
                        Evaluation.id == claim.evaluation_id,
                        Evaluation.tenant_id == self._config.tenant_id,
                    )
                    .with_for_update()
                ).scalar_one_or_none()
                if target is None:
                    session.rollback()
                    return
                checkpoint = dict(target.checkpoint or {})
                checkpoint["provider_retries"] = (
                    int(checkpoint.get("provider_retries", 0) or 0) + 1
                )
                target.checkpoint = checkpoint
                session.commit()
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    log.warning("worker provider retry count transiently failed")
                    return
                raise

    def _record_terminal(
        self, claim: repo.Claim, error_code: str, detail: str, *, retriable: bool
    ) -> None:
        cfg = self._config
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
            except Exception as exc:
                session.rollback()
                if _is_transient_db_error(exc):
                    log.warning("worker terminal persist transiently failed")
                    return
                log.warning("worker terminal persist failed")
                raise


class _ProviderError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


class _ProviderRateLimited(Exception):
    def __init__(self, retry_after: Any = None):
        super().__init__("provider rate limited")
        self.retry_after = retry_after


class _LimiterCapacity(Exception):
    """Limiter refused a permit: provider never called, attempts intact."""

    def __init__(self, label: str = ""):
        super().__init__(f"limiter capacity refused {label}".strip() or "limiter refused")
        self.label = label


class _PermitLost(Exception):
    """A held limiter permit expired mid-call: output must be discarded."""

    def __init__(self, label: str = ""):
        super().__init__(f"limiter permit lost during {label}".strip() or "permit lost")
        self.label = label


def run_worker(session_factory: Callable[[], Session], config: WorkerConfig) -> WorkerStats:
    return Worker(session_factory, config).run()


__all__ = [
    "JITTER_FRACTION",
    "ClaimRetryExhausted",
    "RunOutcome",
    "Worker",
    "WorkerConfig",
    "WorkerConfigError",
    "WorkerStats",
    "classify_failure",
    "claim_next_fair",
    "compute_backoff",
    "run_worker",
]
