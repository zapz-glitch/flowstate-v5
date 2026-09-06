"""Owner-scoped durable identity for V4 batches, jobs, and results.

Adds nullable ``requested_by_user_id`` first. If any populated 0002 row
exists without an explicit owner, the upgrade aborts transactionally
with an actionable preflight before any constraint is dropped or
changed: no silent sentinel backfill exists. A clean empty database
upgrades normally, after which the columns become non-null with
``length(trim(owner)) > 0`` checks and no empty default.

Owner-bearing composite uniques and FKs at head:

- batch ``(tenant, user, key)``; evaluation ``(tenant, user, key)`` plus
  ``(tenant, user, batch)`` referencing the same batch owner;
- result ``(tenant, user, evaluation)`` referencing the same evaluation
  owner; snapshot tenant binding is preserved untouched.

Downgrade preflights owner-scoped duplicate keys before recreating
tenant-only uniques: any ``(tenant, key)`` shared by two users raises a
deliberate actionable error with category/count and no values, and the
transaction stays at 0003.

New head: 0003_v4_owner.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003_v4_owner"
down_revision = "0002_v4_repair"
branch_labels = None
depends_on = None

_OWNER_TABLES = ("v4_batches", "v4_evaluations", "v4_evaluation_results")


def _ownerless_counts() -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    for table in _OWNER_TABLES:
        count = op.get_bind().execute(
            sa.text(
                f"SELECT count(*) FROM {table} "
                "WHERE requested_by_user_id IS NULL "
                "OR length(trim(requested_by_user_id)) = 0"
            )
        ).scalar() or 0
        if count:
            found.append((table, int(count)))
    return found


def _duplicate_counts() -> list[tuple[str, int]]:
    queries = {
        "batch": (
            "SELECT count(*) FROM (SELECT tenant_id, idempotency_key "
            "FROM v4_batches GROUP BY tenant_id, idempotency_key "
            "HAVING count(DISTINCT requested_by_user_id) > 1) AS dups"
        ),
        "evaluation": (
            "SELECT count(*) FROM (SELECT tenant_id, idempotency_key "
            "FROM v4_evaluations GROUP BY tenant_id, idempotency_key "
            "HAVING count(DISTINCT requested_by_user_id) > 1) AS dups"
        ),
    }
    found: list[tuple[str, int]] = []
    for category, sql in queries.items():
        count = op.get_bind().execute(sa.text(sql)).scalar() or 0
        if count:
            found.append((category, int(count)))
    return found


def upgrade() -> None:
    for table in _OWNER_TABLES:
        op.add_column(
            table,
            sa.Column("requested_by_user_id", sa.String(128), nullable=True),
        )
    ownerless = _ownerless_counts()
    if ownerless:
        detail = ", ".join(f"{table}: {count} rows" for table, count in ownerless)
        raise RuntimeError(
            "V4 0003 preflight: populated 0002 rows without durable ownership "
            f"({detail}). Assign each row an explicit requested_by_user_id "
            "matching the submitting credential, then re-run the upgrade. "
            "No rows were changed."
        )
    for table in _OWNER_TABLES:
        op.alter_column(
            table, "requested_by_user_id",
            existing_type=sa.String(128), nullable=False,
        )
        op.create_check_constraint(
            f"ck_v4_{table[3:]}_owner_nonempty" if table.startswith("v4_") else f"ck_{table}_owner",
            table,
            "length(trim(requested_by_user_id)) > 0",
        )
    op.create_unique_constraint(
        "uq_v4_batch_owner", "v4_batches",
        ["tenant_id", "requested_by_user_id", "id"],
    )
    op.create_unique_constraint(
        "uq_v4_eval_owner", "v4_evaluations",
        ["tenant_id", "requested_by_user_id", "id"],
    )
    op.drop_constraint("fk_v4_eval_tenant_batch", "v4_evaluations", type_="foreignkey")
    op.create_foreign_key(
        "fk_v4_eval_owner_batch",
        "v4_evaluations",
        "v4_batches",
        ["tenant_id", "requested_by_user_id", "batch_id"],
        ["tenant_id", "requested_by_user_id", "id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("fk_v4_result_tenant_eval", "v4_evaluation_results", type_="foreignkey")
    op.create_foreign_key(
        "fk_v4_result_owner_eval",
        "v4_evaluation_results",
        "v4_evaluations",
        ["tenant_id", "requested_by_user_id", "evaluation_id"],
        ["tenant_id", "requested_by_user_id", "id"],
        ondelete="CASCADE",
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
    duplicates = _duplicate_counts()
    if duplicates:
        detail = ", ".join(f"{category}: {count} keys" for category, count in duplicates)
        raise RuntimeError(
            "V4 0003 downgrade preflight: owner-scoped duplicate keys "
            f"({detail}). Resolve cross-user same-key rows before "
            "recreating tenant-only uniques. No rows were changed; "
            "the database stays at 0003."
        )
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
    op.drop_constraint("fk_v4_result_owner_eval", "v4_evaluation_results", type_="foreignkey")
    op.create_foreign_key(
        "fk_v4_result_tenant_eval",
        "v4_evaluation_results",
        "v4_evaluations",
        ["tenant_id", "evaluation_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("fk_v4_eval_owner_batch", "v4_evaluations", type_="foreignkey")
    op.create_foreign_key(
        "fk_v4_eval_tenant_batch",
        "v4_evaluations",
        "v4_batches",
        ["tenant_id", "batch_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("uq_v4_eval_owner", "v4_evaluations", type_="unique")
    op.drop_constraint("uq_v4_batch_owner", "v4_batches", type_="unique")
    for table in _OWNER_TABLES:
        short = table[3:] if table.startswith("v4_") else table
        op.drop_constraint(f"ck_v4_{short}_owner_nonempty", table, type_="check")
    op.drop_column("v4_evaluation_results", "requested_by_user_id")
    op.drop_column("v4_evaluations", "requested_by_user_id")
    op.drop_column("v4_batches", "requested_by_user_id")
