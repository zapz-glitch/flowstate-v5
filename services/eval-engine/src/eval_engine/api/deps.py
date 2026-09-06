"""Auth/session dependencies: tenant/user derived from credential."""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from ..persistence.db import create_postgresql_engine, require_postgresql_url
from .auth import Credential, load_credentials, match_credential
from .errors import ApiFailure

_engine = None


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    user_id: str
    rotated: bool = False


def configured_credentials() -> list[Credential]:
    candidates = load_credentials()
    if not candidates:
        raise RuntimeError("V4 API credentials are required: set V4_API_CREDENTIALS or V4_INTERNAL_API_TOKEN")
    return candidates


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    if not header:
        raise ApiFailure("AUTH_MISSING", "authorization is required", status_code=401)
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise ApiFailure("AUTH_MISSING", "authorization is required", status_code=401)
    return value.strip()


def require_principal(request: Request) -> Principal:
    candidates = configured_credentials()
    token = _bearer_token(request)
    record = match_credential(candidates, token)
    if record is None:
        raise ApiFailure("AUTH_INVALID", "invalid credential", status_code=401)
    return Principal(tenant_id=record.tenant_id, user_id=record.user_id)


def get_engine():
    global _engine
    if _engine is None:
        url = require_postgresql_url(os.environ.get("DATABASE_URL"))
        _engine = create_postgresql_engine(url)
    return _engine


def get_session():
    from sqlalchemy.orm import sessionmaker

    maker = sessionmaker(bind=get_engine(), expire_on_commit=False)
    session: Session = maker()
    try:
        yield session
    finally:
        session.close()


__all__ = ["Principal", "configured_credentials", "get_engine", "get_session", "require_principal"]
