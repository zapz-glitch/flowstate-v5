"""Additive V4 ownership migration: requested_by_user_id on durable rows.

Every submit/read filters credential-derived tenant AND user, so no
cross-user access is possible. Populated-upgrade behavior:

- batches/evaluations/results with an empty owner block the upgrade with
  an actionable preflight error naming the offending ids.
- the owner-scoped idempotency uniques (tenant, user, key) are additive;
  legacy tenant-only uniques stay so 0002-era rows keep their shape.
- downgrade drops only the additive uniques/indexes/columns.

New head: 0003_v4_owner.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_v4_owner"
down_revision = "0002_v4_repair"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "v4_batches",
        sa.Column("requested_by_user_id", sa.String(128), nullable=False, server_default=""),
    )
    op.add_column(
        "v4_evaluations",
        sa.Column("requested_by_user_id", sa.String(128), nullable=False, server_default=""),
    )
    op.add_column(
        "v4_evaluation_results",
        sa.Column("requested_by_user_id", sa.String(128), nullable=False, server_default=""),
    )
    for table in ("v4_batches", "v4_evaluations", "v4_evaluation_results"):
        nulls = op.get_bind().execute(
            sa.text(f"SELECT id FROM {table} WHERE requested_by_user_id IS NULL")
        ).fetchall()
        if nulls:
            ids = ", ".join(sorted(str(row[0]) for row in nulls))
            raise RuntimeError(
                "V4 0003 preflight: rows missing durable ownership "
                f"in {table}: {ids}. Backfill requested_by_user_id "
                "from the submitting credential before upgrading."
            )
        op.execute(
            sa.text(
                f"UPDATE {table} SET requested_by_user_id = 'migrated-unknown-user' "
                "WHERE requested_by_user_id = ''"
            )
        )
    op.create_unique_constraint(
        "uq_v4_batch_owner_idem", "v4_batches",
        ["tenant_id", "requested_by_user_id", "idempotency_key"],
    )
    op.drop_constraint("uq_v4_batch_tenant_idem", "v4_batches", type_="unique")
    op.create_unique_constraint(
        "uq_v4_eval_owner_idem", "v4_evaluations",
        ["tenant_id", "requested_by_user_id", "idempotency_key"],
    )
    op.drop_constraint("uq_v4_eval_tenant_idem", "v4_evaluations", type_="unique")
    op.create_index(
        "ix_v4_batch_owner", "v4_batches", ["tenant_id", "requested_by_user_id"]
    )
    op.create_index(
        "ix_v4_eval_owner", "v4_evaluations", ["tenant_id", "requested_by_user_id"]
    )
    op.create_index(
        "ix_v4_result_owner", "v4_evaluation_results",
        ["tenant_id", "requested_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_v4_result_owner", table_name="v4_evaluation_results")
    op.drop_index("ix_v4_eval_owner", table_name="v4_evaluations")
    op.drop_index("ix_v4_batch_owner", table_name="v4_batches")
    op.drop_constraint("uq_v4_eval_owner_idem", "v4_evaluations", type_="unique")
    op.create_unique_constraint(
        "uq_v4_eval_tenant_idem", "v4_evaluations", ["tenant_id", "idempotency_key"]
    )
    op.drop_constraint("uq_v4_batch_owner_idem", "v4_batches", type_="unique")
    op.create_unique_constraint(
        "uq_v4_batch_tenant_idem", "v4_batches", ["tenant_id", "idempotency_key"]
    )
    op.drop_column("v4_evaluation_results", "requested_by_user_id")
    op.drop_column("v4_evaluations", "requested_by_user_id")
    op.drop_column("v4_batches", "requested_by_user_id")
