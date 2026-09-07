"""Shared PostgreSQL-backed Cotality provider limiter.

Backend contract (one permit == exactly one outbound provider HTTP request):

- ``acquire(owner, evaluation_id, attempt)`` returns a live lease or None.
  Every successful acquire inserts exactly one ``v4_cotality_calls`` row,
  including retries. Call it before EACH outbound HTTP request: a
  subject fetch followed by a comps fetch is TWO acquires and counts as
  TWO requests against the sliding window. ``attempt`` is the 1-based
  per-evaluation attempt number (clamped to >= 1).
- A None return means the concurrency cap (``max_active``) or the sliding
  RPM budget (``max_calls`` per ``window``) is exhausted. The caller must
  back off (persist ``next_attempt``) and retry later; a refused acquire
  consumes no window budget.
- ``renew(lease, extend=None)`` extends a still-live lease by ``extend``
  (default ``lease_ttl``) from the current database time. Backend must
  call it around/between long provider requests so a slow request never
  lets its slot expire while held: with ``max_active=4``, four renewed
  permits keep refusing a fifth past the original TTL. Renewal consumes
  NO window budget (it is not a new request). Returns the updated lease,
  or None when the slot is already expired, missing, or forged: a None
  means the caller no longer holds the slot and must re-acquire.
- ``release(lease)`` frees the slot held for one finished request. Always
  call it in a ``finally`` block. Returns True when a live row was freed,
  False when the lease was already gone or forged. Never raises.
- ``note_rate_limited(lease, retry_after=...)`` frees the slot after a
  provider 429 while keeping the window row (the attempt still counts).

Time rule: every decision reads PostgreSQL ``statement_timestamp()``
inside the decision transaction AFTER taking the advisory lock, and all
window purges, counts, lease expiries, and inserted timestamps use that
single database time, so skewed process clocks cannot make processes
disagree. (``statement_timestamp()``, not ``now()``: ``now()`` freezes
at transaction start, so back-to-back transactions would stamp
identical times and a renew issued milliseconds after an acquire would
not extend the lease.) The ``now`` argument (per call and on
``LimiterConfig``) is TEST-ONLY: when supplied it is honored but never
allowed to move the effective time backwards past the database clock,
so a stale or backward-skewed test clock degrades to database time
instead of under-counting the window. Production callers must leave
``now`` unset.

Concurrency rule: the whole acquire/reclaim/count/insert sequence runs in
one transaction under a PostgreSQL advisory lock, so threads and
processes serialize and the caps cannot oversubscribe.

PostgreSQL only. No in-memory counters are authoritative.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..persistence.models import CotalityCall, CotalityLease

PROVIDER = "cotality"
MAX_ACTIVE_LEASES = 4
WINDOW = timedelta(seconds=60)
SAFE_CALLS_PER_WINDOW = 40
LEASE_TTL = timedelta(minutes=2)
# Advisory lock key for the limiter critical section (arbitrary 64-bit).
_ADVISORY_KEY = 41042026


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    """Normalize to aware UTC; naive values are assumed to be UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass
class ProviderLease:
    id: uuid.UUID
    provider: str
    owner: str
    lease_token: uuid.UUID
    expires_at: datetime


@dataclass
class LimiterConfig:
    provider: str = PROVIDER
    max_active: int = MAX_ACTIVE_LEASES
    window: timedelta = WINDOW
    max_calls: int = SAFE_CALLS_PER_WINDOW
    lease_ttl: timedelta = LEASE_TTL
    # TEST-ONLY clock override. None (production default) means the
    # authoritative PostgreSQL transaction clock is used for everything.
    now: Callable[[], datetime] | datetime | None = None


class RateLimited(Exception):
    """Raised when the limiter refuses an acquisition."""

    def __init__(self, reason: str, *, retry_after: timedelta | None = None):
        super().__init__(reason)
        self.reason = reason
        self.retry_after = retry_after


class ProviderLimiter:
    """PostgreSQL-backed limiter shared across processes."""

    def __init__(self, session_factory: Callable[[], Session], config: LimiterConfig | None = None):
        self._factory = session_factory
        self._config = config or LimiterConfig()

    def _lock(self, session: Session) -> None:
        session.execute(select(func.pg_advisory_xact_lock(_ADVISORY_KEY)))

    def _db_now(self, session: Session) -> datetime:
        # statement_timestamp(): real clock per statement, not the
        # transaction-start snapshot that now() returns. Leases acquired
        # and renewed milliseconds apart must get distinct expiries, and
        # short test TTLs must actually advance between back-to-back
        # transactions -- now() would freeze both to the same value.
        return _as_utc(session.execute(select(func.statement_timestamp())).scalar_one())

    def _requested_time(self, now: datetime | None) -> datetime | None:
        """Resolve the TEST-ONLY explicit time, if any was supplied."""
        if now is not None:
            return _as_utc(now)
        candidate = self._config.now
        if candidate is None:
            return None
        resolved = candidate() if callable(candidate) else candidate
        return _as_utc(resolved)

    def _effective_time(self, session: Session, now: datetime | None) -> datetime:
        """Single authoritative timestamp for one limiter decision.

        Always reads PostgreSQL ``statement_timestamp()`` under the
        advisory lock (per-statement real clock, not the
        transaction-start snapshot ``now()`` returns, so back-to-back
        transactions get distinct times). An explicit test time is
        honored only forward: it can advance the decision past the
        database clock (window-slide tests) but can never move it
        backwards, so stale or backward-skewed clocks degrade to
        database time instead of under-counting the window or
        shortening live leases.
        """
        db_now = self._db_now(session)
        requested = self._requested_time(now)
        if requested is None:
            return db_now
        return requested if requested >= db_now else db_now

    def _reclaim(self, session: Session, now: datetime) -> None:
        cfg = self._config
        session.execute(
            delete(CotalityLease).where(
                CotalityLease.provider == cfg.provider,
                CotalityLease.expires_at <= now,
            )
        )
        session.execute(
            delete(CotalityCall).where(
                CotalityCall.provider == cfg.provider,
                CotalityCall.started_at < now - cfg.window,
            )
        )
        session.flush()

    def acquire(
        self,
        *,
        owner: str,
        evaluation_id: uuid.UUID | None = None,
        attempt: int = 1,
        now: datetime | None = None,
    ) -> ProviderLease | None:
        """Acquire one permit for exactly one outbound provider request.

        On success inserts one lease row plus exactly one request-window
        row and returns the lease. Returns None (no raise) when the
        concurrency cap or the sliding window budget is exhausted; the
        refusal itself consumes no budget. ``now`` is TEST-ONLY.
        """
        cfg = self._config
        if not (owner or "").strip():
            raise ValueError("limiter acquire requires a non-blank owner")
        with self._factory() as session:
            try:
                self._lock(session)
                current = self._effective_time(session, now)
                self._reclaim(session, current)
                active = session.execute(
                    select(func.count())
                    .select_from(CotalityLease)
                    .where(CotalityLease.provider == cfg.provider)
                ).scalar() or 0
                if int(active) >= cfg.max_active:
                    # Commit (not rollback) so the reclaim above persists
                    # instead of accumulating dead rows on hot refusal loops.
                    session.commit()
                    return None
                window_start = current - cfg.window
                used = session.execute(
                    select(func.count())
                    .select_from(CotalityCall)
                    .where(
                        CotalityCall.provider == cfg.provider,
                        CotalityCall.started_at >= window_start,
                    )
                ).scalar() or 0
                if int(used) >= cfg.max_calls:
                    session.commit()
                    return None
                lease = CotalityLease(
                    provider=cfg.provider,
                    owner=owner,
                    lease_token=uuid.uuid4(),
                    expires_at=current + cfg.lease_ttl,
                    created_at=current,
                )
                call = CotalityCall(
                    provider=cfg.provider,
                    owner=owner,
                    evaluation_id=evaluation_id,
                    attempt=max(1, int(attempt)),
                    started_at=current,
                )
                session.add(lease)
                session.add(call)
                session.flush()
                out = ProviderLease(
                    id=lease.id,
                    provider=lease.provider,
                    owner=lease.owner,
                    lease_token=lease.lease_token,
                    expires_at=lease.expires_at,
                )
                session.commit()
                return out
            except Exception:
                session.rollback()
                raise

    def renew(
        self, lease: ProviderLease, *, extend: timedelta | None = None
    ) -> ProviderLease | None:
        """Extend a still-live lease from the current database time.

        Fenced on (provider, owner, token): a forged token, a wrong
        owner, or an already-expired lease returns None and changes no
        rows -- expired slots are never resurrected, so the next acquire
        reclaims them. Consumes no window budget. Raises on database
        errors (None strictly means "slot not held").
        """
        cfg = self._config
        ttl = extend if extend is not None else cfg.lease_ttl
        if ttl <= timedelta(0):
            raise ValueError("renew requires a positive extension")
        if lease.provider != cfg.provider:
            return None
        with self._factory() as session:
            try:
                self._lock(session)
                current = self._effective_time(session, None)
                row = session.execute(
                    select(CotalityLease).where(
                        CotalityLease.provider == lease.provider,
                        CotalityLease.owner == lease.owner,
                        CotalityLease.lease_token == lease.lease_token,
                        CotalityLease.expires_at > current,
                    )
                ).scalar_one_or_none()
                if row is None:
                    session.rollback()
                    return None
                row.expires_at = current + ttl
                session.flush()
                out = ProviderLease(
                    id=row.id,
                    provider=row.provider,
                    owner=row.owner,
                    lease_token=row.lease_token,
                    expires_at=row.expires_at,
                )
                session.commit()
                return out
            except Exception:
                session.rollback()
                raise

    def is_live(self, lease: ProviderLease) -> bool:
        """Token-fenced liveness check: True only while this exact slot is held.

        Fenced on (provider, owner, token) against the DB clock under the
        advisory lock; consumes no window budget and extends nothing.
        Raises on database errors (False strictly means "slot not held").
        This is the synchronous pre-accept fence: call it after a provider
        call returns and discard the output unless it reports live.
        """
        with self._factory() as session:
            try:
                self._lock(session)
                current = self._effective_time(session, None)
                row = session.execute(
                    select(CotalityLease.id).where(
                        CotalityLease.provider == lease.provider,
                        CotalityLease.owner == lease.owner,
                        CotalityLease.lease_token == lease.lease_token,
                        CotalityLease.expires_at > current,
                    )
                ).scalar_one_or_none()
                session.rollback()
                return row is not None
            except Exception:
                session.rollback()
                raise

    def release(self, lease: ProviderLease) -> bool:
        """Free one held slot. Best-effort: never raises.

        Fenced on (provider, owner, token); returns True only when a
        live row was actually freed, False when already gone or forged.
        """
        with self._factory() as session:
            try:
                result = session.execute(
                    delete(CotalityLease).where(
                        CotalityLease.provider == lease.provider,
                        CotalityLease.owner == lease.owner,
                        CotalityLease.lease_token == lease.lease_token,
                    )
                )
                session.commit()
                return (result.rowcount or 0) > 0
            except Exception:
                session.rollback()
                return False

    def note_rate_limited(
        self, lease: ProviderLease, *, retry_after: timedelta | None = None
    ) -> None:
        """Release the lease after a provider 429; window row stays."""
        _ = retry_after
        self.release(lease)

    def active_count(self, *, now: datetime | None = None) -> int:
        with self._factory() as session:
            try:
                self._lock(session)
                self._reclaim(session, self._effective_time(session, now))
                count = session.execute(
                    select(func.count())
                    .select_from(CotalityLease)
                    .where(CotalityLease.provider == self._config.provider)
                ).scalar() or 0
                session.commit()
                return int(count)
            except Exception:
                session.rollback()
                raise

    def window_count(self, *, now: datetime | None = None) -> int:
        with self._factory() as session:
            try:
                self._lock(session)
                current = self._effective_time(session, now)
                count = session.execute(
                    select(func.count())
                    .select_from(CotalityCall)
                    .where(
                        CotalityCall.provider == self._config.provider,
                        CotalityCall.started_at >= current - self._config.window,
                    )
                ).scalar() or 0
                session.rollback()
                return int(count)
            except Exception:
                session.rollback()
                raise


__all__ = [
    "LEASE_TTL",
    "MAX_ACTIVE_LEASES",
    "PROVIDER",
    "SAFE_CALLS_PER_WINDOW",
    "WINDOW",
    "LimiterConfig",
    "ProviderLease",
    "ProviderLimiter",
    "RateLimited",
    # is_live is intentionally not a new top-level export: it is a
    # ProviderLimiter method, no schema or contract-version change.
]
