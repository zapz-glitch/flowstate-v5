import pytest

from eval_engine.worker.runner import WorkerConfigError
from eval_engine.worker.service import build_worker_config


def test_live_worker_requires_evidence_provider(monkeypatch):
    monkeypatch.setenv("V4_EXTERNAL_CALLS_ENABLED", "true")
    with pytest.raises(WorkerConfigError, match="configured evidence provider"):
        build_worker_config(requested_by_user_id="candidate-user")


def test_offline_worker_accepts_preloaded_evidence(monkeypatch):
    monkeypatch.setenv("V4_EXTERNAL_CALLS_ENABLED", "false")
    config = build_worker_config(requested_by_user_id="candidate-user")
    assert config.provider is None
    assert config.external_calls_enabled is False


def test_live_worker_uses_explicit_provider(monkeypatch):
    monkeypatch.setenv("V4_EXTERNAL_CALLS_ENABLED", "true")
    provider = object()
    config = build_worker_config(
        requested_by_user_id="candidate-user", provider=provider
    )
    assert config.provider is provider
    assert config.external_calls_enabled is True
