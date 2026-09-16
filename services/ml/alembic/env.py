"""Alembic environment for CDARV persistence (PostgreSQL only).

Own chain, own `cdarv_*` tables — this never touches `v4_*` (eval-engine)
or any other schema. DATABASE_URL (or CDARV_DATABASE_URL) must be a
PostgreSQL URL.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from urllib.parse import urlparse

from alembic import context
from sqlalchemy import create_engine

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from cdarv.persistence.models import Base  # noqa: E402

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    url = (
        os.environ.get("CDARV_DATABASE_URL") or os.environ.get("DATABASE_URL") or ""
    ).strip()
    if not url:
        raise RuntimeError("CDARV_DATABASE_URL or DATABASE_URL is not configured")
    scheme = urlparse(url).scheme.lower()
    if scheme not in {"postgresql", "postgresql+psycopg"}:
        raise RuntimeError(f"CDARV migrations require PostgreSQL, got {scheme!r}")
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url.split("://", 1)[1]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url.split("://", 1)[1]
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), pool_pre_ping=True)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
