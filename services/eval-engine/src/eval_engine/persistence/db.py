"""PostgreSQL-only connection helpers and strict canonical hashing."""
from __future__ import annotations

import os
from urllib.parse import urlparse, urlunparse

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from ..contracts.base import canonical_decimal, canonical_hash, canonical_json

__all__ = [
    "NonPostgreSQLError",
    "canonical_decimal",
    "canonical_hash",
    "canonical_json",
    "create_postgresql_engine",
    "normalize_postgresql_url",
    "require_postgresql_url",
    "verify_postgresql_only",
]


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


# Canonical JSON/hash helpers live in contracts.base (the single shared
# implementation); they are re-exported here so persistence call sites
# keep working without importing contracts directly.
_CANONICAL_REEXPORT_NOTE = (
    "canonical_decimal/canonical_hash/canonical_json are imported "
    "from eval_engine.contracts.base"
)


def verify_postgresql_only(engine: Engine) -> None:
    with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            raise NonPostgreSQLError(f"V4 requires PostgreSQL, got {dialect!r}")
        conn.execute(text("SELECT 1"))
