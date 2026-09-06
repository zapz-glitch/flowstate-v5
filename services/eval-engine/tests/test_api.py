"""V4-104 durable API tests: auth, validation, idempotency, isolation.

Isolated PostgreSQL harness mirrors test_persistence.py (distinct temp
database on 127.0.0.1:55440, never production/Neon). Covers 1/5/10/20/50
acceptance, invalid 0/51 rejected before writes, missing/invalid/
rotated-expired auth, replay/conflict, cross-tenant reads, committed
polling, per-property status/result shapes, and no provider calls.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

os.environ["V4_TEST_PROFILE"] = "true"

from eval_engine.api import deps as api_deps  # noqa: E402
from eval_engine.main import app, validate_startup_configuration  # noqa: E402
from eval_engine.persistence.models import Batch, Evaluation  # noqa: E402

MAINT_URL = os.environ.get(
    "V4_TEST_DATABASE_URL",
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test",
)

TENANT_A = "tenant-alpha"
TENANT_B = "tenant-beta"
TOKEN_A = "token-alpha-live-001"
TOKEN_B = "token-beta-live-001"
TOKEN_ROT_OLD = "token-alpha-previous-001"
TOKEN_ROT_NEW = "token-alpha-live-002"


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _cred_env(*, old_expired: bool = False) -> str:
    previous_expiry = (datetime.now(timezone.utc) - timedelta(hours=1) if old_expired
                       else datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    return json.dumps([
        {"tenant_id": TENANT_A, "user_id": "svc-a", "token_sha256": _h(TOKEN_A)},
        {"tenant_id": TENANT_B, "user_id": "svc-b", "token_sha256": _h(TOKEN_B)},
        {"tenant_id": "tenant-rot", "user_id": "svc-r", "token_sha256": _h(TOKEN_ROT_NEW),
         "previous_token_sha256": _h(TOKEN_ROT_OLD), "previous_expires_at": previous_expiry},
    ])


def _levels():
    return ["lipstick", "light_cosmetic", "full_cosmetic", "heavy_rehab", "full_gut"]


def _tiers_payload():
    from eval_engine.contracts.settings import RenovationTierCellV4, RenovationTierV4

    def cells():
        return [
            RenovationTierCellV4(renovation_level=lv, rehab_rate_per_sqft="100", flip_profit="50000")
            for lv in _levels()
        ]

    tiers = [
        RenovationTierV4(tier_key="under500k", lower_inclusive="0", upper_exclusive="500000", cells=cells()),
        RenovationTierV4(tier_key="500k_to_under1m", lower_inclusive="500000", upper_exclusive="1000000", cells=cells()),
        RenovationTierV4(tier_key="1m_to_3m", lower_inclusive="1000000", upper_inclusive="3000000", cells=cells()),
        RenovationTierV4(tier_key="over3m", lower_exclusive="3000000", cells=cells()),
    ]
    return [t.model_dump(mode="json") for t in tiers]


def _subject(i: int) -> dict:
    return {"address": f"{i} Main St", "city": "Austin", "state": "TX", "sqft": "2000"}


def _comps(base: int = 600000) -> list[dict]:
    return [
        {"comp_id": f"c{k}", "verified_sale_price": str(base - k * 10000),
         "sale_date": "2026-06-01", "sqft": "2000", "evidence_ref": f"ev-{k}", "is_sale": True}
        for k in range(1, 4)
    ]


def _body(n: int, *, key_prefix: str = "prop") -> dict:
    from eval_engine.contracts.settings import SettingsSnapshotV4

    settings = SettingsSnapshotV4(
        snapshot_id="snap-1", tiers=[], deal={}, transaction_rule={},
    )
    payload = settings.model_dump(mode="json")
    payload["tiers"] = _tiers_payload()
    return {
        "settings": payload,
        "evaluations": [
            {"idempotency_key": f"{key_prefix}-{i}", "subject": _subject(i), "comps": _comps(),
             "renovation_level": "light_cosmetic", "evaluation_date": "2026-09-01"}
            for i in range(n)
        ],
    }


@pytest.fixture(scope="module")
def api_engine():
    from urllib.parse import urlparse

    parsed = urlparse(MAINT_URL)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and (parsed.port or 5432) == 55440
    maint = create_engine(MAINT_URL, isolation_level="AUTOCOMMIT")
    db_name = f"v4api_{uuid.uuid4().hex[:12]}"
    with maint.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    url = MAINT_URL.rsplit("/", 1)[0] + f"/{db_name}"
    engine = create_engine(url, pool_pre_ping=True)
    from alembic import command
    from alembic.config import Config

    ini = os.path.join(os.path.dirname(__file__), "..", "alembic.ini")
    cfg = Config(ini)
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(cfg, "head")
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
    api_deps._engine = engine
    yield engine
    api_deps._engine = None
    engine.dispose()
    with maint.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    maint.dispose()


@pytest.fixture()
def client(api_engine, monkeypatch):
    monkeypatch.setenv("V4_TEST_PROFILE", "true")
    monkeypatch.setenv("V4_API_CREDENTIALS", _cred_env())
    monkeypatch.setenv("DATABASE_URL", str(api_engine.url))
    return TestClient(app, raise_server_exceptions=False)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _post(client, token, body, key, *, raw_body=None):
    headers = {"Idempotency-Key": key}
    if token is not None:
        headers.update(_auth(token))
    return client.post("/v1/evaluations", json=body if raw_body is None else raw_body, headers=headers)


def _count_batches(engine, tenant: str) -> int:
    maker = sessionmaker(bind=engine)
    with maker() as sess:
        return sess.execute(
            select(func.count()).select_from(Batch).where(Batch.tenant_id == tenant)
        ).scalar() or 0


@pytest.mark.parametrize("count", [1, 5, 10, 20, 50])
def test_acceptance_batch_sizes(client, api_engine, count):
    key = f"accept-{count}-{uuid.uuid4().hex[:8]}"
    resp = _post(client, TOKEN_A, _body(count, key_prefix=f"a{count}"), key)
    assert resp.status_code == 202, resp.text
    payload = resp.json()
    assert payload["batch_id"] and payload["created_or_reused"] == "created"
    assert len(payload["evaluations"]) == count
    for item in payload["evaluations"]:
        assert item["evaluation_id"] and item["status"] == "COMPLETED"
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A))
        assert got.status_code == 200
        body = got.json()
        assert body["status"] == "COMPLETED"
        assert body["result"] is not None
        assert body["result"]["settings_snapshot_id"]
        assert body["result"]["settings_content_hash"]
    batch = client.get(f"/v1/evaluation-batches/{payload['batch_id']}", headers=_auth(TOKEN_A))
    assert batch.status_code == 200
    assert batch.json()["status"] == "SUCCEEDED"
    assert batch.json()["total"] == count


def test_reject_zero_and_over_limit_before_writes(client, api_engine):
    before = _count_batches(api_engine, TENANT_A)
    body = _body(1)
    body["evaluations"] = []
    resp = _post(client, TOKEN_A, None, "zero-key", raw_body=body)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
    big = _body(50)
    big["evaluations"] = list(big["evaluations"]) + [dict(big["evaluations"][0], idempotency_key="one-too-many")]
    resp = _post(client, TOKEN_A, None, "big-key", raw_body=big)
    assert resp.status_code == 422
    assert _count_batches(api_engine, TENANT_A) == before


def test_missing_idempotency_key_rejected(client):
    resp = client.post("/v1/evaluations", json=_body(1), headers=_auth(TOKEN_A))
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


def test_auth_missing_invalid_and_rotated_expired(client):
    resp = client.post("/v1/evaluations", json=_body(1), headers={"Idempotency-Key": "k1"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "AUTH_MISSING"
    resp = _post(client, "bogus-token", _body(1), "k2")
    assert resp.status_code == 401
    assert resp.json()["code"] == "AUTH_INVALID"
    resp = client.get("/v1/evaluations/00000000-0000-0000-0000-000000000000", headers=_auth("bogus-token"))
    assert resp.status_code == 401
    monkeypatch_expired = os.environ.get("V4_API_CREDENTIALS")
    _ = monkeypatch_expired
    import eval_engine.api.auth as auth_module

    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    records = auth_module.parse_credentials(json.dumps([
        {"tenant_id": "t", "user_id": "u", "token_sha256": _h("cur"),
         "previous_token_sha256": _h("old"), "previous_expires_at": past},
        {"tenant_id": "t2", "user_id": "u2", "token_sha256": _h("cur2"),
         "previous_token_sha256": _h("old2"), "previous_expires_at": future},
    ]))
    assert auth_module.match_credential(records, "old") is None
    assert auth_module.match_credential(records, "old2") is not None
    assert auth_module.match_credential(records, "cur") is not None


def test_startup_rejects_missing_candidate_auth(monkeypatch):
    monkeypatch.setenv("V4_TEST_PROFILE", "false")
    monkeypatch.delenv("V4_API_CREDENTIALS", raising=False)
    monkeypatch.delenv("V4_INTERNAL_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        validate_startup_configuration()


def test_idempotency_replay_returns_same_ids_and_conflict_409(client):
    key = f"replay-{uuid.uuid4().hex[:8]}"
    body = _body(2, key_prefix=f"rp-{key}")
    first = _post(client, TOKEN_A, body, key)
    assert first.status_code == 202
    first_ids = [e["evaluation_id"] for e in first.json()["evaluations"]]
    second = _post(client, TOKEN_A, body, key)
    assert second.status_code == 202
    assert second.json()["batch_id"] == first.json()["batch_id"]
    assert [e["evaluation_id"] for e in second.json()["evaluations"]] == first_ids
    assert all(e["created_or_reused"] == "reused" for e in second.json()["evaluations"])
    altered = json.loads(json.dumps(body))
    altered["evaluations"][0]["subject"]["address"] = "9 Changed St"
    conflict = _post(client, TOKEN_A, altered, key)
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_cross_tenant_reads_are_404(client):
    key = f"xt-{uuid.uuid4().hex[:8]}"
    created = _post(client, TOKEN_A, _body(1, key_prefix=f"xt-{key}"), key)
    assert created.status_code == 202
    batch_id = created.json()["batch_id"]
    eval_id = created.json()["evaluations"][0]["evaluation_id"]
    assert client.get(f"/v1/evaluations/{eval_id}", headers=_auth(TOKEN_B)).status_code == 404
    assert client.get(f"/v1/evaluation-batches/{batch_id}", headers=_auth(TOKEN_B)).status_code == 404
    assert client.get(f"/v1/evaluations/{eval_id}", headers=_auth(TOKEN_A)).status_code == 200


def test_committed_polling_after_disconnect_equivalent(client):
    key = f"disc-{uuid.uuid4().hex[:8]}"
    created = _post(client, TOKEN_A, _body(3, key_prefix=f"dc-{key}"), key)
    assert created.status_code == 202
    for item in created.json()["evaluations"]:
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A))
        assert got.status_code == 200
        assert got.json()["result"] is not None
    batch = client.get(f"/v1/evaluation-batches/{created.json()['batch_id']}", headers=_auth(TOKEN_A))
    assert batch.json()["succeeded"] == 3


def test_per_property_status_and_result_shapes(client):
    key = f"shape-{uuid.uuid4().hex[:8]}"
    body = _body(2, key_prefix=f"sh-{key}")
    body["evaluations"][1]["comps"] = []
    resp = _post(client, TOKEN_A, body, key)
    assert resp.status_code == 202
    statuses = {e["idempotency_key"]: e["status"] for e in resp.json()["evaluations"]}
    assert statuses[f"sh-{key}-0"] == "COMPLETED"
    assert statuses[f"sh-{key}-1"] == "INSUFFICIENT_COMPS"
    for item in resp.json()["evaluations"]:
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A))
        payload = got.json()
        assert payload["result"]["methodology_version"] == "evaluation-v4"
        assert payload["result"]["settings_snapshot_id"]
        assert payload["result"]["settings_content_hash"]
        assert isinstance(payload["incomplete_sections"], list)


def test_no_provider_calls_in_request_path(client, monkeypatch):
    import eval_engine.application.service as service

    def _boom(*args, **kwargs):
        raise AssertionError("provider must not be called")

    monkeypatch.setattr(service.NoLiveProvider, "acquire_subject", _boom)
    monkeypatch.setattr(service.NoLiveProvider, "acquire_comps", _boom)
    monkeypatch.setattr(service.NoLiveProvider, "acquire_permits", _boom)
    key = f"np-{uuid.uuid4().hex[:8]}"
    resp = _post(client, TOKEN_A, _body(1, key_prefix=f"np-{key}"), key)
    assert resp.status_code == 202
