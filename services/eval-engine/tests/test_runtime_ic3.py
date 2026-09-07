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
    # Sol finding: the worker consumes one durable owner scope
    # (tenant + requesting user); compose must set an explicit local
    # user so there is no cross-owner ambiguity in dev.
    assert "V4_WORKER_USER" in body
    assert "V4_WORKER_TENANT" in body
    assert "V4_WORKER_OWNER" in body


def test_runtime_health_requires_worker_running():
    body = _read(os.path.join(REPO_ROOT, "scripts", "runtime"))
    assert "absent/stopped" in body
    assert "expected running" in body


def test_ci_worker_smoke_is_genuine_not_max_jobs_zero():
    import re

    wf = _read(
        os.path.join(
            REPO_ROOT, ".github", "workflows", "evaluation-v4-candidate.yml"
        )
    )
    assert "--max-jobs 0" not in wf.replace(
        "--max-jobs 0 would", "--max-jobs-zero-would"
    ).replace("--max-jobs 0/negative", "--max-jobs-zero-negative")
    assert "V4_WORKER_USER" in wf
    # Genuine smoke: submit a known stub batch, run the worker, verify
    # a persisted terminal result, fail reliably on error. Both
    # `python - <<'PY'` heredoc invocations MUST carry `docker run -i`
    # (stdin): without -i the script is silently dropped and the step
    # passes vacuously.
    assert re.search(r"submit_batch|_body\(|evaluations", wf)
    assert "succeeded" in wf
    assert wf.count("docker run --rm -i --network host") >= 2
    assert "python - <<'PY'" in wf
    # Failure must not be masked by `logs | head` pipelines.
    assert "logs v4-ci-worker 2>&1 | head" not in wf
    assert "set -o pipefail" in wf or "set -eu" in wf


def test_dockerfile_supports_worker_command():
    body = _read(os.path.join(ENGINE_DIR, "Dockerfile"))
    assert "PYTHONPATH=/app/src" in body


def test_runtime_test_fallback_has_no_docker_socket_mount():
    body = _read(os.path.join(REPO_ROOT, "scripts", "runtime"))
    assert "/var/run/docker.sock" not in body
    assert "python3 -m venv" in body
    assert "--require-hashes -r" in body
    assert "mktemp -d" in body
