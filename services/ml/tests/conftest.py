"""Shared fixtures: synthetic ideal reports in the real full_response_json shape."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import cdarv  # noqa: E402  — verifies package import after sys.path fix


def make_comp(
    comp_id: str,
    *,
    distance: float = 0.4,
    sale_price: float = 200_000,
    sqft: float = 1500,
    sale_date: str = "2026-06-01",
    is_enabled: bool = True,
    group: str | None = None,
    beds: int = 3,
    baths: float = 2.0,
    year: int = 1985,
    subdivision: str = "OAK PARK",
    passed: bool = True,
) -> dict:
    """A comp item in the production response shape."""
    filters = [
        {"type": t, "passed": passed, "status": "passed" if passed else "failed"}
        for t in ("subdivision_match", "sale_age", "sqft_diff", "distance", "property_type")
    ]
    return {
        "id": comp_id,
        "address": f"12{comp_id[-1]} Elm St, Austin, TX",
        "latitude": 30.26,
        "longitude": -97.74,
        "salePrice": sale_price,
        "saleDate": sale_date,
        "squareFeet": sqft,
        "pricePerSqft": round(sale_price / sqft),
        "distanceMiles": distance,
        "bedrooms": beds,
        "bathrooms": baths,
        "bedsBaths": f"{beds}/{baths}",
        "yearBuilt": year,
        "lotSizeAcres": 0.18,
        "adjustedPrice": sale_price,
        "photos": [f"https://example.com/{comp_id}/1.jpg"],
        "subdivision": subdivision,
        "neighborhoodName": "Oak Park",
        "neighborhoodCode": "OPK",
        "buildingCondition": "AVE",
        "stories": 1,
        "isEnabled": is_enabled,
        "compGroup": group,
        "isBestMatch": False,
        "appraisalRules": {
            "passedFilters": passed,
            "totalAdjustment": 0.0,
            "filters": filters,
            "adjustments": [],
        },
        "classification": {"type": "after_renovation", "confidence": 0.9},
    }


def make_report(report_id: str, *, n_comps: int = 8, created_at: str = "2026-09-01T00:00:00Z") -> dict:
    """A full_response_json-shaped payload.

    Selection rule planted for tests: comps within 0.3 miles AND enabled
    are the ARV selection — deterministic and learnable.
    """
    items = []
    arv_ids: list[str] = []
    for i in range(n_comps):
        near = i < 3  # first 3 comps are the close ones
        comp = make_comp(
            f"{report_id}-c{i}",
            distance=0.1 + 0.05 * i if near else 0.6 + 0.1 * i,
            sqft=1500 + i * 10,
            group="arv" if near else None,
        )
        if near:
            arv_ids.append(comp["id"])
        items.append(comp)

    return {
        "subject": {
            "id": f"subj-{report_id}",
            "address": f"100 Main St, Austin, TX 78704",
            "latitude": 30.26,
            "longitude": -97.74,
            "bedrooms": 3,
            "bathrooms": 2,
            "squareFeet": 1500,
            "lotSizeAcres": 0.2,
            "yearBuilt": 1985,
            "subdivision": "OAK PARK",
            "neighborhoodCode": "OPK",
            "neighborhoodName": "Oak Park",
            "buildingCondition": "AVE",
            "storiesType": "ONE",
            "buildingStyle": "Ranch",
            "lastSale": {"price": 180000, "date": "2020-01-01", "pricePerSqft": 120},
            "classification": {"type": "after_renovation", "confidence": 0.8},
        },
        "valuation": {
            "arv": 260000,
            "arvPerSqft": 173,
            "buyPrice": 150000,
            "recommendation": "BUY",
        },
        "comps": {
            "total": n_comps,
            "enabledCount": n_comps,
            "disabledCount": 0,
            "afterRenovationCompIds": arv_ids,
            "asIsCompIds": [],
            "items": items,
        },
        "riskFlags": None,
    }


@pytest.fixture
def report_payload() -> dict:
    return make_report("r1")


@pytest.fixture
def d1_file(tmp_path: Path) -> Path:
    """A SQLite file mimicking the prod saved_reports table."""
    path = tmp_path / "d1.sqlite"
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE saved_reports (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, api_key_id TEXT,
            property_address TEXT NOT NULL, property_city TEXT NOT NULL,
            property_state TEXT NOT NULL, property_zip TEXT,
            property_clip TEXT, property_data TEXT, comparables_data TEXT,
            valuation_data TEXT, full_response_json TEXT,
            arv REAL, as_is_value REAL, max_allowable_offer REAL,
            estimated_repairs REAL, job_id TEXT, pdf_key TEXT,
            is_shared INTEGER NOT NULL DEFAULT 0, share_password_hash TEXT,
            feedback_status TEXT, feedback_notes TEXT, feedback_report TEXT,
            feedback_at TEXT, created_at TEXT NOT NULL
        )"""
    )
    conn.commit()
    conn.close()
    return path


def insert_saved_report(d1_path: Path, report_id: str, payload: dict, *,
                        feedback: str = "validated",
                        created_at: str = "2026-09-01T00:00:00Z",
                        user_id: str = "u1") -> None:
    conn = sqlite3.connect(d1_path)
    conn.execute(
        """INSERT INTO saved_reports
           (id, user_id, property_address, property_city, property_state,
            full_response_json, job_id, feedback_status, feedback_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (report_id, user_id, "100 Main St", "Austin", "TX",
         json.dumps(payload), f"job_{report_id}", feedback, created_at, created_at),
    )
    conn.commit()
    conn.close()
