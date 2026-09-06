"""Health and readiness helpers for the V4 evaluation service."""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError


class DatabaseHealthResponse(BaseModel):
    status: str
    database: str
    detail: str = ""


class ReadinessResponse(BaseModel):
    status: str
    ready: bool
    checks: dict[str, str] = Field(default_factory=dict)


@dataclass(frozen=True)
class DatabaseCheck:
    ok: bool
    label: str
    detail: str


def configured_database_url() -> str | None:
    raw = os.environ.get("DATABASE_URL")
    return raw.strip() if raw and raw.strip() else None


def check_database(url: str | None = None) -> DatabaseCheck:
    """Run a read-only PostgreSQL connectivity probe without leaking its URL."""
    target = url if url is not None else configured_database_url()
    if target is None:
        return DatabaseCheck(False, "postgresql", "DATABASE_URL is not configured")

    scheme = urlparse(target).scheme.lower()
    if scheme not in {"postgresql", "postgresql+psycopg"}:
        return DatabaseCheck(False, scheme or "unknown", "V4 requires PostgreSQL")

    engine = create_engine(
        target,
        pool_pre_ping=True,
        connect_args={"connect_timeout": 3},
    )
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return DatabaseCheck(False, "postgresql", "PostgreSQL is unavailable")
    finally:
        engine.dispose()

    return DatabaseCheck(True, "postgresql", "PostgreSQL connection succeeded")


def check_readiness(url: str | None = None) -> tuple[bool, dict[str, str]]:
    db = check_database(url)
    checks = {"database": "ok" if db.ok else db.detail}
    return db.ok, checks
