"""PostgreSQL-only connection helpers and strict canonical hashing."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import date, datetime, time
from decimal import Decimal
from urllib.parse import urlparse, urlunparse

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


class NonPostgreSQLError(RuntimeError):
    pass


def normalize_postgresql_url(url: str) -> str:
    """Normalize a PostgreSQL URL to the psycopg3 driver form.

    Bare ``postgresql://`` URLs are rewritten to ``postgresql+psycopg://``
    so V4 always runs on psycopg3. Anything that is not PostgreSQL
    (SQLite, psycopg2 driver qualifiers, other schemes) is rejected.
    """
    target = (url or "").strip()
    if not target:
        raise NonPostgreSQLError("DATABASE_URL is not configured")
    parts = urlparse(target)
    scheme = parts.scheme.lower()
    if scheme == "postgresql":
        parts = parts._replace(scheme="postgresql+psycopg")
        return urlunparse(parts)
    if scheme == "postgresql+psycopg":
        return target
    raise NonPostgreSQLError(f"V4 requires PostgreSQL via psycopg3, got {scheme!r}")


def require_postgresql_url(url: str | None = None) -> str:
    raw = (url if url is not None else os.environ.get("DATABASE_URL") or "").strip()
    return normalize_postgresql_url(raw)


def create_postgresql_engine(url: str | None = None, **kwargs) -> Engine:
    target = require_postgresql_url(url)
    options = {"pool_pre_ping": True}
    options.update(kwargs)
    return create_engine(target, **options)


def _canonical_decimal(value: Decimal) -> str:
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


def canonical_json(value: object) -> object:
    """Normalize a value into deterministic JSON-native form.

    Strict: mapping keys must be strings, floats must be finite, Decimals
    use textual context-independent canonicalization so equal values hash
    identically regardless of precision or trailing zeros, datetimes use
    ISO 8601, sets/bytes/arbitrary objects are rejected instead of being
    silently coerced. The stored normalized form re-hashes identically, so
    hash(payload) always equals hash(stored form).
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise TypeError("non-finite floats cannot be content-addressed")
        return value
    if isinstance(value, Decimal):
        return _canonical_decimal(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, dict):
        normalized: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("mapping keys must be strings for hashing")
            normalized[key] = canonical_json(item)
        return normalized
    if isinstance(value, (list, tuple)):
        return [canonical_json(item) for item in value]
    raise TypeError(f"unsupported type for content hashing: {type(value).__name__}")


def canonical_hash(payload: object) -> str:
    raw = json.dumps(
        canonical_json(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def verify_postgresql_only(engine: Engine) -> None:
    with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            raise NonPostgreSQLError(f"V4 requires PostgreSQL, got {dialect!r}")
        conn.execute(text("SELECT 1"))
