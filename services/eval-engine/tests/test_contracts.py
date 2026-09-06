"""Backend-owned V4 contract tests: Decimal strings and OpenAPI shape."""

from decimal import Decimal

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from eval_engine.contracts import (
    CompCandidateV4,
    DecimalString,
    EvaluationRequestV4,
    SettingsSnapshotV4,
    SubjectPropertyV4,
)


class _Money(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: DecimalString


def test_decimal_string_accepts_strict_grammar():
    assert _Money(amount="1234.56").amount == Decimal("1234.56")
    assert _Money(amount="1e3").amount == Decimal("1000")
    assert _Money(amount="+.5").amount == Decimal("0.5")


def test_decimal_string_rejects_numbers_separators_and_garbage():
    for bad in (1.1, 42, True, "abc", "", "1,234.56", "1_234", "12 34", "NaN", "Infinity"):
        with pytest.raises(ValidationError):
            _Money(amount=bad)


def test_json_serialization_uses_decimal_strings():
    model = _Money(amount="1234.50")
    dumped = model.model_dump(mode="json")
    assert dumped == {"amount": "1234.50"}
    assert isinstance(dumped["amount"], str)


def test_json_schema_is_string_only_with_grammar():
    schema = _Money.model_json_schema()
    amount = schema["properties"]["amount"]
    assert amount["type"] == "string"
    assert "pattern" in amount
    assert amount.get("description")


def test_subject_alias_zip_serializes_and_forbids_extra():
    subject = SubjectPropertyV4(address="1 Main St", zip="12345", sqft="2000")
    dumped = subject.model_dump(mode="json", by_alias=True)
    assert dumped["zip"] == "12345"
    assert dumped["sqft"] == "2000"
    with pytest.raises(ValidationError):
        SubjectPropertyV4.model_validate({"address": "x", "bogus": 1})


def test_subject_rejects_negative_measurements():
    with pytest.raises(ValidationError):
        SubjectPropertyV4(address="x", sqft="-5")


def test_full_request_round_trip_with_strings():
    payload = {
        "subject": {"address": "1 Main St", "sqft": "2000", "property_type": "SFR"},
        "comps": [
            {"comp_id": "c1", "verified_sale_price": "500000", "sqft": "2000", "sale_date": "2026-06-01"},
        ],
        "renovation_level": "light_cosmetic",
        "settings": {"tiers": []},
        "evaluation_date": "2026-09-01",
    }
    request = EvaluationRequestV4.model_validate(payload)
    assert request.subject.sqft == Decimal(2000)
    assert request.comps[0].verified_sale_price == Decimal(500000)
    assert str(request.comps[0].sale_date) == "2026-06-01"
    dumped = request.model_dump(mode="json")
    assert dumped["comps"][0]["verified_sale_price"] == "500000"
    assert dumped["methodology_version"] == "evaluation-v4"


def test_full_request_rejects_numeric_decimals():
    payload = {
        "subject": {"address": "1 Main St", "sqft": 2000},
        "comps": [],
        "renovation_level": "light_cosmetic",
        "settings": {"tiers": []},
    }
    with pytest.raises(ValidationError):
        EvaluationRequestV4.model_validate(payload)


def test_full_date_validation_rejects_slices_and_bad_dates():
    from eval_engine.contracts.dates import parse_full_date

    assert str(parse_full_date("2026-09-01")) == "2026-09-01"
    for bad in ("2026/09/01", "20260901", "2026-13-01", "2026-02-30", "06/01/2026", "2026-9-1", "2026-09-01T", "", 20260901, True):
        with pytest.raises((ValidationError, ValueError)):
            parse_full_date(bad)
    with pytest.raises(ValidationError):
        CompCandidateV4(comp_id="c1", sale_date="06/01/2026")
    with pytest.raises(ValidationError):
        EvaluationRequestV4.model_validate(
            {
                "subject": {"address": "x"},
                "comps": [],
                "renovation_level": "light_cosmetic",
                "settings": {"tiers": []},
                "evaluation_date": "2026-02-30",
            }
        )


def test_snapshot_hash_validated_and_id_required():
    from eval_engine.contracts.settings import RenovationTierCellV4, RenovationTierV4

    levels = ["lipstick", "light_cosmetic", "full_cosmetic", "heavy_rehab", "full_gut"]
    tiers = [
        RenovationTierV4(
            tier_key="under500k", lower_inclusive="0", upper_exclusive="500000",
            cells=[RenovationTierCellV4(renovation_level=lv, rehab_rate_per_sqft="100", flip_profit="50000") for lv in levels],
        ),
        RenovationTierV4(
            tier_key="500k_to_under1m", lower_inclusive="500000", upper_exclusive="1000000",
            cells=[RenovationTierCellV4(renovation_level=lv, rehab_rate_per_sqft="100", flip_profit="50000") for lv in levels],
        ),
        RenovationTierV4(
            tier_key="1m_to_3m", lower_inclusive="1000000", upper_inclusive="3000000",
            cells=[RenovationTierCellV4(renovation_level=lv, rehab_rate_per_sqft="100", flip_profit="50000") for lv in levels],
        ),
        RenovationTierV4(
            tier_key="over3m", lower_exclusive="3000000",
            cells=[RenovationTierCellV4(renovation_level=lv, rehab_rate_per_sqft="100", flip_profit="50000") for lv in levels],
        ),
    ]
    snapshot = SettingsSnapshotV4(snapshot_id="s1", tiers=tiers)
    stamped = snapshot.validated_for_durable_use()
    assert stamped.content_hash == snapshot.compute_content_hash()
    tampered = stamped.model_copy(update={"content_hash": "0" * 64})
    with pytest.raises(ValueError):
        tampered.validated_for_durable_use()
    with pytest.raises(ValueError):
        SettingsSnapshotV4(snapshot_id="").validated_for_durable_use()


def test_openapi_compatible_json_schema_generation():
    schema = EvaluationRequestV4.model_json_schema()
    assert schema["title"] == "EvaluationRequestV4"
    assert "subject" in schema["$defs"] or "subject" in schema.get("properties", {})
    raw = str(schema)
    assert "decimal" in raw.lower()


def test_comp_candidate_defaults_and_status_fields():
    comp = CompCandidateV4(comp_id="c9")
    assert comp.verified_sale_price is None
    assert comp.evidence_ref == ""
    assert comp.sale_date is None
    with pytest.raises(ValidationError):
        CompCandidateV4(comp_id="")
    with pytest.raises(ValidationError):
        CompCandidateV4(comp_id="c9", extra_field="nope")


def test_settings_snapshot_hash_and_provenance():
    snapshot = SettingsSnapshotV4(snapshot_id="s1", tiers=SettingsSnapshotV4(snapshot_id="s1").tiers)
    digest = snapshot.compute_content_hash()
    assert len(digest) == 64
    assert snapshot.schema_version == "evaluation-v4"
    assert snapshot.transaction_rule.rule_id == "transaction_eligibility"
