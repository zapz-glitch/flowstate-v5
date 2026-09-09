from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from eval_engine.local_bridge import app
from test_evaluation import make_settings

TOKEN = "local-test-token-" * 4


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("V4_LOCAL_BRIDGE_ENABLED", "true")
    monkeypatch.setenv("V4_LOCAL_BRIDGE_TOKEN", TOKEN)
    with TestClient(app, base_url="http://localhost") as instance:
        yield instance


def payload():
    return {
        "subject": {"subject_id": "subject", "sqft": "2000"},
        "comps": [
            {"comp_id": str(i), "verified_sale_price": str(price), "sqft": "2000",
             "sale_date": "2026-06-01", "is_sale": True, "evidence_ref": f"sale-{i}"}
            for i, price in enumerate([600000, 620000, 640000, 300000])
        ],
        "evaluation_date": "2026-09-08",
        "renovation_level": "light_cosmetic",
        "settings": make_settings().model_dump(mode="json"),
    }


def send(client, data):
    return client.post("/evaluate", json=data, headers={"Authorization": f"Bearer {TOKEN}"})


def test_explicit_enablement_required(monkeypatch):
    monkeypatch.delenv("V4_LOCAL_BRIDGE_ENABLED", raising=False)
    with pytest.raises(RuntimeError):
        with TestClient(app):
            pass


def test_strong_token_required(monkeypatch):
    monkeypatch.setenv("V4_LOCAL_BRIDGE_ENABLED", "true")
    monkeypatch.setenv("V4_LOCAL_BRIDGE_TOKEN", "short")
    with pytest.raises(RuntimeError):
        with TestClient(app):
            pass


def test_auth_before_body_validation(client):
    assert client.post("/evaluate", content="invalid").status_code == 401
    assert client.post("/evaluate", json=payload(), headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_reject_nonlocal_host(client):
    assert client.get("/health", headers={"Host": "attacker.example"}).status_code == 400


def test_uses_python_single_reference_and_decimal_results(client):
    response = send(client, payload())
    assert response.status_code == 200
    output = response.json()
    assert output["engine"] == "python-v4"
    result = output["result"]
    assert result["arv"]["final_arv"] == "640000"
    assert result["arv"]["accepted_comp_ids"] == ["2"]
    assert result["renovation"]["total_rehab"] == "200000"
    assert result["deal"]["seller_contract_ceiling_exact"] == "390000"
    assert result["settings_content_hash"]
    assert result["deal"]["initial_offer_status"] == "INCOMPLETE"


def test_missing_sale_price_is_not_synthesized(client):
    data = payload()
    data["comps"] = data["comps"][:1]
    data["comps"][0]["verified_sale_price"] = None
    result = send(client, data).json()["result"]
    assert result["status"] == "INSUFFICIENT_COMPS"
    assert result["arv"]["final_arv"] is None
    assert result["deal"] is None


def test_one_verified_comp_returns_preliminary_python_value(client):
    data = payload()
    data["comps"] = data["comps"][:1]
    result = send(client, data).json()["result"]
    assert result["status"] == "REVIEW_REQUIRED"
    assert result["arv"]["status"] == "PRELIMINARY"
    assert result["arv"]["final_arv"] == "600000"
    assert result["arv"]["accepted_comp_ids"] == ["0"]
    assert result["deal"]["status"] == "PRELIMINARY"


def test_bridge_manual_selection_recalculates_and_rejects_unknown(client):
    data = payload()
    data["selected_comp_ids"] = ["0", "1"]
    response = send(client, data)
    assert response.status_code == 200
    assert response.json()["result"]["arv"]["final_arv"] == "610000"
    data["selected_comp_ids"] = ["unknown"]
    assert send(client, data).status_code == 422


def test_bridge_retains_building_style_evidence(client):
    data = payload()
    data["subject"]["building_style"] = "Conventional"
    data["comps"] = data["comps"][:2]
    data["comps"][0]["building_style"] = "Conventional"
    data["comps"][1]["building_style"] = "Ranch"
    data["settings"]["filters"] = [{"rule_id": "style", "kind": "building_style_match"}]
    response = send(client, data)
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["arv"]["accepted_comp_ids"] == ["0"]
    assert result["arv"]["final_arv"] == "600000"


def test_invalid_tiers_return_failure_not_legacy_value(client):
    data = payload()
    data["settings"]["tiers"][0]["upper_exclusive"] = "501000"
    result = send(client, data).json()["result"]
    assert result["status"] == "FAILED"
    assert result["errors"][0]["code"] == "INVALID_SNAPSHOT"


def test_contract_and_request_bounds(client):
    data = payload()
    for update in ({"evaluation_date": None}, {"unexpected": True}, {"comps": data["comps"] * 126}):
        candidate = deepcopy(data)
        candidate.update(update)
        assert send(client, candidate).status_code == 422
    assert client.post("/evaluate", content="x" * 2_000_001, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 413
