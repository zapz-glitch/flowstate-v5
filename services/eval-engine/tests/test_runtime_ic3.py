"""IC-3 integration contract: image carries migrations, compose wires one-shot migrate."""
from __future__ import annotations

import os

ENGINE_DIR = os.path.join(os.path.dirname(__file__), "..")
REPO_ROOT = os.path.join(ENGINE_DIR, "..", "..")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def test_dockerfile_copies_alembic():
    body = _read(os.path.join(ENGINE_DIR, "Dockerfile"))
    assert "COPY --chown=flowstate:flowstate alembic.ini ./" in body
    assert "COPY --chown=flowstate:flowstate alembic/ ./alembic/" in body


def test_compose_migrate_uses_built_image_and_api_waits():
    body = _read(os.path.join(REPO_ROOT, "compose.dev.yaml"))
    assert "migrate:" in body
    assert 'command: ["alembic", "upgrade", "head"]' in body
    # Migrate reuses the API image so CI/runtime migrate exactly what ships.
    assert body.count("image: flowstate-v4-dev-api:local") >= 3
    assert "service_completed_successfully" in body


def test_compose_worker_supervised_and_candidate_safe():
    body = _read(os.path.join(REPO_ROOT, "compose.dev.yaml"))
    assert "\n  worker:" in body
    assert "eval_engine.worker.main" in body
    assert "migrate:\n        condition: service_completed_successfully" in body
    assert 'V4_EXTERNAL_CALLS_ENABLED: "false"' in body
    assert "COTALITY_CONCURRENCY" in body
    assert "COTALITY_RPM" in body
    assert "backend" in body


def test_dockerfile_supports_worker_command():
    body = _read(os.path.join(ENGINE_DIR, "Dockerfile"))
    assert "PYTHONPATH=/app/src" in body


def test_runtime_test_fallback_has_no_docker_socket_mount():
    body = _read(os.path.join(REPO_ROOT, "scripts", "runtime"))
    assert "/var/run/docker.sock" not in body
    assert "python3 -m venv" in body
    assert "--require-hashes -r" in body
    assert "mktemp -d" in body
