"""Strict date contract: YYYY-MM-DD strings only on JSON.

Native ``datetime.date`` values are allowed for internal/programmatic use.
``datetime.datetime`` is rejected (date and time must not mix). No format
normalization: ``YYYY/MM/DD``, ``YYYYMMDD``, datetimes, and impossible
calendar dates fail validation.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Any

from pydantic import BeforeValidator

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
_DATE_RE = re.compile(DATE_PATTERN)


def parse_full_date(value: Any) -> date:
    if isinstance(value, datetime):
        raise ValueError("datetimes are rejected; supply a YYYY-MM-DD date")
    if isinstance(value, date):
        return value
    if isinstance(value, bool):
        raise ValueError("dates must be YYYY-MM-DD strings, not booleans")
    if isinstance(value, (int, float)):
        raise ValueError("dates must be YYYY-MM-DD strings, not numbers")
    if not isinstance(value, str):
        raise ValueError(f"dates must be YYYY-MM-DD strings (got {type(value).__name__})")
    text = value.strip()
    if _DATE_RE.match(text) is None:
        raise ValueError(f"invalid date (YYYY-MM-DD only): {value!r}")
    year, month, day = int(text[0:4]), int(text[5:7]), int(text[8:10])
    try:
        parsed = date(year, month, day)
    except ValueError as exc:
        raise ValueError(f"invalid calendar date: {value!r}") from exc
    if parsed.isoformat() != text:
        raise ValueError(f"invalid calendar date: {value!r}")
    return parsed


def parse_optional_full_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        raise ValueError("empty date string")
    return parse_full_date(value)


StrictDate = Annotated[date, BeforeValidator(parse_full_date)]
OptionalStrictDate = Annotated[date | None, BeforeValidator(parse_optional_full_date)]

__all__ = [
    "DATE_PATTERN",
    "OptionalStrictDate",
    "StrictDate",
    "parse_full_date",
    "parse_optional_full_date",
]
