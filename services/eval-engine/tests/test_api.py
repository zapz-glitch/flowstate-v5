"""V4-104 durable API tests: queued durable acceptance, no inline work.

Isolated PostgreSQL harness (distinct temp database on 127.0.0.1:55440,
never production/Neon). POST persists snapshot/batch/jobs in one short
transaction and returns 202 QUEUED immediately; a test-only
worker-boundary helper processes committed jobs independently. Covers
1/5/10/20/50 queued acceptance, provider_pending persistence, invalid
0/51 rejected before writes, malformed JSON/shape handlers, auth
missing/invalid/rotated-expired, replay/conflict, cross-tenant and
cross-user 404, disconnect/commit visibility, and no provider calls.
Per-property execution isolation is a V4-103B requirement, not asserted
here beyond queued persistence.
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
from eval_engine.application.service import process_queued_evaluations  # noqa: E402
from eval_engine.main import app, validate_startup_configuration  # noqa: E402
from eval_engine.persistence.models import Batch  # noqa: E402

MAINT_URL = os.environ.get(
    "V4_TEST_DATABASE_URL",
    "postgresql+psycopg://v4test:v4testpw@127.0.0.1:55440/v4test",
)

TENANT_A = "tenant-alpha"
TENANT_B = "tenant-beta"
USER_A1 = "svc-a1"
USER_A2 = "svc-a2"
TOKEN_A1 = "token-alpha-user1-live"
TOKEN_A2 = "token-alpha-user2-live"
TOKEN_B = "token-beta-live-001"
TOKEN_ROT_OLD = "token-alpha-previous-001"
TOKEN_ROT_NEW = "token-alpha-live-002"


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _cred_env() -> str:
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    return json.dumps([
        {"tenant_id": TENANT_A, "user_id": USER_A1, "token_sha256": _h(TOKEN_A1)},
        {"tenant_id": TENANT_A, "user_id": USER_A2, "token_sha256": _h(TOKEN_A2)},
        {"tenant_id": TENANT_B, "user_id": "svc-b", "token_sha256": _h(TOKEN_B)},
        {"tenant_id": "tenant-rot", "user_id": "svc-r", "token_sha256": _h(TOKEN_ROT_NEW),
         "previous_token_sha256": _h(TOKEN_ROT_OLD), "previous_expires_at": future},
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


def _body(n: int, *, key_prefix: str = "prop", mode: str = "preloaded") -> dict:
    from eval_engine.contracts.settings import SettingsSnapshotV4

    settings = SettingsSnapshotV4(
        snapshot_id="snap-1", tiers=[], deal={}, transaction_rule={},
    )
    payload = settings.model_dump(mode="json")
    payload["tiers"] = _tiers_payload()
    return {
        "settings": payload,
        "candidate_evidence_mode": mode,
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


def _count_batches(engine) -> int:
    maker = sessionmaker(bind=engine)
    with maker() as sess:
        return sess.execute(select(func.count()).select_from(Batch)).scalar() or 0


def _process(engine, tenant: str, user: str, batch_id: str) -> int:
    import uuid as _uuid

    from eval_engine.api.deps import get_engine

    target = get_engine()
    maker = sessionmaker(bind=target, expire_on_commit=False)
    with maker() as sess:
        done = process_queued_evaluations(
            sess, tenant_id=tenant, requested_by_user_id=user, batch_id=_uuid.UUID(batch_id)
        )
        return done


@pytest.mark.parametrize("count", [1, 5, 10, 20, 50])
def test_queued_acceptance_batch_sizes(client, api_engine, count):
    key = f"accept-{count}-{uuid.uuid4().hex[:8]}"
    resp = _post(client, TOKEN_A1, _body(count, key_prefix=f"a{count}"), key)
    assert resp.status_code == 202, resp.text
    payload = resp.json()
    assert payload["batch_id"] and payload["created_or_reused"] == "created"
    assert len(payload["evaluations"]) == count
    assert all(item["status"] == "QUEUED" for item in payload["evaluations"])
    batch = client.get(f"/v1/evaluation-batches/{payload['batch_id']}", headers=_auth(TOKEN_A1))
    assert batch.status_code == 200
    assert batch.json()["status"] == "PENDING"
    assert batch.json()["total"] == count


def test_provider_pending_persists_queued_ids(client):
    key = f"pp-{uuid.uuid4().hex[:8]}"
    resp = _post(client, TOKEN_A1, _body(3, key_prefix=f"pp-{key}", mode="provider_pending"), key)
    assert resp.status_code == 202, resp.text
    payload = resp.json()
    assert len(payload["evaluations"]) == 3
    assert all(item["status"] == "QUEUED" for item in payload["evaluations"])
    for item in payload["evaluations"]:
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A1))
        assert got.status_code == 200
        assert got.json()["status"] == "QUEUED"
        assert got.json()["progress"] == "incomplete"


def test_reject_zero_and_over_limit_before_writes(client, api_engine):
    before = _count_batches(api_engine)
    body = _body(1)
    body["evaluations"] = []
    resp = _post(client, TOKEN_A1, None, f"zero-{uuid.uuid4().hex[:6]}", raw_body=body)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
    big = _body(50)
    big["evaluations"] = list(big["evaluations"]) + [dict(big["evaluations"][0], idempotency_key="one-too-many")]
    resp = _post(client, TOKEN_A1, None, f"big-{uuid.uuid4().hex[:6]}", raw_body=big)
    assert resp.status_code == 422
    assert _count_batches(api_engine) == before


def test_malformed_json_and_invalid_shape_handlers(client):
    bad = client.post(
        "/v1/evaluations", content=b"{not json",
        headers={"Idempotency-Key": "mj-1", **_auth(TOKEN_A1), "Content-Type": "application/json"},
    )
    assert bad.status_code in (400, 422)
    assert bad.json()["code"] in ("MALFORMED_JSON", "INVALID_SHAPE", "VALIDATION_ERROR")
    wrong = client.post(
        "/v1/evaluations", content=b"[1,2]",
        headers={"Idempotency-Key": "mj-2", **_auth(TOKEN_A1), "Content-Type": "application/json"},
    )
    assert wrong.status_code == 422
    assert wrong.json()["code"] in ("INVALID_SHAPE", "VALIDATION_ERROR")


def test_missing_idempotency_key_rejected(client):
    resp = client.post("/v1/evaluations", json=_body(1), headers=_auth(TOKEN_A1))
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
    first = _post(client, TOKEN_A1, body, key)
    assert first.status_code == 202
    first_ids = [e["evaluation_id"] for e in first.json()["evaluations"]]
    second = _post(client, TOKEN_A1, body, key)
    assert second.status_code == 202
    assert second.json()["batch_id"] == first.json()["batch_id"]
    assert [e["evaluation_id"] for e in second.json()["evaluations"]] == first_ids
    assert all(e["created_or_reused"] == "reused" for e in second.json()["evaluations"])
    assert all(e["status"] == "QUEUED" for e in second.json()["evaluations"])
    altered = json.loads(json.dumps(body))
    altered["evaluations"][0]["subject"]["address"] = "9 Changed St"
    conflict = _post(client, TOKEN_A1, altered, key)
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_cross_tenant_reads_are_404(client):
    key = f"xt-{uuid.uuid4().hex[:8]}"
    created = _post(client, TOKEN_A1, _body(1, key_prefix=f"xt-{key}"), key)
    assert created.status_code == 202
    batch_id = created.json()["batch_id"]
    eval_id = created.json()["evaluations"][0]["evaluation_id"]
    assert client.get(f"/v1/evaluations/{eval_id}", headers=_auth(TOKEN_B)).status_code == 404
    assert client.get(f"/v1/evaluation-batches/{batch_id}", headers=_auth(TOKEN_B)).status_code == 404
    assert client.get(f"/v1/evaluations/{eval_id}", headers=_auth(TOKEN_A1)).status_code == 200


def test_cross_user_same_tenant_reads_are_404(client):
    key = f"xu-{uuid.uuid4().hex[:8]}"
    created = _post(client, TOKEN_A1, _body(1, key_prefix=f"xu-{key}"), key)
    assert created.status_code == 202
    batch_id = created.json()["batch_id"]
    eval_id = created.json()["evaluations"][0]["evaluation_id"]
    assert client.get(f"/v1/evaluations/{eval_id}", headers=_auth(TOKEN_A2)).status_code == 404
    assert client.get(f"/v1/evaluation-batches/{batch_id}", headers=_auth(TOKEN_A2)).status_code == 404
    other_key = f"xu-other-{uuid.uuid4().hex[:8]}"
    other = _post(client, TOKEN_A2, _body(1, key_prefix=f"xo-{other_key}"), other_key)
    assert other.status_code in (202, 409)


def test_disconnect_commit_visibility_then_worker_processes(client, api_engine):
    key = f"disc-{uuid.uuid4().hex[:8]}"
    created = _post(client, TOKEN_A1, _body(3, key_prefix=f"dc-{key}"), key)
    assert created.status_code == 202
    batch_id = created.json()["batch_id"]
    for item in created.json()["evaluations"]:
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A1))
        assert got.status_code == 200
        assert got.json()["status"] == "QUEUED"
        assert got.json()["result"] is None
    done = _process(api_engine, TENANT_A, USER_A1, batch_id)
    assert done == 3
    for item in created.json()["evaluations"]:
        got = client.get(f"/v1/evaluations/{item['evaluation_id']}", headers=_auth(TOKEN_A1))
        payload = got.json()
        assert payload["status"] == "COMPLETED"
        assert payload["result"] is not None
        assert payload["result"]["settings_snapshot_id"]
        assert payload["result"]["settings_content_hash"]


def test_no_provider_calls_in_request_path(client, monkeypatch):
    import eval_engine.api.providers as providers

    def _boom(*args, **kwargs):
        raise AssertionError("provider must not be called")

    monkeypatch.setattr(providers.NoLiveProvider, "acquire_subject", _boom)
    monkeypatch.setattr(providers.NoLiveProvider, "acquire_comps", _boom)
    monkeypatch.setattr(providers.NoLiveProvider, "acquire_permits", _boom)
    key = f"np-{uuid.uuid4().hex[:8]}"
    resp = _post(client, TOKEN_A1, _body(1, key_prefix=f"np-{key}"), key)
    assert resp.status_code == 202
    assert resp.json()["evaluations"][0]["status"] == "QUEUED"
