"""Shared Decimal-string primitives for V4 contracts.

Request JSON decimals are strings only. Grammar (after trim)::

    [+-]? ( DIGITS [ "." DIGITS* ] | "." DIGITS ) ([eE] [+-]? DIGITS)?

Commas, underscores, and interior whitespace are rejected. JSON numbers
(int/float), booleans, and empty strings are rejected. Programmatic
``Decimal`` instances are accepted for internal use but always serialize
back to plain fixed-point strings.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import date, datetime, time
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


def canonical_decimal(value: Decimal) -> str:
    """Render a Decimal textually without consulting the decimal context.

    Built purely from ``as_tuple`` so the output is identical under any
    active ``localcontext`` precision. Trailing zeros are stripped, so
    Decimal("12.50"), Decimal("12.5"), and Decimal("1.25E+1") all render
    as "12.5" and hash identically. Non-finite values are rejected.
    """
    if not value.is_finite():
        raise TypeError("non-finite decimals cannot be content-addressed")
    sign, digits, exponent = value.as_tuple()
    raw = "".join(str(digit) for digit in digits)
    stripped = raw.rstrip("0")
    if not stripped:
        return "0"
    shift = exponent + (len(raw) - len(stripped))
    if shift >= 0:
        out = stripped + "0" * shift
    elif len(stripped) > -shift:
        cut = len(stripped) + shift
        out = stripped[:cut] + "." + stripped[cut:]
    else:
        out = "0." + "0" * (-shift - len(stripped)) + stripped
    if sign:
        out = "-" + out
    return out


def canonical_json(value: Any) -> Any:
    """Normalize a value into deterministic JSON-native form.

    Strict: mapping keys must be strings, floats must be finite, Decimals
    use textual context-independent canonicalization so equal values hash
    identically regardless of precision or trailing zeros, datetimes use
    ISO 8601, strings use Unicode NFC so composed/decomposed forms hash
    identically, sets/bytes/arbitrary objects are rejected instead of
    being silently coerced. Key order is normalized by the JSON dump
    (sort_keys); mappings whose keys collide after NFC normalization are
    rejected rather than silently merged.
    """
    if value is None or isinstance(value, (bool, int, str)):
        if isinstance(value, str):
            return unicodedata.normalize("NFC", value)
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise TypeError("non-finite floats cannot be content-addressed")
        return value
    if isinstance(value, Decimal):
        return canonical_decimal(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("mapping keys must be strings for hashing")
            nfc_key = unicodedata.normalize("NFC", key)
            if nfc_key in normalized:
                raise TypeError("mapping keys collide after NFC normalization")
            normalized[nfc_key] = canonical_json(item)
        return normalized
    if isinstance(value, (list, tuple)):
        return [canonical_json(item) for item in value]
    raise TypeError(f"unsupported type for content hashing: {type(value).__name__}")


def canonical_hash(payload: Any) -> str:
    """SHA-256 over compact sorted-key canonical JSON (UTF-8, unescaped)."""
    raw = json.dumps(
        canonical_json(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [
    "DECIMAL_PATTERN",
    "DecimalString",
    "canonical_decimal",
    "canonical_hash",
    "canonical_json",
    "parse_decimal_string",
    "serialize_decimal",
]
