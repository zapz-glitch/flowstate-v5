"""CDARV command-line interface.

Usage:
    python -m cdarv init-db --db cdarv.db
    python -m cdarv ingest --db cdarv.db --source sqlite --d1 <d1-export.sqlite>
    python -m cdarv ingest --db cdarv.db --source api --api-url https://api.flowstate.homes --api-key fs_...
    python -m cdarv train --db cdarv.db --target arv
    python -m cdarv shadow --db cdarv.db --model latest
    python -m cdarv dataset --db cdarv.db --out examples.jsonl
    python -m cdarv status --db cdarv.db
"""

from __future__ import annotations

import argparse
import json
import sys

from .features import FEATURE_NAMES
from .ingest import HttpReportSource, SqliteReportSource, ingest_reports
from .model import TARGETS, train
from .shadow import run_shadow
from .store import Store


def _store(args: argparse.Namespace) -> Store:
    store = Store(args.db)
    store.init_schema()
    return store


def cmd_init_db(args: argparse.Namespace) -> int:
    _store(args)
    print(f"initialized {args.db}")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    store = _store(args)
    if args.source == "sqlite":
        if not args.d1:
            print("--d1 is required for --source sqlite", file=sys.stderr)
            return 2
        source = SqliteReportSource(args.d1, feedback_status=args.feedback_status)
    else:
        if not args.api_url or not args.api_key:
            print("--api-url and --api-key are required for --source api", file=sys.stderr)
            return 2
        source = HttpReportSource(args.api_url, args.api_key)

    result = ingest_reports(store, source)
    print(
        f"ingest: {result.inserted} inserted, {result.updated} updated, "
        f"{result.unchanged} unchanged, {len(result.skipped)} skipped"
    )
    for msg in result.skipped[:10]:
        print(f"  skipped: {msg}", file=sys.stderr)
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    store = _store(args)
    metrics = train(
        store,
        target=args.target,
        name=args.name,
        artifact_dir=args.artifact_dir,
        val_fraction=args.val_fraction,
        seed=args.seed,
    )
    print(json.dumps(metrics, indent=2))
    return 0


def cmd_shadow(args: argparse.Namespace) -> int:
    store = _store(args)
    outcomes = run_shadow(
        store, model_ref=args.model, report_id=args.report_id, top_k=args.top_k
    )
    for outcome in outcomes:
        p = outcome.prediction
        print(
            f"{outcome.report_id}: shadow_arv={p['shadow_arv']} "
            f"actual_arv={p['actual_arv']} delta={p['arv_delta']} "
            f"overlap={p['overlap_with_actual']}/{p['actual_selected_count']}"
        )
    print(f"shadow predictions written: {len(outcomes)}")
    return 0


def cmd_dataset(args: argparse.Namespace) -> int:
    store = _store(args)
    label_col = {"arv": "label_arv", "as_is": "label_as_is",
                 "selected": "label_selected", "enabled": "label_enabled"}[args.target]
    with store.connect() as conn:
        rows = conn.execute(
            f"""SELECT e.report_id, e.comp_id, e.features_json, e.{label_col} AS y
                FROM comp_examples e ORDER BY e.report_id, e.rank_in_report"""
        ).fetchall()
    lines = [
        json.dumps({
            "report_id": r["report_id"],
            "comp_id": r["comp_id"],
            "y": r["y"],
            "features": json.loads(r["features_json"]),
        })
        for r in rows
    ]
    out = "\n".join(lines) + ("\n" if lines else "")
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(out)
        print(f"wrote {len(lines)} examples to {args.out}")
    else:
        sys.stdout.write(out)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    store = _store(args)
    with store.connect() as conn:
        reports = conn.execute("SELECT COUNT(*) c FROM ideal_reports").fetchone()["c"]
        examples = conn.execute("SELECT COUNT(*) c FROM comp_examples").fetchone()["c"]
        shadows = conn.execute("SELECT COUNT(*) c FROM shadow_predictions").fetchone()["c"]
        versions = store.list_model_versions(conn)
    print(f"ideal reports: {reports}")
    print(f"comp examples: {examples}")
    print(f"shadow predictions: {shadows}")
    print("model versions:")
    for v in versions:
        metrics = json.loads(v["metrics_json"])
        ranking = metrics.get("val_ranking") or {}
        print(
            f"  #{v['id']} {v['name']} target={v['target']} "
            f"precision@k={ranking.get('mean_precision_at_k')} "
            f"created={v['created_at']}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cdarv", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init-db")
    p.add_argument("--db", required=True)
    p.set_defaults(fn=cmd_init_db)

    p = sub.add_parser("ingest")
    p.add_argument("--db", required=True)
    p.add_argument("--source", choices=["sqlite", "api"], required=True)
    p.add_argument("--d1", help="path to a D1 SQLite file/export")
    p.add_argument("--api-url", help="prod API base, e.g. https://api.flowstate.homes")
    p.add_argument("--api-key", help="fs_ API key")
    p.add_argument("--feedback-status", default="validated")
    p.set_defaults(fn=cmd_ingest)

    p = sub.add_parser("train")
    p.add_argument("--db", required=True)
    p.add_argument("--target", choices=TARGETS, default="arv")
    p.add_argument("--name", default="baseline")
    p.add_argument("--artifact-dir", default="artifacts")
    p.add_argument("--val-fraction", type=float, default=0.2)
    p.add_argument("--seed", type=int, default=42)
    p.set_defaults(fn=cmd_train)

    p = sub.add_parser("shadow")
    p.add_argument("--db", required=True)
    p.add_argument("--model", default="latest")
    p.add_argument("--report-id")
    p.add_argument("--top-k", type=int, default=3)
    p.set_defaults(fn=cmd_shadow)

    p = sub.add_parser("dataset")
    p.add_argument("--db", required=True)
    p.add_argument("--target", choices=TARGETS, default="arv")
    p.add_argument("--out")
    p.set_defaults(fn=cmd_dataset)

    p = sub.add_parser("status")
    p.add_argument("--db", required=True)
    p.set_defaults(fn=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


__all__ = ["build_parser", "main"]
