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
