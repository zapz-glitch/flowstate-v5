"""Evidence normalization used by selection and filters."""

from __future__ import annotations

from datetime import date, datetime


def norm_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value.isoformat()
    return str(value).strip()


def norm_lower(value: object) -> str:
    return norm_text(value).lower()


def parse_iso_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return None
    if isinstance(value, date):
        return value
    return None


def coerce_date(value: object) -> date | None:
    return parse_iso_date(value)


def sale_age_days(sale_date: object, evaluation_date: object) -> int | None:
    sale = parse_iso_date(sale_date)
    if sale is None:
        return None
    anchor = parse_iso_date(evaluation_date) or date.today()
    return (anchor - sale).days


__all__ = ["coerce_date", "norm_lower", "norm_text", "parse_iso_date", "sale_age_days"]
