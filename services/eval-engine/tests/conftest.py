"""Shared cold-start harness for V4 DB-backed tests (Sol finding 7).

Cold checkout failed unless the isolated PostgreSQL container was
already running. The session-scoped ``isolated_pg`` fixture starts it
on demand. Safety rules:

- Refuses Neon / production-looking / non-loopback maintenance URLs.
- Verifies identity before reuse: a listener on the port is trusted
  only when it answers ``SELECT 1`` AND the maintenance database
  exists AND ``SELECT version()`` identifies PostgreSQL. A foreign
  listener causes a hard failure, never silent reuse.
- Teardown removes ONLY a container this harness created (tracked by
  container ID captured from the successful ``docker run`` output plus
  the ``_CREATED_BY_HARNESS`` name record; identity is re-verified by
  ID-pinned ``docker inspect`` before any removal). The ownership
  record is written immediately after ``docker run`` succeeds, BEFORE
  any post-run readiness check, so a transient inspect/readiness
  failure can still clean up exactly the just-created container.
  Pre-existing containers are never removed.
- Startup failure removes only the exact container this run created
  (ID-pinned, label re-verified); a foreign or pre-existing same-name
  entry is never touched. Cleanup errors are printed to stderr and
  raised, never hidden.
- Coexists with the migration-health harnesses: those manage their own
  ``v4-health-pg-ic3`` container on port 55441 and are untouched.
- The fixture is non-autouse: DB-free suites never trigger Docker.

Guaranteed post-session teardown runs even when tests fail or the
``docker run`` partially succeeded: only harness-created containers
are removed, then absence is best-effort verified.

Semantics note: ``--max-jobs N`` (and ``WorkerConfig.max_jobs``) means
process at most N *claimed evaluations successfully processed* per run
(``processed`` increments only after ``_process_claim`` returns). A
bounded run never exits on one empty poll: it re-polls while the
owner scope provably still holds non-terminal rows, and breaks
promptly once the queue is drained. ``--max-jobs 0`` is therefore
misleading (it claims nothing and exits 0 without doing work) and
must not be used as a health/smoke signal in CI.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

DEFAULT_MAINT_URL = (
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test"
)
TEST_CONTAINER = "v4-persist-pg-102"
TEST_IMAGE = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
# Ownership label applied at `docker run` so teardown can prove a
# same-name container is really harness-owned before removing it.
HARNESS_LABEL = "flowstate.v4.harness"
HARNESS_VALUE = "isolated-pg"

# Ownership record for the container created by the CURRENT process run:
# the name (for session teardown) plus the exact container ID captured
# from `docker run` stdout (for ID-pinned startup-failure cleanup).
# The record is written immediately after `docker run` reports success,
# BEFORE any post-run inspect/readiness check, so a transient failure
# in those checks can still remove exactly the just-created container.
_CREATED_BY_HARNESS: str | None = None
_CREATED_CONTAINER_ID: str | None = None


def _maintenance_url() -> str:
    return os.environ.get("V4_TEST_DATABASE_URL", DEFAULT_MAINT_URL)


def _guard_maintenance_url(url: str) -> None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "neon.tech" in url or "neon" in host:
        raise RuntimeError("refusing test URL pointing at Neon")
    tail = url.lower().split("@")[-1]
    if "prod" in tail:
        raise RuntimeError("refusing test URL that looks like production")
    if host not in {"127.0.0.1", "localhost"} or (parsed.port or 5432) != 55440:
        raise RuntimeError(
            "tests run only against the isolated container 127.0.0.1:55440"
        )


def _port_open(port: int) -> bool:
    sock = socket.socket()
    sock.settimeout(1)
    try:
        sock.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _docker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False
    )


def _container_exists(name: str) -> bool:
    proc = _docker("inspect", "--format", "{{.Name}}", name)
    return proc.returncode == 0 and name in (proc.stdout or "")


def _inspect_container_id(name: str) -> str | None:
    """Return the full container ID for `name`, or None when missing."""
    proc = _docker("inspect", "--format", "{{.Id}}", name)
    if proc.returncode != 0:
        return None
    value = (proc.stdout or "").strip()
    return value or None


def _container_id_match(name: str, container_id: str) -> bool:
    """True when `name` currently resolves to exactly `container_id`."""
    if not container_id:
        return False
    actual = _inspect_container_id(name)
    if actual is None:
        return False
    # Docker accepts ID prefixes; require full-ID equality or an
    # unambiguous prefix relationship in either direction.
    return actual == container_id or actual.startswith(container_id) or container_id.startswith(actual)


def _container_label(name: str, key: str) -> str | None:
    proc = _docker(
        "inspect", "--format", f"{{{{index .Config.Labels \"{key}\"}}}}", name
    )
    if proc.returncode != 0:
        return None
    value = (proc.stdout or "").strip()
    if value in {"", "<no value>"}:
        return None
    return value


def _is_harness_owned(name: str) -> bool:
    """True only when the container carries this harness's label."""
    return _container_label(name, HARNESS_LABEL) == HARNESS_VALUE


def _remove_container_best_effort(name: str) -> None:
    _docker("rm", "-f", name)


def _remove_if_harness_owned(name: str) -> bool:
    """Legacy name-based removal: DISABLED, kept only for the refusal test.

    Any call is a programming error (blind name removal could destroy a
    pre-existing/unowned entry). Kept as a hard failure rather than
    deleted so accidental reuse is caught loudly.
    """
    raise AssertionError(
        "legacy name-based removal is disabled: use ID-pinned "
        "_remove_created_container instead"
    )


def _remove_created_container(
    name: str, container_id: str | None, *, _raise: bool = True
) -> None:
    """Remove exactly the container this run created (ID-pinned).

    The target must carry this harness's ownership label AND either
    resolve by name to the recorded container ID or (transient daemon
    lag window) have no visible registration at all — in the latter
    case removal goes by the recorded ID, which Docker resolves
    authoritatively and which can never address a different container.
    A name resolving to a DIFFERENT container ID, or a missing
    ownership label, is left untouched and raises loudly. Cleanup
    problems are printed to stderr and raised (never hidden), except
    an already-absent ID which is a successful no-op.
    """
    import sys

    if not container_id:
        msg = (
            f"no recorded container ID for {name}; refusing blind "
            "name-based removal"
        )
        print(msg, file=sys.stderr)
        if _raise:
            raise RuntimeError(msg)
        return
    id_matches = _container_id_match(name, container_id)
    if not id_matches:
        if _container_exists(name):
            msg = (
                f"container {name} no longer matches created ID "
                f"{container_id[:12]}; refusing removal (entry was replaced)"
            )
            print(msg, file=sys.stderr)
            if _raise:
                raise RuntimeError(msg)
            return
        # Transient window: `docker run` returned an ID but the daemon
        # has not registered the name yet. Removing by the recorded ID
        # is safe (IDs are unique; it cannot hit another container),
        # but only when the label probe does not contradict ownership:
        # a visible label mismatch still refuses.
        label = _container_label(name, HARNESS_LABEL)
        if label is not None and label != HARNESS_VALUE:
            msg = (
                f"harness ownership lost for {name}: label "
                f"{HARNESS_LABEL}={HARNESS_VALUE} missing; refusing removal"
            )
            print(msg, file=sys.stderr)
            if _raise:
                raise RuntimeError(msg)
            return
    else:
        if not _is_harness_owned(name):
            msg = (
                f"harness ownership lost for {name}: label "
                f"{HARNESS_LABEL}={HARNESS_VALUE} missing; refusing removal"
            )
            print(msg, file=sys.stderr)
            if _raise:
                raise RuntimeError(msg)
            return
    _docker("rm", "-f", container_id)
    for _ in range(10):
        if not _container_id_match(name, container_id):
            return
        time.sleep(0.5)
    msg = (
        f"harness-created container {name} ({container_id[:12]}) still "
        "exists after teardown"
    )
    print(msg, file=sys.stderr)
    if _raise:
        raise RuntimeError(msg)


def _verify_postgres_identity(url: str, *, timeout_s: int = 10) -> None:
    """Fail unless url is a live PostgreSQL maintenance database.

    Checks ``SELECT 1``, that the maintenance database from the URL
    exists (connect succeeds against it), and that ``version()``
    identifies PostgreSQL. Raises RuntimeError otherwise so a foreign
    listener on the port is never trusted.
    """
    engine = create_engine(url, connect_args={"connect_timeout": 2})
    try:
        deadline = time.monotonic() + timeout_s
        last: Exception | None = None
        while time.monotonic() < deadline:
            try:
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
                    version = conn.execute(
                        text("SHOW server_version")
                    ).scalar()
                    if not str(version or "").strip():
                        raise RuntimeError(
                            "port listener did not identify as PostgreSQL"
                        )
                return
            except OperationalError as exc:
                last = exc
                time.sleep(0.5)
        raise RuntimeError(
            "port listener is not the isolated PostgreSQL maintenance "
            f"database: {last}"
        )
    finally:
        engine.dispose()


def ensure_isolated_postgres() -> str:
    """Ensure the shared isolated PG is reachable; return maintenance URL.

    Reuses a listener only after identity verification (SELECT 1 +
    server_version on the maintenance database). Otherwise starts the
    harness-owned container, records the created container ID BEFORE
    any readiness check, and verifies readiness. Startup failure
    removes only the exact created container (ID-pinned, label
    re-verified) before raising; cleanup errors are visible and raised.
    """
    global _CREATED_BY_HARNESS, _CREATED_CONTAINER_ID
    url = _maintenance_url()
    _guard_maintenance_url(url)
    parsed = urlparse(url)
    port = parsed.port or 55440
    if _port_open(port):
        # Do not trust any listener: prove it is our PostgreSQL.
        _verify_postgres_identity(url)
        return url
    if shutil.which("docker") is None:
        raise RuntimeError("docker is required for isolated PostgreSQL tests")
    user = parsed.username or "v4test"
    password = parsed.password or "v4testpw"
    dbname = (parsed.path or "/v4test").lstrip("/") or "v4test"
    if _container_exists(TEST_CONTAINER):
        if _is_harness_owned(TEST_CONTAINER):
            # Stale harness-owned entry (e.g. previous crashed run):
            # safe to recycle.
            _remove_container_best_effort(TEST_CONTAINER)
        else:
            # A same-name container we do not own (foreign, stopped, or
            # manually created): never delete silently. Fail loudly so
            # the operator resolves the collision instead of us
            # destroying an unrelated resource.
            raise RuntimeError(
                f"container name {TEST_CONTAINER!r} already exists and is "
                "not harness-owned (missing "
                f"{HARNESS_LABEL}={HARNESS_VALUE} label); refusing to "
                "remove it. Remove or rename it manually and re-run."
            )
    try:
        proc = _docker(
            "run", "-d", "--name", TEST_CONTAINER,
            "--label", f"{HARNESS_LABEL}={HARNESS_VALUE}",
            "-e", f"POSTGRES_USER={user}",
            "-e", f"POSTGRES_PASSWORD={password}",
            "-e", f"POSTGRES_DB={dbname}",
            "-p", f"127.0.0.1:{port}:5432",
            TEST_IMAGE,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"could not start isolated PG: {(proc.stderr or '')[-500:]}"
            )
        created_id = (proc.stdout or "").strip().split()[-1] if (proc.stdout or "").strip() else ""
        if not created_id:
            raise RuntimeError(
                "docker run reported success but printed no container ID; "
                "refusing to proceed without an ID-pinned ownership record"
            )
        # Record ownership BEFORE any post-run check: a transient
        # inspect/readiness failure below must still clean up exactly
        # this container.
        _CREATED_BY_HARNESS = TEST_CONTAINER
        _CREATED_CONTAINER_ID = created_id
        # Confirm the daemon actually registered this exact container
        # (retry briefly: registration can lag `docker run` return).
        # Any failure here raises WITH the ownership record set, so the
        # handler below removes exactly the just-created container.
        # The registration check is ID-pinned (not name-exists): a
        # transient `inspect` miss must fail, never silently pass by
        # trusting the name alone.
        registered = False
        for _ in range(10):
            if _container_id_match(TEST_CONTAINER, created_id):
                registered = True
                break
            if _container_exists(TEST_CONTAINER) and not _container_id_match(
                TEST_CONTAINER, created_id
            ):
                # Name resolves to a DIFFERENT container: stop retrying,
                # fail fast (cleanup refuses the replaced entry loudly).
                registered = False
                break
            time.sleep(0.5)
        if not registered:
            raise RuntimeError(
                "docker run reported success but the created container "
                "is not registered under the expected name"
            )
        for _ in range(30):
            if _port_open(port):
                break
            time.sleep(1)
        else:
            raise RuntimeError("isolated PG port never opened")
        _verify_postgres_identity(url, timeout_s=30)
    except Exception:
        # Startup failure cleanup: remove ONLY the exact container this
        # run created (ID-pinned + label re-verified inside
        # _remove_created_container); never touch a foreign or
        # pre-existing same-name entry. Cleanup errors propagate (they
        # are printed and raised, not hidden); the original failure is
        # chained for context.
        if _CREATED_BY_HARNESS == TEST_CONTAINER and _CREATED_CONTAINER_ID:
            try:
                _remove_created_container(
                    TEST_CONTAINER, _CREATED_CONTAINER_ID
                )
            finally:
                _CREATED_BY_HARNESS = None
                _CREATED_CONTAINER_ID = None
        raise
    return url


def teardown_harness_container(*, _raise: bool = True) -> None:
    """Remove ONLY a harness-created container; verify absence.

    Cleanup errors are always printed to stderr so they are visible in
    test output; with ``_raise=True`` (default) they also raise so a
    hidden cleanup failure cannot pass silently.
    """
    import sys

    global _CREATED_BY_HARNESS, _CREATED_CONTAINER_ID
    target = _CREATED_BY_HARNESS
    created_id = _CREATED_CONTAINER_ID
    _CREATED_BY_HARNESS = None
    _CREATED_CONTAINER_ID = None
    if not target:
        return
    if not created_id:
        # Ownership was recorded without an ID (should not happen after
        # the ID-pinned repair): fall back to label-gated name removal
        # rather than leaking, but loudly.
        print(
            f"no recorded container ID for {target}; falling back to "
            "label-gated name removal",
            file=sys.stderr,
        )
        if not _is_harness_owned(target):
            msg = (
                f"harness ownership lost for {target}: label "
                f"{HARNESS_LABEL}={HARNESS_VALUE} missing; refusing removal"
            )
            print(msg, file=sys.stderr)
            if _raise:
                raise RuntimeError(msg)
            return
        _remove_container_best_effort(target)
        for _ in range(10):
            if not _container_exists(target):
                return
            time.sleep(0.5)
        msg = f"harness-created container {target} still exists after teardown"
        print(msg, file=sys.stderr)
        if _raise:
            raise RuntimeError(msg)
        return
    _remove_created_container(target, created_id, _raise=_raise)


@pytest.fixture(scope="session")
def isolated_pg():
    """Session cold-start gate with guaranteed owned-container teardown."""
    url = ensure_isolated_postgres()
    try:
        yield url
    finally:
        teardown_harness_container()
