"""Initial CDARV schema: snapshots, reviews, labels, preferences, external
comps, approvals, datasets + members, jobs, models, shadow state,
predictions, guidance.

Table definitions are generated from the declarative metadata so the
migration and the ORM can never drift.
"""
from __future__ import annotations

import os
import sys

from alembic import op

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from cdarv.persistence.models import Base  # noqa: E402

revision = "0001_cdarv_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
