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
        tables = set(inspect(create_engine(url)).get_table_names())
        assert EXPECTED_TABLES.issubset(tables)
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


def test_alembic_env_rejects_non_postgresql():
    from eval_engine.persistence.db import NonPostgreSQLError, require_postgresql_url

    with pytest.raises((NonPostgreSQLError, RuntimeError)):
        require_postgresql_url("sqlite:///:memory:")
