"""V4 engine baseline smoke tests."""
import os

import pytest
from fastapi.testclient import TestClient

os.environ["V4_TEST_PROFILE"] = "true"

from eval_engine.main import app, validate_startup_configuration
from eval_engine.health import check_database

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_evaluate_not_implemented_until_contract_lands():
    response = client.post(
        "/evaluate",
        json={"subject": {"address": "123 Main St"}, "comps": []},
    )
    assert response.status_code == 501


def test_database_health_requires_postgresql():
    check = check_database("sqlite:///:memory:")
    assert not check.ok
    assert check.detail == "V4 requires PostgreSQL"


def test_startup_requires_internal_token_outside_test_profile(monkeypatch):
    monkeypatch.setenv("V4_TEST_PROFILE", "false")
    monkeypatch.delenv("V4_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="V4_INTERNAL_API_TOKEN"):
        validate_startup_configuration()


def test_startup_accepts_internal_token(monkeypatch):
    monkeypatch.setenv("V4_TEST_PROFILE", "false")
    monkeypatch.setenv("V4_INTERNAL_API_TOKEN", "test-only-token")
    validate_startup_configuration()


def test_readiness_contract_constants():
    from eval_engine.health import EXPECTED_ALEMBIC_REVISION, REQUIRED_TABLES

    assert EXPECTED_ALEMBIC_REVISION == "0003_v4_owner"
    assert REQUIRED_TABLES == frozenset(
        {
            "v4_settings_snapshots",
            "v4_batches",
            "v4_evaluations",
            "v4_evaluation_results",
            "v4_result_snapshot_backfill",
        }
    )


@pytest.mark.parametrize(
    "missing_table",
    sorted(
        [
            "v4_settings_snapshots",
            "v4_batches",
            "v4_evaluations",
            "v4_evaluation_results",
            "v4_result_snapshot_backfill",
        ]
    ),
)
def test_readiness_fails_when_any_required_table_missing(
    monkeypatch, missing_table
):
    """IR-1: removing any one of the five head tables is not-ready."""
    from eval_engine import health as health_module

    expected = health_module.EXPECTED_ALEMBIC_REVISION
    present = set(health_module.REQUIRED_TABLES) - {missing_table}
    assert missing_table in health_module.REQUIRED_TABLES

    class _FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, *args, **kwargs):
            class _Scalar:
                def scalar(self):
                    return expected

            return _Scalar()

    class _FakeEngine:
        def connect(self):
            return _FakeConnection()

        def dispose(self):
            return None

    monkeypatch.setattr(
        health_module, "create_engine", lambda *args, **kwargs: _FakeEngine()
    )
    monkeypatch.setattr(
        health_module,
        "inspect",
        lambda connection: type(
            "_Insp", (), {"get_table_names": lambda self: list(present)}
        )(),
    )
    # Database probe is out of scope here: force it ok so the schema
    # gate is the decided factor.
    monkeypatch.setattr(
        health_module,
        "check_database",
        lambda url=None: health_module.DatabaseCheck(True, "postgresql", "ok"),
    )

    schema = health_module.check_schema("postgresql+psycopg://fake/db")
    assert not schema.ok
    assert missing_table in schema.detail

    ready, checks = health_module.check_readiness("postgresql+psycopg://fake/db")
    assert not ready
    assert checks["database"] == "ok"
    assert missing_table in checks["schema"]


def test_readiness_unmigrated_database_is_not_ready(monkeypatch):
    """Negative readiness path: empty PG (no alembic_version) is 503."""
    from eval_engine import health as health_module

    monkeypatch.setenv("V4_TEST_PROFILE", "true")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    import shutil
    import socket
    import subprocess
    import time
    import uuid

    from sqlalchemy import create_engine, text

    container = "v4-health-pg-ic3"
    port = 55441
    maint_url = f"postgresql+psycopg://v4test:v4testpw@127.0.0.1:{port}/v4test"
    if shutil.which("docker") is None:
        pytest.skip("docker is required for the unmigrated readiness test")
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(("127.0.0.1", port))
        reachable = True
    except OSError:
        reachable = False
    finally:
        sock.close()
    if not reachable:
        subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        proc = subprocess.run(
            [
                "docker", "run", "-d", "--name", container,
                "-e", "POSTGRES_USER=v4test",
                "-e", "POSTGRES_PASSWORD=v4testpw",
                "-e", "POSTGRES_DB=v4test",
                "-p", f"127.0.0.1:{port}:5432",
                "postgres:16-alpine",
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            pytest.skip("could not start isolated PG for readiness test")
        maint = create_engine(maint_url, connect_args={"connect_timeout": 2})
        for _ in range(60):
            try:
                with maint.connect() as conn:
                    conn.execute(text("SELECT 1"))
                break
            except Exception:
                time.sleep(1)
        maint.dispose()
    maint = create_engine(maint_url, isolation_level="AUTOCOMMIT")
    db_name = f"v4health_{uuid.uuid4().hex[:12]}"
    try:
        with maint.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{db_name}"'))
        url = maint_url.rsplit("/", 1)[0] + f"/{db_name}"
        monkeypatch.setenv("DATABASE_URL", url)
        schema = health_module.check_schema()
        assert not schema.ok
        assert "not migrated" in schema.detail
        ready, checks = health_module.check_readiness()
        assert not ready
        assert checks["database"] == "ok"
        assert "not migrated" in checks["schema"]
        response = client.get("/health/ready")
        assert response.status_code == 503
        body = response.json()
        assert body["ready"] is False
        assert body["status"] == "not_ready"
    finally:
        with maint.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        maint.dispose()
