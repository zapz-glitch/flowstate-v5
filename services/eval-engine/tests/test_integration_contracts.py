"""IC-1 cross-layer integration contract tests (DB-free).

Proves one canonical settings snapshot envelope/hash across:

- typed domain (SettingsSnapshotV4.compute_content_hash),
- persistence store identity input (store identity hash over
  {"version","content","source"} equals the domain hash),
- serialized stored JSON (canonical form re-hashes identically),
- result settings_content_hash (evaluate_v4 stamps the same hash).

Also proves equivalence classes (Decimal/key order/Unicode NFC) hash
identically, material provenance differences hash differently, and the
explicit V4-104 domain -> persistence status mapping.
"""

from __future__ import annotations

import unicodedata
from decimal import Decimal

from eval_engine.contracts.base import canonical_hash, canonical_json
from eval_engine.contracts.settings import (
    DOMAIN_TO_PERSISTENCE_STATUS,
    SettingsSnapshotV4,
    snapshot_store_parts,
    to_persistence_status,
)
from eval_engine.domain.evaluate import evaluate_v4


def _tiers():
    from eval_engine.contracts.settings import RenovationTierCellV4, RenovationTierV4

    levels = ["lipstick", "light_cosmetic", "full_cosmetic", "heavy_rehab", "full_gut"]
    return [
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


def _snapshot(**overrides):
    from eval_engine.contracts.filters import TransactionRuleV4
    from eval_engine.contracts.settings import DealSettingsV4

    base = {
        "snapshot_id": "s1",
        "source_timestamps": {"filters": "2026-09-01T00:00:00+00:00"},
        "transaction_rule": TransactionRuleV4(
            source="user_default", precedence="user_default", version="v3"
        ),
        "tiers": _tiers(),
        "deal": DealSettingsV4(source="user_default", precedence="user_default", version="v3"),
    }
    base.update(overrides)
    return SettingsSnapshotV4(**base)


def test_envelope_excludes_generated_ids_and_includes_version_values_provenance():
    snap = _snapshot()
    envelope = snap.canonical_payload()
    assert set(envelope.keys()) == {"version", "content", "source"}
    assert envelope["version"] == "evaluation-v4"
    blob = canonical_json(envelope)
    flat = str(blob)
    assert "s1" not in flat  # snapshot_id excluded
    # Values present.
    assert blob["content"]["deal"]["rounding_increment"] == "1000"
    assert blob["content"]["transaction_rule"]["rule_id"] == "transaction_eligibility"
    assert blob["content"]["tiers"][0]["tier_key"] == "under500k"
    # Provenance present: source_timestamps + per-rule source/precedence/version.
    assert blob["source"]["source_timestamps"]["filters"] == "2026-09-01T00:00:00+00:00"
    assert blob["content"]["deal"]["source"] == "user_default"
    assert blob["content"]["deal"]["precedence"] == "user_default"
    assert blob["content"]["deal"]["version"] == "v3"
    assert blob["content"]["transaction_rule"]["source"] == "user_default"


def test_domain_hash_equals_persistence_identity_input_hash():
    snap = _snapshot().validated_for_durable_use()
    domain_hash = snap.compute_content_hash()
    assert snap.content_hash == domain_hash
    version, content, source = snapshot_store_parts(snap)
    # Persistence store_settings_snapshot hashes exactly this envelope.
    persistence_identity = canonical_hash(
        {"version": version, "content": content, "source": source}
    )
    assert persistence_identity == domain_hash


def test_serialized_stored_json_rehashes_identically():
    snap = _snapshot()
    version, content, source = snapshot_store_parts(snap)
    stored_content = canonical_json(content)
    stored_source = canonical_json(source)
    # Stored normalized form re-hashes identically (idempotent canonicalization).
    assert canonical_hash(
        {"version": version, "content": stored_content, "source": stored_source}
    ) == snap.compute_content_hash()
    assert canonical_json(stored_content) == stored_content
    assert canonical_json(stored_source) == stored_source


def test_equivalent_decimal_key_order_unicode_hash_identically():
    base = _snapshot()
    base_hash = base.compute_content_hash()
    # Equivalent Decimal forms.
    assert canonical_hash({"rate": Decimal("12.50")}) == canonical_hash(
        {"rate": Decimal("12.5")}
    )
    assert canonical_hash({"rate": Decimal("1.25E+1")}) == canonical_hash(
        {"rate": Decimal("12.5")}
    )
    # Key order.
    assert canonical_hash({"a": 1, "b": 2}) == canonical_hash({"b": 2, "a": 1})
    # Unicode NFC: composed vs decomposed provenance hashes identically.
    assert canonical_hash({"s": "caf\u00e9"}) == canonical_hash(
        {"s": unicodedata.normalize("NFD", "caf\u00e9")}
    )
    # Full snapshot equivalence: same values, different Decimal spelling and
    # key order at the store-parts level still hash identically.
    version, content, source = snapshot_store_parts(base)
    content["deal"]["rounding_increment"] = Decimal("1000.00")
    reordered_source = dict(reversed(list(source.items())))
    assert canonical_hash(
        {"version": version, "content": content, "source": reordered_source}
    ) == base_hash


def test_material_provenance_differences_hash_differently():
    base_hash = _snapshot().compute_content_hash()
    assert _snapshot().compute_content_hash() == base_hash
    # Different source_timestamps -> different hash.
    assert (
        _snapshot(
            source_timestamps={"filters": "2026-09-02T00:00:00+00:00"}
        ).compute_content_hash()
        != base_hash
    )
    # Different per-rule provenance -> different hash.
    from eval_engine.contracts.settings import DealSettingsV4

    assert (
        _snapshot(
            deal=DealSettingsV4(
                source="zip", precedence="zip", version="v3"
            )
        ).compute_content_hash()
        != base_hash
    )
    # Different per-rule version -> different hash.
    assert (
        _snapshot(
            deal=DealSettingsV4(
                source="user_default", precedence="user_default", version="v4"
            )
        ).compute_content_hash()
        != base_hash
    )
    # Material value change -> different hash.
    assert (
        _snapshot(
            deal=DealSettingsV4(
                rounding_increment="500",
                source="user_default",
                precedence="user_default",
                version="v3",
            )
        ).compute_content_hash()
        != base_hash
    )


def test_result_settings_content_hash_matches_domain_and_store_identity():
    from eval_engine.contracts import CompCandidateV4, SubjectPropertyV4
    from eval_engine.contracts.deal import EvaluationRequestV4

    settings = _snapshot()
    expected = settings.compute_content_hash()
    comps = [
        CompCandidateV4(
            comp_id=f"c{i}",
            verified_sale_price="600000",
            sqft="2000",
            sale_date="2026-06-01",
            evidence_ref=f"ev-c{i}",
            is_sale=True,
        )
        for i in range(1, 4)
    ]
    request = EvaluationRequestV4(
        subject=SubjectPropertyV4(address="1 Main St", sqft="2000"),
        comps=comps,
        renovation_level="light_cosmetic",
        settings=settings,
        evaluation_date="2026-09-01",
    )
    result = evaluate_v4(request)
    assert result.status == "REVIEW_REQUIRED"
    assert result.settings_content_hash == expected
    version, content, source = snapshot_store_parts(settings)
    assert (
        canonical_hash(
            {"version": version, "content": content, "source": source}
        )
        == result.settings_content_hash
    )


def test_domain_to_persistence_status_mapping_explicit():
    assert to_persistence_status("COMPLETED") == "VALUED"
    assert DOMAIN_TO_PERSISTENCE_STATUS["COMPLETED"] == "VALUED"
    for status in (
        "REVIEW_REQUIRED",
        "INSUFFICIENT_COMPS",
        "INSUFFICIENT_INVESTOR_DATA",
        "INCOMPLETE",
        "FAILED",
    ):
        assert to_persistence_status(status) == status
    try:
        to_persistence_status("BOGUS")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown domain status must raise ValueError")
