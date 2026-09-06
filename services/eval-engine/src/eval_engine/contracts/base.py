"""Shared Decimal-string primitives for V4 contracts.

Request JSON decimals are strings only. Grammar (after trim)::

    [+-]? ( DIGITS [ "." DIGITS* ] | "." DIGITS ) ([eE] [+-]? DIGITS)?

Commas, underscores, and interior whitespace are rejected. JSON numbers
(int/float), booleans, and empty strings are rejected. Programmatic
``Decimal`` instances are accepted for internal use but always serialize
back to plain fixed-point strings.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any

from pydantic import BeforeValidator, PlainSerializer, WithJsonSchema

DECIMAL_PATTERN = r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$"
_DECIMAL_RE = re.compile(DECIMAL_PATTERN)
_DECIMAL_JSON_SCHEMA = {
    "type": "string",
    "pattern": DECIMAL_PATTERN,
    "description": (
        "Decimal as JSON string. Grammar: "
        "[+-]? (DIGITS ['.' DIGITS*] | '.' DIGITS) ([eE] [+-]? DIGITS)? "
        "Separators and JSON numbers are rejected."
    ),
}


def parse_decimal_string(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("non-finite decimal")
        return value
    if isinstance(value, bool):
        raise ValueError("decimal values must be JSON decimal strings, not booleans")
    if isinstance(value, (int, float)):
        raise ValueError("decimal values must be JSON decimal strings, not numbers")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError("empty decimal string")
        if "," in text or "_" in text or " " in text or "\t" in text:
            raise ValueError(
                f"invalid decimal string (separators not allowed): {value!r}"
            )
        if _DECIMAL_RE.match(text) is None:
            raise ValueError(f"invalid decimal string: {value!r}")
        try:
            parsed = Decimal(text)
        except (InvalidOperation, ValueError) as exc:
            raise ValueError(f"invalid decimal string: {value!r}") from exc
        if not parsed.is_finite():
            raise ValueError(f"non-finite decimal string: {value!r}")
        return parsed
    raise ValueError(
        "decimal values must be JSON decimal strings "
        f"(got {type(value).__name__})"
    )


def serialize_decimal(value: Decimal) -> str:
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return format(value, "f")


DecimalString = Annotated[
    Decimal,
    BeforeValidator(parse_decimal_string),
    PlainSerializer(serialize_decimal, return_type=str),
    WithJsonSchema(_DECIMAL_JSON_SCHEMA),
]

__all__ = [
    "DECIMAL_PATTERN",
    "DecimalString",
    "parse_decimal_string",
    "serialize_decimal",
]
