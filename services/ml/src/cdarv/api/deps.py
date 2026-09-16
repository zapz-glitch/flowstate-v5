"""Service auth: the CDARV API is reached only through the apps/api
session-auth proxy — a single internal bearer token gates every route.

``CDARV_INTERNAL_API_TOKEN`` is compared in constant time against the
request's bearer credential. Nothing tenant-scoped is derived from it:
the proxy supplies user/reviewer identity explicitly in request bodies.
"""

from __future__ import annotations

import hashlib
import hmac
import os

from fastapi import Request
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from ..persistence.db import create_db_engine, database_url
from .errors import ApiFailure

_engine: Engine | None = None


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def configured_token_hash() -> str:
    token = os.environ.get("CDARV_INTERNAL_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("CDARV_INTERNAL_API_TOKEN is required")
    return _sha256(token)


def require_internal(request: Request) -> None:
    header = request.headers.get("Authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise ApiFailure("AUTH_MISSING", "authorization is required", status_code=401)
    if not hmac.compare_digest(_sha256(value.strip()), configured_token_hash()):
        raise ApiFailure("AUTH_INVALID", "invalid credential", status_code=401)


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_db_engine(database_url())
    return _engine


def get_session():
    maker = sessionmaker(bind=get_engine(), expire_on_commit=False)
    session: Session = maker()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


__all__ = ["configured_token_hash", "get_engine", "get_session", "require_internal"]
