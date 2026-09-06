"""Shared hashing and PostgreSQL-only connection helpers."""
from __future__ import annotations

import hashlib
import json
import os
from urllib.parse import urlparse

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


class NonPostgreSQLError(RuntimeError):
    pass


def require_postgresql_url(url: str | None = None) -> str:
    target = (url if url is not None else os.environ.get("DATABASE_URL") or "").strip()
    if not target:
        raise NonPostgreSQLError("DATABASE_URL is not configured")
    scheme = urlparse(target).scheme.lower()
    if scheme not in {"postgresql", "postgresql+psycopg"}:
        raise NonPostgreSQLError(f"V4 requires PostgreSQL, got scheme {scheme!r}")
    return target


def create_postgresql_engine(url: str | None = None, **kwargs) -> Engine:
    target = require_postgresql_url(url)
    options = {"pool_pre_ping": True}
    options.update(kwargs)
    return create_engine(target, **options)


def canonical_hash(payload: object) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def verify_postgresql_only(engine: Engine) -> None:
    with engine.connect() as conn:
        dialect = conn.dialect.name
        if dialect != "postgresql":
            raise NonPostgreSQLError(f"V4 requires PostgreSQL, got {dialect!r}")
        conn.execute(text("SELECT 1"))
