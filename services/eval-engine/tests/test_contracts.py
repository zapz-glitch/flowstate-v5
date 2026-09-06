"""Backend-owned V4 contract tests: Decimal strings and OpenAPI shape."""

from decimal import Decimal

import pytest
from pydantic import BaseModel, ValidationError

from eval_engine.contracts import (
    CompCandidateV4,
    DecimalString,
    EvaluationRequestV4,
    SettingsSnapshotV4,
    SubjectPropertyV4,
)


class _Money(BaseModel):
    amount: DecimalString


def test_decimal_string_accepts_string_and_int():
    assert _Money(amount="1234.56").amount == Decimal("1234.56")
    assert _Money(amount=42).amount == Decimal(42)
    assert _Money(amount="1,234.56").amount == Decimal("1234.56")


def test_decimal_string_rejects_floats_and_garbage():
    with pytest.raises(ValidationError):
        _Money(amount=1.1)
    with pytest.raises(ValidationError):
        _Money(amount="abc")
    with pytest.raises(ValidationError):
        _Money(amount="")


def test_json_serialization_uses_decimal_strings():
    model = _Money(amount="1234.50")
    dumped = model.model_dump(mode="json")
    assert dumped == {"amount": "1234.50"}
    assert isinstance(dumped["amount"], str)


def test_subject_alias_zip_serializes():
    subject = SubjectPropertyV4(address="1 Main St", zip="12345", sqft="2000")
    dumped = subject.model_dump(mode="json", by_alias=True)
    assert dumped["zip"] == "12345"
    assert dumped["sqft"] == "2000"


def test_full_request_round_trip_with_strings():
    payload = {
        "subject": {"address": "1 Main St", "sqft": "2000", "property_type": "SFR"},
        "comps": [
            {"comp_id": "c1", "verified_sale_price": "500000", "sqft": "2000"},
        ],
        "renovation_level": "light_cosmetic",
        "settings": {"tiers": []},
        "evaluation_date": "2026-09-01",
    }
    request = EvaluationRequestV4.model_validate(payload)
    assert request.subject.sqft == Decimal(2000)
    assert request.comps[0].verified_sale_price == Decimal(500000)
    dumped = request.model_dump(mode="json")
    assert dumped["comps"][0]["verified_sale_price"] == "500000"


def test_openapi_compatible_json_schema_generation():
    schema = EvaluationRequestV4.model_json_schema()
    assert schema["title"] == "EvaluationRequestV4"
    assert "subject" in schema["$defs"] or "subject" in schema.get("properties", {})


def test_comp_candidate_defaults_and_status_fields():
    comp = CompCandidateV4(comp_id="c9")
    assert comp.verified_sale_price is None
    assert comp.evidence_ref == ""
