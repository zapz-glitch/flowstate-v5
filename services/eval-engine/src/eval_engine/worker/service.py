"""Application glue for the supervised worker process (V4-103B).

Builds session factories, worker configs, and the shared provider
limiter from environment only. No client coupling: the worker never
serves HTTP and never imports API route state.
"""

from __future__ import annotations

import os
from datetime import timedelta
from typing import Callable

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from ..api.providers import EvidenceProvider
from ..persistence.db import require_postgresql_url
from .limiter import LimiterConfig, ProviderLimiter
from .runner import Worker, WorkerConfig


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default)).strip()))
    except (ValueError, AttributeError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name, str(default)).strip()))
    except (ValueError, AttributeError):
        return default


def build_session_factory(url: str | None = None) -> Callable[[], Session]:
    target = require_postgresql_url(url if url is not None else os.environ.get("DATABASE_URL"))
    engine = create_engine(target, pool_pre_ping=True)
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    return maker


def build_worker_config(
    *,
    tenant_id: str | None = None,
    lease_owner: str | None = None,
    provider: EvidenceProvider | None = None,
    limiter: ProviderLimiter | None = None,
) -> WorkerConfig:
    tenant = (tenant_id or os.environ.get("V4_WORKER_TENANT", "") or "").strip() or "default"
    owner = (
        (lease_owner or os.environ.get("V4_WORKER_OWNER", "") or "").strip()
        or f"worker:{tenant}"
    )
    external = os.environ.get("V4_EXTERNAL_CALLS_ENABLED", "false").lower() == "true"
    return WorkerConfig(
        tenant_id=tenant,
        lease_owner=owner,
        lease_ttl=timedelta(seconds=_env_float("V4_WORKER_LEASE_SECONDS", 300)),
        heartbeat_interval=timedelta(
            seconds=_env_float("V4_WORKER_HEARTBEAT_SECONDS", 30)
        ),
        poll_interval=timedelta(seconds=_env_float("V4_WORKER_POLL_SECONDS", 1)),
        external_calls_enabled=external,
        provider=provider,
        limiter=limiter,
    )


def build_limiter(
    session_factory: Callable[[], Session],
) -> ProviderLimiter:
    return ProviderLimiter(
        session_factory,
        LimiterConfig(
            max_active=_env_int("COTALITY_CONCURRENCY", 4),
            max_calls=_env_int("COTALITY_RPM", 40),
        ),
    )


def build_worker(
    session_factory: Callable[[], Session] | None = None,
    *,
    tenant_id: str | None = None,
    lease_owner: str | None = None,
    provider: EvidenceProvider | None = None,
) -> Worker:
    factory = session_factory or build_session_factory()
    limiter = build_limiter(factory)
    config = build_worker_config(
        tenant_id=tenant_id, lease_owner=lease_owner, provider=provider, limiter=limiter
    )
    return Worker(factory, config)


__all__ = ["build_limiter", "build_session_factory", "build_worker", "build_worker_config"]
