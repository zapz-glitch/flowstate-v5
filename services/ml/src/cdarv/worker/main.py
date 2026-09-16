"""CDARV worker entrypoint: python -m cdarv.worker.main [--once] [--max-jobs N]

Environment: CDARV_DATABASE_URL (PostgreSQL in deploy; sqlite allowed only
under CDARV_TEST_PROFILE), CDARV_WORKER_*, CDARV_TS_API_URL and
CDARV_TS_INTERNAL_SECRET for the shadow recalc callback.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys

from .runner import build_worker

log = logging.getLogger("cdarv.worker")


def main() -> int:
    parser = argparse.ArgumentParser(description="CDARV background worker")
    parser.add_argument("--once", action="store_true", help="process at most one job then exit")
    parser.add_argument("--max-jobs", type=int, default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    try:
        worker = build_worker()
    except Exception as exc:
        log.error("worker configuration invalid: %s", exc)
        return 2
    if args.once:
        worker.config.max_jobs = 1
    elif args.max_jobs is not None:
        worker.config.max_jobs = max(1, args.max_jobs)

    def _stop(signum, _frame):
        log.info("received signal %s; stopping after current job", signum)
        worker.request_stop()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    log.info("worker starting owner=%s", worker.config.owner)
    stats = worker.run()
    log.info("worker stopped: %s", stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())
