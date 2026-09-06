"""Initial V4 persistence migration: snapshots, batches, evaluations, results."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_v4_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "v4_settings_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("snapshot_version", sa.String(64), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("content", postgresql.JSONB, nullable=False),
        sa.Column(
            "source", postgresql.JSONB, nullable=False, server_default="{}"
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "tenant_id", "content_hash", name="uq_v4_snapshot_tenant_hash"
        ),
    )
    op.create_index(
        "ix_v4_snapshot_tenant", "v4_settings_snapshots", ["tenant_id"]
    )

    op.create_table(
        "v4_batches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(256), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("total_count", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("succeeded_count", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("failed_count", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column(
            "snapshot_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("v4_settings_snapshots.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_batch_tenant_idem"
        ),
        sa.CheckConstraint("total_count >= 0", name="ck_v4_batch_total_nonneg"),
        sa.CheckConstraint(
            "succeeded_count >= 0", name="ck_v4_batch_succeeded_nonneg"
        ),
        sa.CheckConstraint("failed_count >= 0", name="ck_v4_batch_failed_nonneg"),
        sa.CheckConstraint(
            "status IN ('pending','running','succeeded','partial','failed')",
            name="ck_v4_batch_status",
        ),
    )
    op.create_index("ix_v4_batch_tenant", "v4_batches", ["tenant_id"])
    op.create_index(
        "ix_v4_batch_tenant_status", "v4_batches", ["tenant_id", "status"]
    )

    op.create_table(
        "v4_evaluations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column(
            "batch_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("v4_batches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.String(256), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.BigInteger, nullable=False, server_default="5"),
        sa.Column("lease_owner", sa.String(128), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checkpoint", sa.JSON, nullable=True),
        sa.Column("input_payload", postgresql.JSONB, nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_detail", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_eval_tenant_idem"
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_v4_eval_attempts_nonneg"),
        sa.CheckConstraint("max_attempts >= 1", name="ck_v4_eval_max_attempts_pos"),
        sa.CheckConstraint(
            "status IN ('queued','claimed','running','succeeded','failed','dead')",
            name="ck_v4_eval_status",
        ),
    )
    op.create_index("ix_v4_eval_tenant", "v4_evaluations", ["tenant_id"])
    op.create_index("ix_v4_eval_batch", "v4_evaluations", ["batch_id"])
    op.create_index(
        "ix_v4_eval_claim_scan",
        "v4_evaluations",
        ["tenant_id", "status", "next_attempt_at", "lease_expires_at"],
    )
    op.create_index(
        "ix_v4_eval_lease_expiry", "v4_evaluations", ["lease_expires_at"]
    )

    op.create_table(
        "v4_evaluation_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column(
            "evaluation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("v4_evaluations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version", sa.BigInteger, nullable=False),
        sa.Column("methodology_version", sa.String(64), nullable=False),
        sa.Column(
            "snapshot_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("v4_settings_snapshots.id", ondelete="RESTRICT"),
            nullable=True,
        ),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("result_payload", postgresql.JSONB, nullable=False),
        sa.Column("result_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "evaluation_id", "version", name="uq_v4_result_eval_version"
        ),
        sa.CheckConstraint("version >= 1", name="ck_v4_result_version_pos"),
        sa.CheckConstraint(
            "status IN ('succeeded','failed','incomplete')",
            name="ck_v4_result_status",
        ),
    )
    op.create_index(
        "ix_v4_result_eval", "v4_evaluation_results", ["evaluation_id"]
    )
    op.create_index("ix_v4_result_tenant", "v4_evaluation_results", ["tenant_id"])


def downgrade() -> None:
    op.drop_index("ix_v4_result_tenant", table_name="v4_evaluation_results")
    op.drop_index("ix_v4_result_eval", table_name="v4_evaluation_results")
    op.drop_table("v4_evaluation_results")
    op.drop_index("ix_v4_eval_lease_expiry", table_name="v4_evaluations")
    op.drop_index("ix_v4_eval_claim_scan", table_name="v4_evaluations")
    op.drop_index("ix_v4_eval_batch", table_name="v4_evaluations")
    op.drop_index("ix_v4_eval_tenant", table_name="v4_evaluations")
    op.drop_table("v4_evaluations")
    op.drop_index("ix_v4_batch_tenant_status", table_name="v4_batches")
    op.drop_index("ix_v4_batch_tenant", table_name="v4_batches")
    op.drop_table("v4_batches")
    op.drop_index("ix_v4_snapshot_tenant", table_name="v4_settings_snapshots")
    op.drop_table("v4_settings_snapshots")
