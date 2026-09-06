"""Alembic migration up/down verification on isolated PostgreSQL only."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import uuid
from urllib.parse import urlparse

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import OperationalError

ALEMBIC_INI = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
MAINT_URL = os.environ.get(
    "V4_TEST_DATABASE_URL",
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test",
)
EXPECTED_TABLES = {
    "v4_settings_snapshots",
    "v4_batches",
    "v4_evaluations",
    "v4_evaluation_results",
}


TEST_CONTAINER = "v4-persist-pg-102"
TEST_PORT = 55440


def _guard(url: str) -> None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    port = parsed.port or 5432
    if "neon.tech" in url or "neon" in host:
        raise RuntimeError("migration tests must not run against Neon")
    tail = url.lower().split("@")[-1]
    if "prod" in tail:
        raise RuntimeError("migration tests must not run against production")
    if host not in {"127.0.0.1", "localhost"} or port != TEST_PORT:
        raise RuntimeError(
            "migration tests run only against the isolated container "
            f"127.0.0.1:{TEST_PORT}"
        )


def _ensure_container() -> None:
    if shutil.which("docker") is None:
        raise RuntimeError("docker is required for isolated migration tests")
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(("127.0.0.1", TEST_PORT))
        sock.close()
        return
    except OSError:
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
    subprocess.run(["docker", "rm", "-f", TEST_CONTAINER], capture_output=True)
    proc = subprocess.run(
        [
            "docker", "run", "-d", "--name", TEST_CONTAINER,
            "-e", "POSTGRES_USER=v4test",
            "-e", "POSTGRES_PASSWORD=v4testpw",
            "-e", "POSTGRES_DB=v4test",
            "-p", f"127.0.0.1:{TEST_PORT}:5432",
            "postgres:16-alpine",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not start isolated PG: {proc.stderr[-500:]}")
    engine = create_engine(MAINT_URL, connect_args={"connect_timeout": 2})
    for _ in range(60):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            break
        except OperationalError:
            time.sleep(1)
    engine.dispose()


def _config(url: str) -> Config:
    cfg = Config(ALEMBIC_INI)
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    cfg.set_main_option("url", url)
    return cfg


def test_alembic_up_and_down_on_isolated_database():
    from alembic import command

    _ensure_container()
    _guard(MAINT_URL)
    db_name = f"v4mig_{uuid.uuid4().hex[:12]}"
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    with maint.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = MAINT_URL.rsplit("/", 1)[0] + f"/{db_name}"
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_config(url), "head")
        engine = create_engine(url)
        tables = set(inspect(engine).get_table_names())
        assert EXPECTED_TABLES.issubset(tables)
        insp = inspect(engine)
        eval_fks = {fk["name"] for fk in insp.get_foreign_keys("v4_evaluations")}
        assert "fk_v4_eval_tenant_batch" in eval_fks
        result_fks = {
            fk["name"] for fk in insp.get_foreign_keys("v4_evaluation_results")
        }
        assert "fk_v4_result_tenant_eval" in result_fks
        assert "fk_v4_result_tenant_snapshot" in result_fks
        result_uq = {
            uq["name"] for uq in insp.get_unique_constraints("v4_evaluation_results")
        }
        assert "uq_v4_result_identity" in result_uq
        batch_ck = {
            ck["name"] for ck in insp.get_check_constraints("v4_batches")
        }
        assert "ck_v4_batch_total_range" in batch_ck
        assert "ck_v4_batch_counts_sum" in batch_ck
        assert "ck_v4_batch_status_counts" in batch_ck
        eval_ck = {
            ck["name"] for ck in insp.get_check_constraints("v4_evaluations")
        }
        assert "ck_v4_eval_running_lease" in eval_ck
        assert "ck_v4_eval_terminal_no_lease" in eval_ck
        with engine.begin() as conn:
            trig = conn.execute(
                text(
                    "SELECT count(*) FROM pg_trigger "
                    "WHERE tgname = 'trg_v4_snapshot_no_update'"
                )
            ).scalar()
            assert trig == 1
        engine.dispose()
        command.downgrade(_config(url), "0001_v4_initial")
        _seed_populated_0001(url)
        command.upgrade(_config(url), "head")
        _assert_populated_head(url, expect_backfilled=1)
        command.downgrade(_config(url), "0001_v4_initial")
        _assert_populated_0001(url)
        command.upgrade(_config(url), "head")
        _assert_populated_head(url, expect_backfilled=0)
        command.downgrade(_config(url), "base")
        remaining = set(inspect(create_engine(url)).get_table_names())
        assert EXPECTED_TABLES.isdisjoint(remaining)
        command.upgrade(_config(url), "head")
        again = set(inspect(create_engine(url)).get_table_names())
        assert EXPECTED_TABLES.issubset(again)
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
        with maint.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        maint.dispose()


def _seed_populated_0001(url: str) -> dict:
    engine = create_engine(url, isolation_level="AUTOCOMMIT")
    tenant = "t-mig"
    snap = uuid.uuid4()
    batch_done = uuid.uuid4()
    batch_open = uuid.uuid4()
    eval_done = uuid.uuid4()
    eval_open = uuid.uuid4()
    res_ok = uuid.uuid4()
    res_null_snap = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO v4_settings_snapshots "
                "(id, tenant_id, snapshot_version, content_hash, content, "
                " source, created_at) VALUES (:id, :t, 'v1', :h, "
                " '{\"a\": 1}', '{\"a\": \"sys\"}', now())"
            ),
            {"id": snap, "t": tenant, "h": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_batches (id, tenant_id, idempotency_key, "
                " request_hash, status, total_count, succeeded_count, "
                " failed_count, snapshot_id, created_at, updated_at) "
                "VALUES (:id, :t, 'b-done', 'h1', 'pending', 1, 0, 0, "
                " :snap, now(), now()), (:id2, :t, 'b-open', 'h2', "
                " 'pending', 1, 0, 0, :snap, now(), now())"
            ),
            {"id": batch_done, "id2": batch_open, "t": tenant, "snap": snap},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluations (id, tenant_id, batch_id, "
                " idempotency_key, request_hash, status, attempts, "
                " max_attempts, created_at, updated_at) "
                "VALUES (:e1, :t, :b1, 'e-done', 'h', 'succeeded', 1, 5, "
                " now(), now()), (:e2, :t, :b2, 'e-open', 'h', 'queued', "
                " 0, 5, now(), now())"
            ),
            {"e1": eval_done, "e2": eval_open, "t": tenant,
             "b1": batch_done, "b2": batch_open},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:r1, :t, :e1, 1, 'm', :snap, 'succeeded', "
                " CAST(:p1 AS jsonb), :h1, now())"
            ),
            {"r1": res_ok, "t": tenant, "e1": eval_done, "snap": snap,
             "p1": '{"v": 1}', "h1": f"h-{uuid.uuid4().hex[:8]}"},
        )
        conn.execute(
            text(
                "INSERT INTO v4_evaluation_results (id, tenant_id, "
                " evaluation_id, version, methodology_version, snapshot_id, "
                " status, result_payload, result_hash, created_at) "
                "VALUES (:r2, :t, :e1, 2, 'm', NULL, "
                " 'incomplete', CAST(:p2 AS jsonb), :h2, now())"
            ),
            {"r2": res_null_snap, "t": tenant, "e1": eval_done,
             "p2": '{"v": 2}', "h2": f"h-{uuid.uuid4().hex[:8]}"},
        )
    engine.dispose()
    return {
        "tenant": tenant, "snapshot": snap, "batch_done": batch_done,
        "batch_open": batch_open, "eval_done": eval_done,
        "eval_open": eval_open, "res_ok": res_ok,
        "res_null_snap": res_null_snap,
    }


def _assert_populated_head(url: str, expect_backfilled: int = 1) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        statuses = {
            row[0]: row[1] for row in conn.execute(
                text("SELECT id, status FROM v4_evaluation_results")
            ).fetchall()
        }
        assert set(statuses.values()) == {"VALUED", "INCOMPLETE"}
        nulls = conn.execute(
            text("SELECT count(*) FROM v4_evaluation_results "
                 "WHERE snapshot_id IS NULL")
        ).scalar()
        assert nulls == 0
        backfilled = conn.execute(
            text("SELECT count(*) FROM v4_result_snapshot_backfill")
        ).scalar()
        assert backfilled == expect_backfilled
        eval_status = {
            row[0]: (row[1], row[2]) for row in conn.execute(
                text("SELECT id, status, result_status FROM v4_evaluations")
            ).fetchall()
        }
        done = [row for row in eval_status.values() if row[0] == "succeeded"]
        assert done and all(outcome == "VALUED" for _, outcome in done)
    engine.dispose()


def _assert_populated_0001(url: str) -> None:
    engine = create_engine(url)
    with engine.begin() as conn:
        statuses = {
            row[1] for row in conn.execute(
                text("SELECT id, status FROM v4_evaluation_results")
            ).fetchall()
        }
        assert statuses == {"succeeded", "incomplete"}
    engine.dispose()


def test_alembic_env_rejects_non_postgresql():
    from eval_engine.persistence.db import NonPostgreSQLError, require_postgresql_url

    with pytest.raises((NonPostgreSQLError, RuntimeError)):
        require_postgresql_url("sqlite:///:memory:")
