"""CDARV operator CLI — direct-to-DB administrative commands.

Usage:
    python -m cdarv init-db
    python -m cdarv submit --d1 <d1-export.sqlite> [--status validated]
    python -m cdarv queue [--status needs_review]
    python -m cdarv build-dataset --name baseline --by <reviewer>
    python -m cdarv train --dataset <dataset_id> [--name baseline]
    python -m cdarv worker [--once]
    python -m cdarv shadow activate --model <model_id> --by <user>
    python -m cdarv shadow deactivate
    python -m cdarv shadow score --snapshot <snapshot_id>
    python -m cdarv status

Database: --db <url> or CDARV_DATABASE_URL / DATABASE_URL. SQLite is a
test-profile convenience only (set CDARV_TEST_PROFILE=true).
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

from .domain import datasets as ds
from .domain import monitoring, registry, submissions as sub
from .persistence.db import (
    create_db_engine, create_schema, create_session_factory, session_scope,
)
from .persistence import repositories as repo


def _factory(args: argparse.Namespace):
    url = args.db or os.environ.get("CDARV_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        print("--db or CDARV_DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    if url.startswith("sqlite") and os.environ.get("CDARV_TEST_PROFILE") != "true":
        print("sqlite URLs require CDARV_TEST_PROFILE=true", file=sys.stderr)
        raise SystemExit(2)
    return create_session_factory(create_db_engine(url))


def cmd_init_db(args) -> int:
    engine = create_db_engine(
        args.db or os.environ.get("CDARV_DATABASE_URL") or os.environ.get("DATABASE_URL")
    )
    create_schema(engine)
    print("schema created (test/dev convenience — production uses Alembic)")
    return 0


def cmd_submit(args) -> int:
    """Bulk-submit reports from a D1 SQLite export of saved_reports."""
    factory = _factory(args)
    conn = sqlite3.connect(args.d1)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT id, user_id, job_id, property_address, full_response_json,
                  feedback_status, created_at
           FROM saved_reports ORDER BY created_at"""
    ).fetchall()
    conn.close()

    created = dup = new_ver = skipped = 0
    with session_scope(factory) as session:
        for row in rows:
            if args.status and row["feedback_status"] != args.status:
                skipped += 1
                continue
            if not row["full_response_json"]:
                skipped += 1
                continue
            try:
                _, outcome = sub.submit_report(
                    session,
                    report_id=row["id"], user_id=row["user_id"],
                    created_at=row["created_at"],
                    report_json=row["full_response_json"],
                    job_id=row["job_id"], address=row["property_address"],
                    submitted_by=args.by,
                )
            except Exception as exc:
                print(f"  skipped {row['id']}: {exc}", file=sys.stderr)
                skipped += 1
                continue
            created += outcome == "created"
            new_ver += outcome == "new_version"
            dup += outcome == "duplicate"
    print(f"submitted: {created} created, {new_ver} new versions, "
          f"{dup} duplicates, {skipped} skipped")
    return 0


def cmd_queue(args) -> int:
    with session_scope(_factory(args)) as session:
        snaps = sub.list_queue(session, args.status)
        for s in snaps:
            print(f"{s.id} v{s.version} {s.status:20} {s.completeness:10} "
                  f"report={s.report_id} hash={s.content_hash[:12]}")
        print(f"{len(snaps)} snapshots")
    return 0


def cmd_build_dataset(args) -> int:
    with session_scope(_factory(args)) as session:
        dataset = ds.build_dataset(
            session, name=args.name, created_by=args.by, scope=args.scope,
            test_fraction=args.test_fraction, val_fraction=args.val_fraction,
            seed=args.seed,
        )
        print(json.dumps({
            "dataset_id": dataset.id, "name": dataset.name,
            "version": dataset.version,
            "splits": dataset.split_summary_json,
            "feature_spec": dataset.feature_spec_version,
            "code_version": dataset.code_version,
        }, indent=2))
    return 0


def cmd_train(args) -> int:
    with session_scope(_factory(args)) as session:
        job = repo.enqueue(session, "train_model",
                         {"dataset_id": args.dataset, "name": args.name})
        print(f"enqueued train job {job.id} — run `python -m cdarv worker`")
    return 0


def cmd_worker(args) -> int:
    from .worker.runner import Worker, WorkerConfig
    worker = Worker(WorkerConfig(max_jobs=1 if args.once else None))
    stats = worker.run()
    print(json.dumps(stats))
    return 0


def cmd_shadow(args) -> int:
    with session_scope(_factory(args)) as session:
        if args.shadow_cmd == "activate":
            out = registry.activate_shadow(
                session, model_id=args.model, activated_by=args.by)
        elif args.shadow_cmd == "deactivate":
            out = registry.deactivate_shadow(session)
        elif args.shadow_cmd == "score":
            job = repo.enqueue(session, "shadow_score",
                             {"snapshot_id": args.snapshot})
            out = {"job_id": job.id}
        else:
            out = registry.shadow_state(session)
        print(json.dumps(out, indent=2, default=str))
    return 0


def cmd_status(args) -> int:
    with session_scope(_factory(args)) as session:
        print(json.dumps(monitoring.summary(session), indent=2, default=str))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cdarv", description=__doc__)
    parser.add_argument("--db", help="database URL (or CDARV_DATABASE_URL)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db").set_defaults(fn=cmd_init_db)

    p = sub.add_parser("submit")
    p.add_argument("--d1", required=True, help="path to a D1 SQLite export")
    p.add_argument("--status", default="validated")
    p.add_argument("--by", default="cli")
    p.set_defaults(fn=cmd_submit)

    p = sub.add_parser("queue")
    p.add_argument("--status")
    p.set_defaults(fn=cmd_queue)

    p = sub.add_parser("build-dataset")
    p.add_argument("--name", required=True)
    p.add_argument("--by", required=True)
    p.add_argument("--scope", default="comp_ranking",
                   choices=["comp_ranking", "valuation_benchmark"])
    p.add_argument("--test-fraction", type=float, default=0.2)
    p.add_argument("--val-fraction", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.set_defaults(fn=cmd_build_dataset)

    p = sub.add_parser("train")
    p.add_argument("--dataset", required=True)
    p.add_argument("--name", default="baseline")
    p.set_defaults(fn=cmd_train)

    p = sub.add_parser("worker")
    p.add_argument("--once", action="store_true")
    p.set_defaults(fn=cmd_worker)

    p = sub.add_parser("shadow")
    sp = p.add_subparsers(dest="shadow_cmd", required=True)
    pa = sp.add_parser("activate")
    pa.add_argument("--model", required=True)
    pa.add_argument("--by", required=True)
    sp.add_parser("deactivate")
    psc = sp.add_parser("score")
    psc.add_argument("--snapshot", required=True)
    sp.add_parser("state")
    p.set_defaults(fn=cmd_shadow)

    sub.add_parser("status").set_defaults(fn=cmd_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["build_parser", "main"]
