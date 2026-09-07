"""Additive provider-limiter persistence for the supervised worker (V4-103B).

Creates two PostgreSQL-only tables coordinating the shared Cotality
provider limiter across worker processes:

- ``v4_cotality_leases``: one row per active provider lease. Concurrency
  (max 4) is enforced by the limiter transaction under a PostgreSQL
  advisory lock, with expired leases reclaimed before every check.
- ``v4_cotality_calls``: one row per provider attempt, including retries.
  The sliding RPM window (safe 40 calls per 60 seconds, no bursts) counts
  rows in the trailing window; every attempt inserts exactly one row.

Additive only: no existing table, constraint, or trigger is touched.
Downgrade drops the two tables. New head: 0004_v4_provider_limiter.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_v4_provider_limiter"
down_revision = "0003_v4_owner"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "v4_cotality_leases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("provider", sa.String(64), nullable=False, server_default="cotality"),
        sa.Column("owner", sa.String(128), nullable=False),
        sa.Column("lease_token", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("provider", "lease_token", name="uq_v4_cotality_lease_token"),
        sa.CheckConstraint(
            "length(trim(owner)) > 0", name="ck_v4_cotality_lease_owner_nonempty"
        ),
    )
    op.create_index(
        "ix_v4_cotality_lease_expiry",
        "v4_cotality_leases",
        ["provider", "expires_at"],
    )
    op.create_table(
        "v4_cotality_calls",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("provider", sa.String(64), nullable=False, server_default="cotality"),
        sa.Column("owner", sa.String(128), nullable=False),
        sa.Column("evaluation_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("attempt", sa.BigInteger, nullable=False, server_default="1"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("attempt >= 1", name="ck_v4_cotality_call_attempt_pos"),
        sa.CheckConstraint(
            "length(trim(owner)) > 0", name="ck_v4_cotality_call_owner_nonempty"
        ),
    )
    op.create_index(
        "ix_v4_cotality_call_window",
        "v4_cotality_calls",
        ["provider", "started_at"],
    )
    op.create_index(
        "ix_v4_cotality_call_eval",
        "v4_cotality_calls",
        ["evaluation_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_v4_cotality_call_eval", table_name="v4_cotality_calls")
    op.drop_index("ix_v4_cotality_call_window", table_name="v4_cotality_calls")
    op.drop_table("v4_cotality_calls")
    op.drop_index("ix_v4_cotality_lease_expiry", table_name="v4_cotality_leases")
    op.drop_table("v4_cotality_leases")
