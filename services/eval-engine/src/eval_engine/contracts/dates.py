"""Strict full-date parsing without slicing fallbacks."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any

from pydantic import BeforeValidator


def parse_full_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, bool):
        raise ValueError("dates must be full ISO calendar dates, not booleans")
    if isinstance(value, (int, float)):
        raise ValueError("dates must be full ISO calendar dates, not numbers")
    if not isinstance(value, str):
        raise ValueError(f"dates must be full ISO calendar dates (got {type(value).__name__})")
    text = value.strip()
    if not text:
        raise ValueError("empty date string")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    for fmt in ("%Y/%m/%d", "%Y%m%d"):
        try:
            parsed = datetime.strptime(text, fmt).date()
        except ValueError:
            continue
        if parsed.strftime(fmt) == text:
            return parsed
    raise ValueError(f"invalid full calendar date: {value!r}")


def parse_optional_full_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        raise ValueError("empty date string")
    return parse_full_date(value)


StrictDate = Annotated[date, BeforeValidator(parse_full_date)]
OptionalStrictDate = Annotated[date | None, BeforeValidator(parse_optional_full_date)]

__all__ = ["OptionalStrictDate", "StrictDate", "parse_full_date", "parse_optional_full_date"]
