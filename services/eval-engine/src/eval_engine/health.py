"""Health and readiness helpers for the V4 evaluation service."""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from pydantic import BaseModel, Field
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError

# Single-head migration contract for the V4 candidate runtime. Readiness
# reports ready only when the database is at this revision AND the
# persistence tables exist. Kept as module constants so tests and the
# readiness probe assert the same contract.
EXPECTED_ALEMBIC_REVISION = "0002_v4_repair"
REQUIRED_TABLES = frozenset(
    {
        "v4_settings_snapshots",
        "v4_batches",
        "v4_evaluations",
        "v4_evaluation_results",
    }
)


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


def check_schema(url: str | None = None) -> DatabaseCheck:
    """Verify the database is migrated to the expected Alembic head.

    Read-only probe: checks alembic_version.version_num equals
    EXPECTED_ALEMBIC_REVISION and that every REQUIRED_TABLES table
    exists. Returns a DatabaseCheck so readiness can surface the
    reason without leaking the URL. Never raises for missing
    tables/revisions: an unmigrated database is a not-ready state,
    not an exception.
    """
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
            try:
                revision = connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar()
            except SQLAlchemyError:
                return DatabaseCheck(
                    False, "postgresql", "database is not migrated"
                )
            if revision != EXPECTED_ALEMBIC_REVISION:
                return DatabaseCheck(
                    False,
                    "postgresql",
                    f"database is at revision {revision or 'unknown'}, "
                    f"expected {EXPECTED_ALEMBIC_REVISION}",
                )
            tables = set(inspect(connection).get_table_names())
            missing = sorted(REQUIRED_TABLES - tables)
            if missing:
                return DatabaseCheck(
                    False,
                    "postgresql",
                    f"database is missing tables: {', '.join(missing)}",
                )
    except SQLAlchemyError:
        return DatabaseCheck(False, "postgresql", "PostgreSQL is unavailable")
    finally:
        engine.dispose()

    return DatabaseCheck(True, "postgresql", "schema is migrated")


def check_readiness(url: str | None = None) -> tuple[bool, dict[str, str]]:
    db = check_database(url)
    if not db.ok:
        return False, {"database": db.detail, "schema": "not checked"}
    schema = check_schema(url)
    checks = {
        "database": "ok" if db.ok else db.detail,
        "schema": "ok" if schema.ok else schema.detail,
    }
    return schema.ok, checks
