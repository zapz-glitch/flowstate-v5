"""Supervised V4 worker entrypoint: consume the owner-scoped queue fairly.

Usage (container or host):
    python -m eval_engine.worker.main [--once] [--max-jobs N]

Environment: DATABASE_URL (PostgreSQL only), V4_WORKER_TENANT,
V4_WORKER_OWNER, V4_WORKER_USER (durable requesting-user scope,
required in production; test/local profiles may use the explicit
V4_WORKER_ALLOW_DEFAULT_USER=true escape hatch),
V4_EXTERNAL_CALLS_ENABLED (default false), COTALITY_CONCURRENCY
(default 4), COTALITY_RPM (default 40).

Graceful shutdown on SIGINT/SIGTERM: stops new claims, lets the
in-flight heartbeat and claim finish, then exits without client
coupling. Fatal startup/run failures exit nonzero.
"""

from __future__ import annotations

import argparse
import logging
import signal

from .runner import ClaimRetryExhausted, WorkerConfigError
from .service import build_session_factory, build_worker

log = logging.getLogger("v4.worker")


def main() -> int:
    parser = argparse.ArgumentParser(description="V4 supervised worker")
    parser.add_argument("--once", action="store_true", help="process one job then exit")
    parser.add_argument("--max-jobs", type=int, default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        worker = build_worker()
    except (ValueError, WorkerConfigError) as exc:
        log.error("worker configuration invalid: %s", exc)
        return 2
    if args.once:
        worker._config.max_jobs = 1
    elif args.max_jobs is not None:
        worker._config.max_jobs = max(1, int(args.max_jobs))

    def _stop(signum, _frame):
        log.info("worker received signal %s; stopping gracefully", signum)
        worker.request_stop()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    log.info(
        "worker starting tenant=%s owner=%s external=%s",
        worker._config.tenant_id,
        worker._config.lease_owner,
        worker._config.external_calls_enabled,
    )
    try:
        stats = worker.run()
    except ClaimRetryExhausted:
        log.exception("worker claim retry budget exhausted")
        return 1
    except Exception:
        log.exception("worker failed")
        return 1
    log.info(
        "worker stopped claimed=%d succeeded=%d deferred=%d retried=%d failed=%d dead=%d recovered=%d",
        stats.claimed,
        stats.succeeded,
        stats.deferred,
        stats.retried,
        stats.failed,
        stats.dead,
        stats.recovered,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
