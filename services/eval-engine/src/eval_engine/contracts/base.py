"""Shared Decimal-string primitives for V4 contracts.

Money and measured values cross JSON as decimal strings, never binary
floats. All authoritative math uses :class:`decimal.Decimal` built from
those validated strings.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Annotated, Any

from pydantic import BeforeValidator, PlainSerializer


def parse_decimal_string(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise ValueError("decimal values must be decimal strings, not booleans")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        raise ValueError("decimal values must use decimal strings, not floats")
    if isinstance(value, str):
        text = value.strip().replace(",", "").replace("_", "")
        if not text:
            raise ValueError("empty decimal string")
        try:
            parsed = Decimal(text)
        except (InvalidOperation, ValueError) as exc:
            raise ValueError(f"invalid decimal string: {value!r}") from exc
        if not parsed.is_finite():
            raise ValueError(f"non-finite decimal string: {value!r}")
        return parsed
    raise ValueError(
        "decimal values must be decimal strings, ints, or Decimals "
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
]

__all__ = ["DecimalString", "parse_decimal_string", "serialize_decimal"]
