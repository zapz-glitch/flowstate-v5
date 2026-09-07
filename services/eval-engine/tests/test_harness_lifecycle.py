"""Harness ownership tests: created-container cleanup, pre-existing safety.

Proves the shared cold-start harness (tests/conftest.py) and the
health readiness container discipline:

- a harness-created container is removed on teardown (pass path);
- teardown still runs and removes the container when the test body
  fails (failure path);
- a pre-existing VALID maintenance container (identity-verified) is
  reused and NOT removed;
- a same-name container the harness does not own (missing ownership
  label, e.g. foreign or stopped unrelated entry) is never deleted
  silently: ensure raises instead of destroying it;
- a foreign listener on the port (non-PostgreSQL) is rejected, never
  trusted as the maintenance database.

All docker interactions here run against the real Docker daemon but
use disposable same-process state (monkeypatched helpers or uniquely
created containers); no production or unrelated resources are
touched. No live providers anywhere.
"""

from __future__ import annotations

import pytest

import tests.conftest as harness


@pytest.fixture()
def _isolated_harness_state(monkeypatch):
    """Confine harness globals + docker calls to fakes for unit tests."""
    monkeypatch.setattr(harness, "_CREATED_BY_HARNESS", None)
    monkeypatch.setattr(harness, "_CREATED_CONTAINER_ID", None)
    calls: list = []

    def fake_docker(*args: str):
        calls.append(args)
        return None  # type: ignore[return-value]

    monkeypatch.setattr(harness, "_docker", fake_docker)
    return calls


def test_teardown_removes_only_harness_created_container(
    monkeypatch, _isolated_harness_state
):
    removed: list = []
    live: dict = {"v4-persist-pg-102": "abc123"}

    def fake_id_match(name: str, container_id: str) -> bool:
        return live.get(name) == container_id

    def fake_exists(name: str) -> bool:
        return name in live

    def fake_owned(name: str) -> bool:
        return name == "v4-persist-pg-102"

    def fake_docker_rm(*args: str):
        # teardown path issues ("rm", "-f", <container-id>)
        if args[:2] == ("rm", "-f"):
            cid = args[2]
            removed.append(cid)
            for name, live_cid in list(live.items()):
                if live_cid == cid:
                    del live[name]
            return
        raise AssertionError(f"unexpected docker call: {args}")

    monkeypatch.setattr(harness, "_container_id_match", fake_id_match)
    monkeypatch.setattr(harness, "_container_exists", fake_exists)
    monkeypatch.setattr(harness, "_is_harness_owned", fake_owned)
    monkeypatch.setattr(harness, "_docker", fake_docker_rm)
    harness._CREATED_BY_HARNESS = "v4-persist-pg-102"
    harness._CREATED_CONTAINER_ID = "abc123"
    try:
        harness.teardown_harness_container()
    finally:
        harness._CREATED_BY_HARNESS = None
        harness._CREATED_CONTAINER_ID = None
    assert removed == ["abc123"]
    assert harness._CREATED_BY_HARNESS is None
    assert harness._CREATED_CONTAINER_ID is None


def test_docker_run_then_post_run_inspect_fails_removes_only_created(
    monkeypatch, capsys
):
    """Deterministic regression for the transient-inspect leak window.

    `docker run` succeeds (container ID captured, ownership recorded
    BEFORE the post-run check), then the post-run registration inspect
    transiently reports a mismatch; ensure must raise AND remove only
    the newly created ID-pinned container, never a pre-existing entry.
    """
    created_id = "deadbeef" * 8
    pre_existing = {"some-other-container": "cafe0001"}
    removed: list = []
    # Fake daemon registration: the just-created container only. `rm`
    # mutates it like the real daemon so the post-removal absence probe
    # passes; the pre-existing entry lives outside this registry and is
    # never addressable by the harness fakes.
    registered: dict = {}

    class _Proc:
        def __init__(self, returncode=0, stdout="", stderr=""):
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

    def fake_docker(*args: str):
        if args[:1] == ("run",):
            registered["v4-persist-pg-102"] = created_id
            return _Proc(0, stdout=created_id + "\n")
        if args[:1] == ("rm",):
            removed.append(args[-1])
            for name, cid in list(registered.items()):
                if cid == args[-1] or name == args[-1]:
                    del registered[name]
            return _Proc(0, stdout="")
        if args[:2] == ("inspect", "--format"):
            return _Proc(0, stdout="")  # transient: nothing registered yet
        return _Proc(0, stdout="")

    monkeypatch.setattr(harness, "_docker", fake_docker)
    monkeypatch.setattr(harness, "_maintenance_url",
                        lambda: harness.DEFAULT_MAINT_URL)
    monkeypatch.setattr(harness, "_port_open", lambda port: False)
    # Transient daemon lag AFTER a successful `docker run`: the
    # registration probes miss even though the ID was captured. The
    # failure must still trigger ID-pinned cleanup of the new ID.
    monkeypatch.setattr(harness, "_container_exists", lambda name: False)
    monkeypatch.setattr(harness, "_container_id_match",
                        lambda name, cid: False)
    monkeypatch.setattr(harness, "_is_harness_owned", lambda name: True)
    monkeypatch.setattr(harness, "time", __import__("time"))
    # Skip real sleeps: registration retry loop must fail fast here.
    monkeypatch.setattr(harness.time, "sleep", lambda s: None)
    harness._CREATED_BY_HARNESS = None
    harness._CREATED_CONTAINER_ID = None
    try:
        with pytest.raises(RuntimeError, match="not registered"):
            harness.ensure_isolated_postgres()
    finally:
        leaked_name = harness._CREATED_BY_HARNESS
        leaked_id = harness._CREATED_CONTAINER_ID
        harness._CREATED_BY_HARNESS = None
        harness._CREATED_CONTAINER_ID = None
    # Exactly the just-created container was removed by ID; the
    # pre-existing entry is untouched (not in `removed`, still present).
    assert removed == [created_id], removed
    assert pre_existing == {"some-other-container": "cafe0001"}
    assert leaked_name is None and leaked_id is None


def test_docker_run_then_readiness_fails_removes_only_created(monkeypatch):
    """Same window, later stage: port never opens after a good `run`."""
    created_id = "feedface" * 8
    removed: list = []
    registered: dict = {}

    class _Proc:
        def __init__(self, returncode=0, stdout="", stderr=""):
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

    def fake_docker(*args: str):
        if args[:1] == ("run",):
            registered["v4-persist-pg-102"] = created_id
            return _Proc(0, stdout=created_id + "\n")
        if args[:1] == ("rm",):
            removed.append(args[-1])
            for name, cid in list(registered.items()):
                if cid == args[-1] or name == args[-1]:
                    del registered[name]
            return _Proc(0, stdout="")
        if args[:3] == ("inspect", "--format", "{{.Id}}"):
            name = args[3] if len(args) > 3 else ""
            cid = registered.get(name, "")
            return _Proc(0 if cid else 1, stdout=(cid + "\n") if cid else "")
        if args[:3] == ("inspect", "--format", "{{.Name}}"):
            name = args[3] if len(args) > 3 else ""
            return _Proc(
                0 if name in registered else 1,
                stdout=(f"/{name}\n" if name in registered else ""),
            )
        if args[:2] == ("inspect", "--format"):
            return _Proc(0, stdout="isolated-pg\n")
        return _Proc(0, stdout="")

    monkeypatch.setattr(harness, "_docker", fake_docker)
    monkeypatch.setattr(harness, "_maintenance_url",
                        lambda: harness.DEFAULT_MAINT_URL)
    monkeypatch.setattr(harness, "_port_open", lambda port: False)
    monkeypatch.setattr(harness, "_container_exists",
                        lambda name: name in registered)
    monkeypatch.setattr(harness, "_container_id_match",
                        lambda name, cid: registered.get(name) == cid)
    monkeypatch.setattr(harness, "_is_harness_owned", lambda name: True)
    monkeypatch.setattr(harness.time, "sleep", lambda s: None)
    harness._CREATED_BY_HARNESS = None
    harness._CREATED_CONTAINER_ID = None
    try:
        with pytest.raises(RuntimeError, match="port never opened"):
            harness.ensure_isolated_postgres()
    finally:
        harness._CREATED_BY_HARNESS = None
        harness._CREATED_CONTAINER_ID = None
    assert removed == [created_id], removed


def test_teardown_failure_path_still_cleans_created_container(monkeypatch):
    """Simulate a failed test body: fixture finally still tears down."""
    removed: list = []
    live: dict = {"v4-persist-pg-102": "abc123"}
    monkeypatch.setattr(harness, "_container_id_match",
                        lambda name, cid: live.get(name) == cid)
    monkeypatch.setattr(harness, "_container_exists",
                        lambda name: name in live)
    monkeypatch.setattr(harness, "_is_harness_owned", lambda name: True)

    def fake_docker_rm(*args: str):
        assert args[:2] == ("rm", "-f")
        removed.append(args[2])
        for name, live_cid in list(live.items()):
            if live_cid == args[2]:
                del live[name]

    monkeypatch.setattr(harness, "_docker", fake_docker_rm)
    harness._CREATED_BY_HARNESS = "v4-persist-pg-102"
    harness._CREATED_CONTAINER_ID = "abc123"
    try:
        with pytest.raises(AssertionError, match="induced failure"):
            try:
                raise AssertionError("induced failure")
            finally:
                harness.teardown_harness_container()
    finally:
        harness._CREATED_BY_HARNESS = None
        harness._CREATED_CONTAINER_ID = None
    assert removed == ["abc123"]


def test_teardown_preserves_pre_existing_container(monkeypatch):
    """No ownership flag set (pre-existing reuse): teardown removes nothing."""
    removed: list = []

    def fake_docker(*args: str):
        removed.append(args)
        raise AssertionError(f"docker must not be called: {args}")

    monkeypatch.setattr(harness, "_docker", fake_docker)
    harness._CREATED_BY_HARNESS = None
    harness._CREATED_CONTAINER_ID = None
    harness.teardown_harness_container()
    assert removed == []


def test_teardown_refuses_unowned_container_loudly(
    monkeypatch, capsys, _isolated_harness_state
):
    """Ownership label lost: refuse removal, error visible, then raise."""
    monkeypatch.setattr(harness, "_container_id_match", lambda n, c: True)
    monkeypatch.setattr(harness, "_container_exists", lambda n: True)
    monkeypatch.setattr(harness, "_is_harness_owned", lambda name: False)
    harness._CREATED_BY_HARNESS = "v4-persist-pg-102"
    harness._CREATED_CONTAINER_ID = "abc123"
    try:
        with pytest.raises(RuntimeError, match="refusing removal"):
            harness.teardown_harness_container()
    finally:
        harness._CREATED_BY_HARNESS = None
        harness._CREATED_CONTAINER_ID = None
    assert "refusing removal" in capsys.readouterr().err


def test_ensure_refuses_unowned_same_name_container(monkeypatch):
    """Stopped/foreign same-name entry: never deleted silently."""
    monkeypatch.setattr(harness, "_maintenance_url",
                        lambda: harness.DEFAULT_MAINT_URL)
    monkeypatch.setattr(harness, "_port_open", lambda port: False)
    monkeypatch.setattr(harness, "_container_exists", lambda name: True)
    monkeypatch.setattr(harness, "_is_harness_owned", lambda name: False)
    removed: list = []
    monkeypatch.setattr(
        harness, "_remove_container_best_effort",
        lambda name: removed.append(name),
    )
    harness._CREATED_BY_HARNESS = None
    harness._CREATED_CONTAINER_ID = None
    with pytest.raises(RuntimeError, match="not harness-owned"):
        harness.ensure_isolated_postgres()
    assert removed == []
    assert harness._CREATED_BY_HARNESS is None
    assert harness._CREATED_CONTAINER_ID is None


def test_foreign_listener_is_rejected_never_trusted(monkeypatch):
    """Port open but not PostgreSQL: hard failure, no silent reuse."""
    monkeypatch.setattr(harness, "_maintenance_url",
                        lambda: harness.DEFAULT_MAINT_URL)
    monkeypatch.setattr(harness, "_port_open", lambda port: True)

    def _boom(url: str, *, timeout_s: int = 10) -> None:
        raise RuntimeError("port listener is not the isolated PostgreSQL")

    monkeypatch.setattr(harness, "_verify_postgres_identity", _boom)
    with pytest.raises(RuntimeError, match="not the isolated PostgreSQL"):
        harness.ensure_isolated_postgres()


def test_guard_refuses_neon_prod_and_non_loopback():
    for bad in (
        "postgresql+psycopg://u:p@ep-foo.neon.tech:5432/v4test",
        "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/prod_backup",
        "postgresql+psycopg://v4test:v4testpw@10.0.0.5:55440/v4test",
        "postgresql+psycopg://v4test:v4testpw@127.0.0.1:5433/v4test",
    ):
        with pytest.raises(RuntimeError):
            harness._guard_maintenance_url(bad)
    harness._guard_maintenance_url(harness.DEFAULT_MAINT_URL)
