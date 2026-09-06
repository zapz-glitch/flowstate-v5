"""Shared PostgreSQL-backed Cotality provider limiter.

Coordinates max 4 active leases and a sliding safe 40 calls per 60
seconds (no bursts) across worker processes. Every limiter decision runs
in one transaction under a PostgreSQL advisory lock so concurrent
processes and threads serialize: reclaim expired leases, evict calls
outside the window, then check concurrency, then the sliding count.
Each attempt (including retries) inserts exactly one call row; a lease
expiry is recovered by reclaim-on-check, and a provider 429 persists
``next_attempt`` via the worker (Retry-After honored, bounded jitter
applied by the worker backoff).

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
    now: Callable[[], datetime] = _utcnow


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
        """Acquire one provider slot, or return None when limited.

        Returns None (no raise) when concurrency or the sliding window
        is exhausted so the worker can persist ``next_attempt`` and retry
        later without spinning. Counts this attempt in the window.
        """
        cfg = self._config
        current = now if now is not None else (cfg.now() if callable(cfg.now) else cfg.now)
        with self._factory() as session:
            try:
                self._lock(session)
                self._reclaim(session, current)
                active = session.execute(
                    select(func.count())
                    .select_from(CotalityLease)
                    .where(CotalityLease.provider == cfg.provider)
                ).scalar() or 0
                if int(active) >= cfg.max_active:
                    session.rollback()
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
                    session.rollback()
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

    def release(self, lease: ProviderLease) -> None:
        with self._factory() as session:
            try:
                session.execute(
                    delete(CotalityLease).where(
                        CotalityLease.provider == lease.provider,
                        CotalityLease.lease_token == lease.lease_token,
                    )
                )
                session.commit()
            except Exception:
                session.rollback()

    def note_rate_limited(
        self, lease: ProviderLease, *, retry_after: timedelta | None = None
    ) -> None:
        """Release the lease after a provider 429; window row stays."""
        _ = retry_after
        self.release(lease)

    def _now(self) -> datetime:
        candidate = self._config.now
        return candidate() if callable(candidate) else candidate

    def active_count(self) -> int:
        with self._factory() as session:
            try:
                self._lock(session)
                self._reclaim(session, self._now())
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
        current = now if now is not None else self._now()
        with self._factory() as session:
            try:
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
]
