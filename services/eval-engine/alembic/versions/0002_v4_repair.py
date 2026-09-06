"""Repair migration: fencing, composite tenant FKs, immutable snapshots,
result identity, execution/result separation, batch counter guards."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_v4_repair"
down_revision = "0001_v4_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE v4_settings_snapshots ALTER COLUMN source DROP DEFAULT")
    op.create_unique_constraint(
        "uq_v4_snapshot_tenant_id",
        "v4_settings_snapshots",
        ["tenant_id", "id"],
    )
    op.create_unique_constraint(
        "uq_v4_batch_tenant_id", "v4_batches", ["tenant_id", "id"]
    )
    op.create_unique_constraint(
        "uq_v4_eval_tenant_id", "v4_evaluations", ["tenant_id", "id"]
    )
    op.add_column(
        "v4_batches",
        sa.Column("snapshot_id_new", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute(
        "UPDATE v4_batches b SET snapshot_id_new = s.id "
        "FROM v4_settings_snapshots s "
        "WHERE b.snapshot_id = s.id AND b.tenant_id = s.tenant_id"
    )
    op.execute("UPDATE v4_batches SET snapshot_id_new = NULL WHERE snapshot_id_new IS NULL AND snapshot_id IS NOT NULL")
    op.drop_constraint("v4_batches_snapshot_id_fkey", "v4_batches", type_="foreignkey")
    op.drop_column("v4_batches", "snapshot_id")
    op.alter_column("v4_batches", "snapshot_id_new", new_column_name="snapshot_id")
    op.alter_column("v4_batches", "snapshot_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False)
    op.drop_constraint("ck_v4_batch_total_nonneg", "v4_batches", type_="check")
    op.create_check_constraint(
        "ck_v4_batch_total_range", "v4_batches", "total_count BETWEEN 1 AND 50"
    )
    op.create_check_constraint(
        "ck_v4_batch_counts_sum",
        "v4_batches",
        "succeeded_count + failed_count <= total_count",
    )
    op.create_foreign_key(
        "fk_v4_batch_tenant_snapshot",
        "v4_batches",
        "v4_settings_snapshots",
        ["tenant_id", "snapshot_id"],
        ["tenant_id", "id"],
        ondelete="RESTRICT",
    )

    op.drop_constraint(
        "v4_evaluations_batch_id_fkey", "v4_evaluations", type_="foreignkey"
    )
    op.add_column(
        "v4_evaluations",
        sa.Column("lease_token", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "v4_evaluations",
        sa.Column("lease_generation", sa.BigInteger, nullable=False, server_default="0"),
    )
    op.add_column(
        "v4_evaluations",
        sa.Column("result_status", sa.String(32), nullable=True),
    )
    op.add_column(
        "v4_evaluations",
        sa.Column("retriable", sa.Boolean, nullable=False, server_default="true"),
    )
    op.create_foreign_key(
        "fk_v4_eval_tenant_batch",
        "v4_evaluations",
        "v4_batches",
        ["tenant_id", "batch_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        "ck_v4_eval_lease_gen_nonneg",
        "v4_evaluations",
        "lease_generation >= 0",
    )
    op.create_check_constraint(
        "ck_v4_eval_result_status",
        "v4_evaluations",
        "result_status IS NULL OR result_status IN "
        "('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
        "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')",
    )
    op.create_index(
        "ix_v4_eval_lease_token", "v4_evaluations", ["lease_token"]
    )

    op.drop_constraint(
        "v4_evaluation_results_evaluation_id_fkey",
        "v4_evaluation_results",
        type_="foreignkey",
    )
    op.drop_constraint(
        "v4_evaluation_results_snapshot_id_fkey",
        "v4_evaluation_results",
        type_="foreignkey",
    )
    op.execute(
        "UPDATE v4_evaluation_results r SET snapshot_id = NULL "
        "WHERE snapshot_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM v4_settings_snapshots s "
        " WHERE s.id = r.snapshot_id AND s.tenant_id = r.tenant_id)"
    )
    op.alter_column(
        "v4_evaluation_results",
        "snapshot_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.drop_constraint("ck_v4_result_status", "v4_evaluation_results", type_="check")
    op.create_check_constraint(
        "ck_v4_result_status",
        "v4_evaluation_results",
        "status IN ('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
        "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')",
    )
    op.create_foreign_key(
        "fk_v4_result_tenant_eval",
        "v4_evaluation_results",
        "v4_evaluations",
        ["tenant_id", "evaluation_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_v4_result_tenant_snapshot",
        "v4_evaluation_results",
        "v4_settings_snapshots",
        ["tenant_id", "snapshot_id"],
        ["tenant_id", "id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "uq_v4_result_identity",
        "v4_evaluation_results",
        ["evaluation_id", "methodology_version", "snapshot_id", "status", "result_hash"],
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION v4_prevent_snapshot_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'v4_settings_snapshots is immutable';
            RETURN NULL;
        END $$;
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_v4_snapshot_no_update
        BEFORE UPDATE OR DELETE ON v4_settings_snapshots
        FOR EACH ROW EXECUTE FUNCTION v4_prevent_snapshot_mutation();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_v4_snapshot_no_update ON v4_settings_snapshots")
    op.execute("DROP FUNCTION IF EXISTS v4_prevent_snapshot_mutation()")
    op.drop_constraint("uq_v4_result_identity", "v4_evaluation_results", type_="unique")
    op.drop_constraint("fk_v4_result_tenant_snapshot", "v4_evaluation_results", type_="foreignkey")
    op.drop_constraint("fk_v4_result_tenant_eval", "v4_evaluation_results", type_="foreignkey")
    op.drop_constraint("ck_v4_result_status", "v4_evaluation_results", type_="check")
    op.create_check_constraint(
        "ck_v4_result_status",
        "v4_evaluation_results",
        "status IN ('succeeded','failed','incomplete')",
    )
    op.alter_column(
        "v4_evaluation_results",
        "snapshot_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
    op.create_foreign_key(
        "v4_evaluation_results_snapshot_id_fkey",
        "v4_evaluation_results",
        "v4_settings_snapshots",
        ["snapshot_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "v4_evaluation_results_evaluation_id_fkey",
        "v4_evaluation_results",
        "v4_evaluations",
        ["evaluation_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_index("ix_v4_eval_lease_token", table_name="v4_evaluations")
    op.drop_constraint("ck_v4_eval_result_status", "v4_evaluations", type_="check")
    op.drop_constraint("ck_v4_eval_lease_gen_nonneg", "v4_evaluations", type_="check")
    op.drop_constraint("fk_v4_eval_tenant_batch", "v4_evaluations", type_="foreignkey")
    op.drop_column("v4_evaluations", "retriable")
    op.drop_column("v4_evaluations", "result_status")
    op.drop_column("v4_evaluations", "lease_generation")
    op.drop_column("v4_evaluations", "lease_token")
    op.create_foreign_key(
        "v4_evaluations_batch_id_fkey",
        "v4_evaluations",
        "v4_batches",
        ["batch_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("fk_v4_batch_tenant_snapshot", "v4_batches", type_="foreignkey")
    op.drop_constraint("uq_v4_eval_tenant_id", "v4_evaluations", type_="unique")
    op.drop_constraint("uq_v4_batch_tenant_id", "v4_batches", type_="unique")
    op.drop_constraint("uq_v4_snapshot_tenant_id", "v4_settings_snapshots", type_="unique")
    op.drop_constraint("ck_v4_batch_counts_sum", "v4_batches", type_="check")
    op.drop_constraint("ck_v4_batch_total_range", "v4_batches", type_="check")
    op.create_check_constraint(
        "ck_v4_batch_total_nonneg", "v4_batches", "total_count >= 0"
    )
    op.add_column(
        "v4_batches",
        sa.Column("snapshot_id_old", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.execute("UPDATE v4_batches SET snapshot_id_old = snapshot_id")
    op.drop_column("v4_batches", "snapshot_id")
    op.alter_column("v4_batches", "snapshot_id_old", new_column_name="snapshot_id")
    op.create_foreign_key(
        "v4_batches_snapshot_id_fkey",
        "v4_batches",
        "v4_settings_snapshots",
        ["snapshot_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.execute(
        "ALTER TABLE v4_settings_snapshots ALTER COLUMN source SET DEFAULT '{}'"
    )
