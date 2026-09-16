"""CDARV feature extraction — feature-spec v2.

Design rules (from the CDARV spec):

1. Model inputs are property/market facts only. Evaluator outputs
   (`is_enabled`, filter pass/fail, adjustment amounts, report ordering,
   `isBestMatch`) are rule echoes — stored on the snapshot for diagnostics
   and agreement metrics, but excluded from model inputs by default so the
   model cannot take a shortcut by copying the system it should improve.

2. Cotality AVM fields are research-only. Nothing under `subject.avm` may
   influence features, labels, ranking, or gates.

3. The comp's condition is compared against the subject's INTENDED
   finished condition (the report's renovation target), not the subject's
   current distressed state.

4. Unknown stays unknown: match features carry `_known` indicators and
   continuous features stay NaN — imputed at train time, surfaced as data
   gaps in monitoring.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from ..reports import CandidateComp, ReportSnapshot

FEATURE_SPEC_VERSION = "v2"

_NAN = float("nan")

FEATURE_NAMES: list[str] = [
    # Geography
    "distance_miles",
    "same_subdivision", "same_subdivision_known",
    "same_neighborhood", "same_neighborhood_known",
    "same_street",
    # Size / physical similarity
    "sqft_diff_abs", "sqft_diff_pct", "comp_sqft",
    "beds_diff_abs", "baths_diff_abs",
    "year_built_diff_abs",
    "lot_sqft_diff_abs",
    "stories_diff_abs", "stories_known",
    "pool_match", "pool_known",
    "garage_match", "garage_known",
    "building_style_same", "building_style_known",
    "condition_tier",
    # Market
    "sale_age_days",
    "sale_price_log",
    "price_per_sqft",
    "ppsf_diff",
    # Renovation target (comp condition vs INTENDED finished state)
    "target_rehab_level_index",
    "comp_renovated_evidence",
    "comp_classification_known",
    # Listing evidence
    "photo_count",
    # Subject context
    "subject_sqft",
    "subject_year_built",
    "subject_last_ppsf",
]

# Evaluator fields retained for diagnostics only — never model inputs.
RULE_ECHO_FIELDS = (
    "is_enabled", "evaluator_selected", "filter_passed_count",
    "filter_failed_count", "total_adjustment", "rank_in_report",
    "is_best_match",
)


_STORIES_WORDS = {
    "ONE": 1.0, "1": 1.0, "ONE AND ONE-HALF": 1.5, "1.5": 1.5,
    "TWO": 2.0, "2": 2.0, "TWO AND ONE-HALF": 2.5, "2.5": 2.5,
    "THREE": 3.0, "3": 3.0, "SPLIT LEVEL": 1.5, "BI-LEVEL": 1.5,
}

_CONDITION_TIER = {
    "POOR": 0.0, "POR": 0.0,
    "FAIR": 1.0, "FAI": 1.0,
    "AVE": 2.0, "AVERAGE": 2.0,
    "GD": 3.0, "GOOD": 3.0,
    "VGD": 4.0, "VGOOD": 4.0,
    "EXC": 5.0, "EXCELLENT": 5.0,
}


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else _NAN


def _text(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _norm_text(v: Any) -> str | None:
    t = _text(v)
    return " ".join(t.lower().split()) if t else None


def _parse_date(value: Any) -> datetime | None:
    t = _text(value)
    if not t:
        return None
    try:
        if re.fullmatch(r"\d{8}", t):
            return datetime(int(t[:4]), int(t[4:6]), int(t[6:8]), tzinfo=timezone.utc)
        dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _street_name(address: Any) -> str | None:
    t = _norm_text(address)
    if not t:
        return None
    return re.sub(r"^\d+\s*", "", t.split(",")[0]).strip() or None


def _stories(v: Any) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    t = _text(v)
    if t:
        up = t.upper().strip()
        if up in _STORIES_WORDS:
            return _STORIES_WORDS[up]
        try:
            return float(up)
        except ValueError:
            return _NAN
    return _NAN


def _has(v: Any) -> float:
    return 1.0 if _text(v) else 0.0


def _match_flag(a: Any, b: Any) -> tuple[float, float]:
    s, c = _norm_text(a), _norm_text(b)
    if s is None or c is None:
        return 0.0, 0.0
    return (1.0 if s == c else 0.0), 1.0


def extract_comp_features(report: ReportSnapshot, comp: CandidateComp) -> dict[str, float]:
    """Feature-spec v2 vector for one candidate comp."""
    s, c = report.subject, comp.raw
    prov = report.provenance
    f: dict[str, float] = {}

    # ── Geography ─────────────────────────────────────────────────────────
    f["distance_miles"] = _num(c.get("distanceMiles"))
    f["same_subdivision"], f["same_subdivision_known"] = _match_flag(
        s.get("subdivision"), c.get("subdivision"))
    f["same_neighborhood"], f["same_neighborhood_known"] = _match_flag(
        s.get("neighborhoodCode") or s.get("neighborhoodName"),
        c.get("neighborhoodCode") or c.get("neighborhoodName"))
    s_street, c_street = _street_name(s.get("address")), _street_name(c.get("address"))
    f["same_street"] = 1.0 if s_street and c_street and s_street == c_street else 0.0

    # ── Size / physical ───────────────────────────────────────────────────
    s_sqft, c_sqft = _num(s.get("squareFeet")), _num(c.get("squareFeet"))
    f["comp_sqft"] = c_sqft
    if not math.isnan(s_sqft) and not math.isnan(c_sqft) and s_sqft > 0:
        f["sqft_diff_abs"] = abs(c_sqft - s_sqft)
        f["sqft_diff_pct"] = abs(c_sqft - s_sqft) / s_sqft
    else:
        f["sqft_diff_abs"] = f["sqft_diff_pct"] = _NAN

    s_beds, c_beds = _num(s.get("bedrooms")), _num(c.get("bedrooms"))
    s_baths, c_baths = _num(s.get("bathrooms")), _num(c.get("bathrooms"))
    f["beds_diff_abs"] = abs(c_beds - s_beds) if not (math.isnan(s_beds) or math.isnan(c_beds)) else _NAN
    f["baths_diff_abs"] = abs(c_baths - s_baths) if not (math.isnan(s_baths) or math.isnan(c_baths)) else _NAN

    s_year, c_year = _num(s.get("yearBuilt")), _num(c.get("yearBuilt"))
    f["year_built_diff_abs"] = abs(c_year - s_year) if not (math.isnan(s_year) or math.isnan(c_year)) else _NAN

    s_lot, c_lot = _num(s.get("lotSizeAcres")), _num(c.get("lotSizeAcres"))
    f["lot_sqft_diff_abs"] = (
        abs(c_lot - s_lot) * 43560.0 if not (math.isnan(s_lot) or math.isnan(c_lot)) else _NAN
    )

    s_stories = _stories(s.get("storiesType") or s.get("stories"))
    c_stories = _stories(c.get("stories") or c.get("storiesType"))
    f["stories_known"] = 0.0 if (math.isnan(s_stories) or math.isnan(c_stories)) else 1.0
    f["stories_diff_abs"] = abs(c_stories - s_stories) if f["stories_known"] else _NAN

    f["pool_match"], f["pool_known"] = (
        (1.0 if _has(s.get("pool")) == _has(c.get("pool")) else 0.0), 1.0
    )
    f["garage_match"], f["garage_known"] = (
        (1.0 if _has(s.get("garage") or s.get("carport"))
                == _has(c.get("garage") or c.get("carport")) else 0.0), 1.0
    )
    f["building_style_same"], f["building_style_known"] = _match_flag(
        s.get("buildingStyle"), c.get("buildingStyle"))
    f["condition_tier"] = _CONDITION_TIER.get(
        (_text(c.get("buildingCondition")) or "").upper(), _NAN)

    # ── Market ────────────────────────────────────────────────────────────
    ref_date = _parse_date(report.created_at)
    sale_date = _parse_date(c.get("saleDate"))
    if ref_date and sale_date:
        age = (ref_date - sale_date).days
        f["sale_age_days"] = float(age) if age >= 0 else _NAN
    else:
        f["sale_age_days"] = _NAN

    sale_price = _num(c.get("salePrice"))
    f["sale_price_log"] = math.log(sale_price) if sale_price and sale_price > 0 else _NAN
    f["price_per_sqft"] = _num(c.get("pricePerSqft"))

    s_last_ppsf = _NAN
    last_sale = s.get("lastSale")
    if isinstance(last_sale, dict):
        s_last_ppsf = _num(last_sale.get("pricePerSqft"))
    f["ppsf_diff"] = (
        f["price_per_sqft"] - s_last_ppsf
        if not math.isnan(s_last_ppsf) and not math.isnan(f["price_per_sqft"])
        else _NAN
    )

    # ── Renovation target: comp condition vs intended finished state ──────
    level = prov.get("rehab_level_index")
    f["target_rehab_level_index"] = float(level) if isinstance(level, int) else _NAN
    c_class = c.get("classification") if isinstance(c.get("classification"), dict) else None
    c_type = _norm_text(c_class.get("type")) if c_class else None
    f["comp_classification_known"] = 1.0 if c_type else 0.0
    f["comp_renovated_evidence"] = 1.0 if c_type == "after_renovation" else 0.0

    # ── Listing evidence / subject context ────────────────────────────────
    photos = c.get("photos")
    f["photo_count"] = float(len(photos)) if isinstance(photos, list) else 0.0
    f["subject_sqft"] = s_sqft
    f["subject_year_built"] = s_year
    f["subject_last_ppsf"] = s_last_ppsf

    return {name: f.get(name, _NAN) for name in FEATURE_NAMES}


def extract_rule_context(report: ReportSnapshot, comp: CandidateComp) -> dict[str, Any]:
    """Evaluator outputs kept for diagnostics — NOT model inputs."""
    rules = comp.raw.get("appraisalRules") if isinstance(comp.raw.get("appraisalRules"), dict) else {}
    filters = rules.get("filters") if isinstance(rules.get("filters"), list) else []
    return {
        "is_enabled": comp.is_enabled,
        "evaluator_selected": comp.evaluator_selected,
        "evaluator_group": comp.group,
        "filter_passed_count": sum(
            1 for x in filters
            if isinstance(x, dict) and (x.get("status") == "passed" or x.get("passed") is True)
        ),
        "filter_failed_count": sum(
            1 for x in filters
            if isinstance(x, dict) and (x.get("status") == "failed" or x.get("passed") is False)
        ),
        "total_adjustment": rules.get("totalAdjustment"),
        "rank_in_report": comp.rank_in_report,
        "is_best_match": bool(comp.raw.get("isBestMatch")),
    }


__all__ = [
    "FEATURE_NAMES", "FEATURE_SPEC_VERSION", "RULE_ECHO_FIELDS",
    "extract_comp_features", "extract_rule_context",
]
