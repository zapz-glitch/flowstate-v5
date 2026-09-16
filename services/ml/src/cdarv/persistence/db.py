"""Engine/session construction for CDARV persistence.

Production requires PostgreSQL via CDARV_DATABASE_URL (or DATABASE_URL).
SQLite is accepted only under CDARV_TEST_PROFILE=true — it exists for
unit tests and local exploration, never for the deployed queue.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


def database_url() -> str:
    url = os.environ.get("CDARV_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("CDARV_DATABASE_URL (or DATABASE_URL) is required")
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url.split("://", 1)[1]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url.split("://", 1)[1]
    if url.startswith("sqlite") and os.environ.get("CDARV_TEST_PROFILE") != "true":
        raise RuntimeError(
            "sqlite URLs require CDARV_TEST_PROFILE=true — production uses PostgreSQL"
        )
    return url


def create_db_engine(url: str | None = None) -> Engine:
    engine = create_engine(url or database_url(), pool_pre_ping=True)
    if engine.url.get_backend_name() == "sqlite":

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _record):  # enforce FK cascade on sqlite
            dbapi_conn.execute("PRAGMA foreign_keys = ON")

    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


@contextmanager
def session_scope(factory: sessionmaker[Session]) -> Iterator[Session]:
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def create_schema(engine: Engine) -> None:
    """Test-profile convenience; production schema lives in Alembic."""
    Base.metadata.create_all(engine)


__all__ = [
    "create_db_engine",
    "create_schema",
    "create_session_factory",
    "database_url",
    "session_scope",
]
