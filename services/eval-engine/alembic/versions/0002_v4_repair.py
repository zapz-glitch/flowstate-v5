"""Repair migration: fencing, composite tenant FKs, immutable snapshots,
result identity, execution/result separation, batch counter guards.

Populated-upgrade behavior (0001 with rows):
- batches whose snapshot is missing or cross-tenant block the upgrade with
  an actionable preflight error naming the offending batch ids.
- result rows with a null or mismatched snapshot are backfilled to the
  owning evaluation batch snapshot, and the backfilled ids are recorded in
  v4_result_snapshot_backfill (auditable). If an owning batch is missing,
  the upgrade stops with an actionable error.
- old result/evaluation statuses map deterministically:
    succeeded -> VALUED, failed -> FAILED, incomplete -> INCOMPLETE.
  Any other value blocks the upgrade with an actionable error.
Downgrade maps every new outcome explicitly back to the 0001 vocabulary:
    VALUED/REVIEW_REQUIRED -> succeeded,
    INSUFFICIENT_COMPS/INSUFFICIENT_INVESTOR_DATA/INCOMPLETE -> incomplete,
    FAILED -> failed.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_v4_repair"
down_revision = "0001_v4_initial"
branch_labels = None
depends_on = None

_OLD_TO_NEW = {
    "succeeded": "VALUED",
    "failed": "FAILED",
    "incomplete": "INCOMPLETE",
}
_NEW_TO_OLD = {
    "VALUED": "succeeded",
    "REVIEW_REQUIRED": "succeeded",
    "INSUFFICIENT_COMPS": "incomplete",
    "INSUFFICIENT_INVESTOR_DATA": "incomplete",
    "INCOMPLETE": "incomplete",
    "FAILED": "failed",
}
_NEW_STATUSES = tuple(_NEW_TO_OLD)


def _old_to_new_case(column: str) -> str:
    branches = " ".join(
        f"WHEN '{old}' THEN '{new}'" for old, new in _OLD_TO_NEW.items()
    )
    return f"(CASE {column} {branches} END)"


def _new_to_old_case(column: str) -> str:
    branches = " ".join(
        f"WHEN '{new}' THEN '{old}'" for new, old in _NEW_TO_OLD.items()
    )
    return f"(CASE {column} {branches} END)"


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
    bad_batches = op.get_bind().execute(
        sa.text(
            "SELECT id FROM v4_batches "
            "WHERE snapshot_id IS NULL OR snapshot_id_new IS NULL"
        )
    ).fetchall()
    if bad_batches:
        ids = ", ".join(sorted(str(row[0]) for row in bad_batches))
        raise RuntimeError(
            "V4 0002 preflight: batches missing a tenant-matched snapshot: "
            f"{ids}. Create a tenant settings snapshot and set "
            "v4_batches.snapshot_id before upgrading."
        )
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
    op.create_check_constraint(
        "ck_v4_batch_status_counts",
        "v4_batches",
        "(status = 'pending' AND succeeded_count = 0 AND failed_count = 0)"
        " OR (status = 'running' AND (succeeded_count > 0 OR failed_count > 0)"
        " AND succeeded_count + failed_count < total_count)"
        " OR (status = 'succeeded' AND failed_count = 0"
        " AND succeeded_count = total_count)"
        " OR (status = 'failed' AND succeeded_count = 0"
        " AND failed_count = total_count)"
        " OR (status = 'partial' AND succeeded_count > 0 AND failed_count > 0"
        " AND succeeded_count + failed_count = total_count)",
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
    op.execute(
        "UPDATE v4_evaluations SET result_status = "
        f"{_old_to_new_case('status')} "
        "WHERE status IN ('succeeded','failed') AND result_status IS NULL"
    )
    unknown_evals = op.get_bind().execute(
        sa.text(
            "SELECT id, status FROM v4_evaluations "
            "WHERE status IN ('succeeded','failed') "
            "AND result_status NOT IN "
            "('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
            "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')"
        )
    ).fetchall()
    if unknown_evals:
        ids = ", ".join(sorted(str(row[0]) for row in unknown_evals))
        raise RuntimeError(
            "V4 0002 preflight: evaluations with unmappable status: "
            f"{ids}."
        )
    op.create_check_constraint(
        "ck_v4_eval_result_status",
        "v4_evaluations",
        "result_status IS NULL OR result_status IN "
        "('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
        "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')",
    )
    op.create_check_constraint(
        "ck_v4_eval_running_lease",
        "v4_evaluations",
        "status <> 'running' OR (lease_owner IS NOT NULL"
        " AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL"
        " AND attempts > 0)",
    )
    op.create_check_constraint(
        "ck_v4_eval_terminal_no_lease",
        "v4_evaluations",
        "status IN ('queued','claimed','running')"
        " OR (lease_owner IS NULL AND lease_token IS NULL"
        " AND lease_expires_at IS NULL)",
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
    unknown_results = op.get_bind().execute(
        sa.text(
            "SELECT id, status FROM v4_evaluation_results "
            "WHERE status NOT IN ('succeeded','failed','incomplete')"
        )
    ).fetchall()
    if unknown_results:
        ids = ", ".join(sorted(str(row[0]) for row in unknown_results))
        raise RuntimeError(
            "V4 0002 preflight: results with unmappable status: "
            f"{ids}."
        )
    op.execute(
        "CREATE TABLE IF NOT EXISTS v4_result_snapshot_backfill ("
        " result_id UUID PRIMARY KEY, evaluation_id UUID NOT NULL,"
        " tenant_id VARCHAR(128) NOT NULL, snapshot_id UUID NOT NULL,"
        " backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    )
    op.execute(
        "INSERT INTO v4_result_snapshot_backfill "
        "(result_id, evaluation_id, tenant_id, snapshot_id) "
        "SELECT r.id, r.evaluation_id, r.tenant_id, b.snapshot_id "
        "FROM v4_evaluation_results r "
        "JOIN v4_evaluations e ON e.id = r.evaluation_id "
        " AND e.tenant_id = r.tenant_id "
        "JOIN v4_batches b ON b.id = e.batch_id "
        " AND b.tenant_id = e.tenant_id "
        "WHERE r.snapshot_id IS NULL "
        " OR NOT EXISTS (SELECT 1 FROM v4_settings_snapshots s "
        "  WHERE s.id = r.snapshot_id AND s.tenant_id = r.tenant_id) "
        "ON CONFLICT (result_id) DO NOTHING"
    )
    op.execute(
        "UPDATE v4_evaluation_results r SET snapshot_id = f.snapshot_id "
        "FROM v4_result_snapshot_backfill f WHERE f.result_id = r.id"
    )
    orphan_results = op.get_bind().execute(
        sa.text(
            "SELECT id FROM v4_evaluation_results "
            "WHERE snapshot_id IS NULL OR NOT EXISTS "
            "(SELECT 1 FROM v4_settings_snapshots s "
            " WHERE s.id = v4_evaluation_results.snapshot_id "
            " AND s.tenant_id = v4_evaluation_results.tenant_id)"
        )
    ).fetchall()
    if orphan_results:
        ids = ", ".join(sorted(str(row[0]) for row in orphan_results))
        raise RuntimeError(
            "V4 0002 preflight: results without a tenant-matched snapshot "
            f"after backfill: {ids}."
        )
    op.drop_constraint("ck_v4_result_status", "v4_evaluation_results", type_="check")
    op.execute(
        f"UPDATE v4_evaluation_results SET status = {_old_to_new_case('status')} "
        "WHERE status IN ('succeeded','failed','incomplete')"
    )
    op.alter_column(
        "v4_evaluation_results",
        "snapshot_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
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
    op.execute(
        f"UPDATE v4_evaluation_results SET status = {_new_to_old_case('status')} "
        "WHERE status IN "
        "('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
        "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')"
    )
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
    op.execute("DROP TABLE IF EXISTS v4_result_snapshot_backfill")
    op.drop_constraint("ck_v4_eval_terminal_no_lease", "v4_evaluations", type_="check")
    op.drop_constraint("ck_v4_eval_running_lease", "v4_evaluations", type_="check")
    op.drop_index("ix_v4_eval_lease_token", table_name="v4_evaluations")
    op.drop_constraint("ck_v4_eval_result_status", "v4_evaluations", type_="check")
    op.execute(
        "UPDATE v4_evaluations SET result_status = NULL "
        "WHERE status = 'queued' AND result_status IS NOT NULL"
    )
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
    op.drop_constraint("ck_v4_batch_status_counts", "v4_batches", type_="check")
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
