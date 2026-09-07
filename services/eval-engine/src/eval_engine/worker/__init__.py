"""Supervised worker package: fair queue consumption plus shared limiter."""

from .limiter import (
    LEASE_TTL,
    MAX_ACTIVE_LEASES,
    PROVIDER,
    SAFE_CALLS_PER_WINDOW,
    WINDOW,
    LimiterConfig,
    ProviderLease,
    ProviderLimiter,
    RateLimited,
)
from .runner import (
    JITTER_FRACTION,
    ClaimRetryExhausted,
    RunOutcome,
    Worker,
    WorkerConfig,
    WorkerConfigError,
    WorkerStats,
    classify_failure,
    claim_next_fair,
    compute_backoff,
    run_worker,
)
from .service import build_limiter, build_session_factory, build_worker, build_worker_config

__all__ = [
    "JITTER_FRACTION",
    "ClaimRetryExhausted",
    "RunOutcome",
    "WorkerConfigError",
    "LEASE_TTL",
    "MAX_ACTIVE_LEASES",
    "PROVIDER",
    "SAFE_CALLS_PER_WINDOW",
    "WINDOW",
    "LimiterConfig",
    "ProviderLease",
    "ProviderLimiter",
    "RateLimited",
    "Worker",
    "WorkerConfig",
    "WorkerStats",
    "build_limiter",
    "build_session_factory",
    "build_worker",
    "build_worker_config",
    "classify_failure",
    "claim_next_fair",
    "compute_backoff",
    "run_worker",
]
