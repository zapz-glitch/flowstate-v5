"""CDARV background worker: claim → execute → heartbeat → finish.

Runs as a separate process (`python -m cdarv.worker.main`) so training
and shadow scoring can never starve the API. Handlers are intentionally
CPU-small: the baseline model trains in seconds on ~100-report datasets.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass

from ..persistence.db import create_db_engine, create_session_factory, session_scope
from ..persistence.models import Model, ShadowState, Snapshot
from ..persistence import repositories as repo
from ..domain.shadow import score_snapshot
from ..domain.training import train_model
from sqlalchemy import select

log = logging.getLogger("cdarv.worker")


@dataclass
class WorkerConfig:
    owner: str = "cdarv-worker"
    lease_seconds: int = 300
    heartbeat_seconds: int = 30
    poll_seconds: float = 2.0
    max_jobs: int | None = None


class Worker:
    def __init__(self, config: WorkerConfig):
        self.config = config
        self.engine = create_db_engine()
        self.session_factory = create_session_factory(self.engine)
        self._stop = threading.Event()

    def request_stop(self) -> None:
        self._stop.set()

    def _handle(self, session, job) -> dict:
        if job.type == "train_model":
            model = train_model(
                session,
                dataset_id=job.payload_json["dataset_id"],
                name=job.payload_json.get("name", "baseline"),
            )
            return {"model_id": model.id, "version": model.version}

        if job.type == "shadow_score":
            state = session.execute(select(ShadowState)).scalar_one_or_none()
            if not state or not state.active_model_id:
                return {"skipped": "no active shadow model"}
            model = session.get(Model, state.active_model_id)
            if model is None:
                raise RuntimeError("active shadow model row missing")
            snapshot = session.get(Snapshot, job.payload_json["snapshot_id"])
            if snapshot is None:
                raise RuntimeError("snapshot not found")
            pred = score_snapshot(session, snapshot=snapshot, model_row=model, job=job)
            return {"prediction_id": pred.id, "status": pred.status}

        raise RuntimeError(f"unknown job type {job.type}")

    def process_one(self) -> bool:
        """Claim and execute at most one job. Returns True if work was done."""
        with session_scope(self.session_factory) as session:
            repo.recover_expired(session)
            job = repo.claim_next(session, owner=self.config.owner,
                                  lease_seconds=self.config.lease_seconds)
            if job is None:
                return False
            try:
                result = self._handle(session, job)
                repo.complete(session, job, result)
                log.info("job %s (%s) succeeded", job.id, job.type)
            except Exception as exc:
                log.exception("job %s (%s) failed", job.id, job.type)
                repo.fail(session, job, code="HANDLER_ERROR", detail=str(exc))
            return True

    def run(self) -> dict:
        processed = 0
        while not self._stop.is_set():
            if not self.process_one():
                time.sleep(self.config.poll_seconds)
                continue
            processed += 1
            if self.config.max_jobs is not None and processed >= self.config.max_jobs:
                break
        return {"processed": processed}


def build_worker() -> Worker:
    return Worker(
        WorkerConfig(
            owner=os.environ.get("CDARV_WORKER_OWNER", "cdarv-worker"),
            lease_seconds=int(os.environ.get("CDARV_WORKER_LEASE_SECONDS", "300")),
            heartbeat_seconds=int(os.environ.get("CDARV_WORKER_HEARTBEAT_SECONDS", "30")),
            poll_seconds=float(os.environ.get("CDARV_WORKER_POLL_SECONDS", "2")),
        )
    )


__all__ = ["Worker", "WorkerConfig", "build_worker"]
