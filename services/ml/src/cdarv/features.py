"""Per-comp feature extraction for comp-selection learning.

Every feature is derivable from data present on the report BEFORE the
final selection is applied, so the same extraction runs unchanged at
shadow-prediction time. Post-selection fields (`compGroup`, the selected
id lists, `isBestMatch`, `valuation.*`) are labels or downstream outputs
and are never used as features.

Convention: continuous features use NaN for unknown; the model pipeline
median-imputes. Match-style booleans emit a paired ``<name>_known``
indicator so "unverified" stays distinct from "mismatch".
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from .reports import CandidateComp, IdealReport

# All appraisal filter types emitted by the production evaluator
# (apps/api/src/services/appraisal/types.ts — FilterType).
FILTER_TYPES: tuple[str, ...] = (
    "subdivision_match",
    "neighborhood_match",
    "building_style_match",
    "foundation_match",
    "construction_material_match",
    "pool_match",
    "garage_match",
    "stories_match",
    "roof_material_match",
    "condition_match",
    "sale_age",
    "sqft_diff",
    "year_built_diff",
    "distance",
    "property_type",
    "lot_size_diff",
    "road_barrier",
)

_NAN = float("nan")

FEATURE_NAMES: list[str] = [
    # Geography
    "distance_miles",
    "same_subdivision", "same_subdivision_known",
    "same_neighborhood", "same_neighborhood_known",
    "same_street",
    # Size / physical similarity
    "sqft_diff", "sqft_diff_abs", "sqft_diff_pct",
    "comp_sqft",
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
    "adjusted_price_log",
    "adjustment_total",
    "adjustment_total_abs",
    "adjustment_count",
    "adjustment_pct",
    # Pipeline evaluation (pre-selection signals)
    "is_enabled",
    "filters_passed_count",
    "filters_failed_count",
    "filters_unverified_count",
    # Classification / photos
    "comp_classified",
    "classification_match", "classification_known",
    "photo_count",
    "rank_in_report",
    # Subject context (broadcast)
    "subject_sqft",
    "subject_year_built",
    "subject_last_ppsf",
] + [f"f_{t}" for t in FILTER_TYPES]


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
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


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
    """First address segment minus the house number, for same-street checks."""
    t = _norm_text(address)
    if not t:
        return None
    first = t.split(",")[0]
    return re.sub(r"^\d+\s*", "", first).strip() or None


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


def _match_flag(subject_val: Any, comp_val: Any) -> tuple[float, float]:
    """Return (match, known): known=1 only when both sides carry a value."""
    s, c = _norm_text(subject_val), _norm_text(comp_val)
    if s is None or c is None:
        return 0.0, 0.0
    return (1.0 if s == c else 0.0), 1.0


def _presence_match(subject_val: Any, comp_val: Any) -> tuple[float, float]:
    """For pool/garage: presence-vs-presence. Known when either side states a value."""
    s, c = _has(subject_val), _has(comp_val)
    # 'unknown' only when both absent — a comp with no recorded pool may still
    # have one, so both-absent is recorded as a weak match, not verified.
    return (1.0 if s == c else 0.0), 1.0


def _filter_scores(comp: CandidateComp) -> dict[str, float]:
    """One score per filter type: +1 passed, -1 failed, 0 not_verified/missing."""
    rules = comp.raw.get("appraisalRules")
    scores = {t: 0.0 for t in FILTER_TYPES}
    if not isinstance(rules, dict):
        return scores
    filters = rules.get("filters")
    if not isinstance(filters, list):
        return scores
    for f in filters:
        if not isinstance(f, dict):
            continue
        ftype = f.get("type")
        if ftype not in scores:
            continue
        status = f.get("status")
        if status == "passed" or (status is None and f.get("passed") is True):
            scores[ftype] = 1.0
        elif status == "failed" or (status is None and f.get("passed") is False):
            scores[ftype] = -1.0
    return scores


def extract_comp_features(report: IdealReport, comp: CandidateComp) -> dict[str, float]:
    s, c = report.subject, comp.raw
    f: dict[str, float] = {}

    # ── Geography ────────────────────────────────────────────────────────────
    f["distance_miles"] = _num(c.get("distanceMiles"))
    sub_m, sub_k = _match_flag(s.get("subdivision"), c.get("subdivision"))
    nb_m, nb_k = _match_flag(
        s.get("neighborhoodCode") or s.get("neighborhoodName"),
        c.get("neighborhoodCode") or c.get("neighborhoodName"),
    )
    f["same_subdivision"], f["same_subdivision_known"] = sub_m, sub_k
    f["same_neighborhood"], f["same_neighborhood_known"] = nb_m, nb_k
    s_street, c_street = _street_name(s.get("address")), _street_name(c.get("address"))
    f["same_street"] = 1.0 if s_street and c_street and s_street == c_street else 0.0

    # ── Size / physical similarity ───────────────────────────────────────────
    s_sqft, c_sqft = _num(s.get("squareFeet")), _num(c.get("squareFeet"))
    f["comp_sqft"] = c_sqft
    if not math.isnan(s_sqft) and not math.isnan(c_sqft) and s_sqft > 0:
        f["sqft_diff"] = c_sqft - s_sqft
        f["sqft_diff_abs"] = abs(c_sqft - s_sqft)
        f["sqft_diff_pct"] = abs(c_sqft - s_sqft) / s_sqft
    else:
        f["sqft_diff"] = f["sqft_diff_abs"] = f["sqft_diff_pct"] = _NAN

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
    f["stories_diff_abs"] = (
        abs(c_stories - s_stories) if f["stories_known"] else _NAN
    )

    f["pool_match"], f["pool_known"] = _presence_match(s.get("pool"), c.get("pool"))
    f["garage_match"], f["garage_known"] = _presence_match(
        s.get("garage") or s.get("carport"), c.get("garage") or c.get("carport")
    )
    bs_m, bs_k = _match_flag(s.get("buildingStyle"), c.get("buildingStyle"))
    f["building_style_same"], f["building_style_known"] = bs_m, bs_k
    f["condition_tier"] = _CONDITION_TIER.get((_text(c.get("buildingCondition")) or "").upper(), _NAN)

    # ── Market ───────────────────────────────────────────────────────────────
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
    if not math.isnan(s_last_ppsf) and not math.isnan(f["price_per_sqft"]):
        f["ppsf_diff"] = f["price_per_sqft"] - s_last_ppsf
    else:
        f["ppsf_diff"] = _NAN

    adj_price = _num(c.get("adjustedPrice"))
    f["adjusted_price_log"] = math.log(adj_price) if adj_price and adj_price > 0 else _NAN

    rules = c.get("appraisalRules") if isinstance(c.get("appraisalRules"), dict) else {}
    total_adj = _num(rules.get("totalAdjustment"))
    f["adjustment_total"] = total_adj
    f["adjustment_total_abs"] = abs(total_adj) if not math.isnan(total_adj) else _NAN
    adjustments = rules.get("adjustments")
    f["adjustment_count"] = float(len(adjustments)) if isinstance(adjustments, list) else 0.0
    f["adjustment_pct"] = (
        abs(total_adj) / sale_price
        if not math.isnan(total_adj) and sale_price and sale_price > 0
        else _NAN
    )

    # ── Pipeline evaluation ──────────────────────────────────────────────────
    f["is_enabled"] = 1.0 if comp.is_enabled else 0.0
    fscores = _filter_scores(comp)
    f["filters_passed_count"] = float(sum(1 for v in fscores.values() if v > 0))
    f["filters_failed_count"] = float(sum(1 for v in fscores.values() if v < 0))
    f["filters_unverified_count"] = float(len(fscores) - f["filters_passed_count"] - f["filters_failed_count"])

    # ── Classification / photos ──────────────────────────────────────────────
    c_class = c.get("classification") if isinstance(c.get("classification"), dict) else None
    s_class = s.get("classification") if isinstance(s.get("classification"), dict) else None
    c_type = _norm_text(c_class.get("type")) if c_class else None
    s_type = _norm_text(s_class.get("type")) if s_class else None
    f["comp_classified"] = 1.0 if c_type else 0.0
    f["classification_known"] = 1.0 if (c_type and s_type) else 0.0
    f["classification_match"] = 1.0 if (c_type and s_type and c_type == s_type) else 0.0
    photos = c.get("photos")
    f["photo_count"] = float(len(photos)) if isinstance(photos, list) else 0.0
    f["rank_in_report"] = float(comp.rank_in_report)

    # ── Subject context ──────────────────────────────────────────────────────
    f["subject_sqft"] = s_sqft
    f["subject_year_built"] = s_year
    f["subject_last_ppsf"] = s_last_ppsf

    for t in FILTER_TYPES:
        f[f"f_{t}"] = fscores[t]

    return {name: f.get(name, _NAN) for name in FEATURE_NAMES}


__all__ = ["FEATURE_NAMES", "FILTER_TYPES", "extract_comp_features"]
