"""SQLAlchemy 2 models for isolated V4 evaluation persistence.

Scope: tenant-scoped batches, evaluations (jobs), immutable settings
snapshots, and idempotent versioned results. PostgreSQL only. No SQLite
fallback for queue semantics anywhere in this package.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class SettingsSnapshot(Base):
    """Immutable typed settings snapshot: full content including provenance."""

    __tablename__ = "v4_settings_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    snapshot_version: Mapped[str] = mapped_column(String(64), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    source: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "content_hash", name="uq_v4_snapshot_tenant_hash"
        ),
        UniqueConstraint(
            "tenant_id", "id", name="uq_v4_snapshot_tenant_id"
        ),
        Index("ix_v4_snapshot_tenant", "tenant_id"),
    )


class Batch(Base):
    """Tenant-scoped batch of 1-50 property evaluations."""

    __tablename__ = "v4_batches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    total_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    succeeded_count: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0
    )
    failed_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_batch_tenant_idem"
        ),
        UniqueConstraint("tenant_id", "id", name="uq_v4_batch_tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "snapshot_id"],
            ["v4_settings_snapshots.tenant_id", "v4_settings_snapshots.id"],
            ondelete="RESTRICT",
            name="fk_v4_batch_tenant_snapshot",
        ),
        CheckConstraint(
            "total_count BETWEEN 1 AND 50", name="ck_v4_batch_total_range"
        ),
        CheckConstraint(
            "succeeded_count >= 0", name="ck_v4_batch_succeeded_nonneg"
        ),
        CheckConstraint("failed_count >= 0", name="ck_v4_batch_failed_nonneg"),
        CheckConstraint(
            "succeeded_count + failed_count <= total_count",
            name="ck_v4_batch_counts_sum",
        ),
        CheckConstraint(
            "status IN ('pending','running','succeeded','partial','failed')",
            name="ck_v4_batch_status",
        ),
        # Batch `running` means at least one property reached a terminal
        # execution state while at least one property is still non-terminal.
        # The status is always exactly derived from the counters.
        CheckConstraint(
            "(status = 'pending' AND succeeded_count = 0 AND failed_count = 0)"
            " OR (status = 'running' AND (succeeded_count > 0 OR failed_count > 0)"
            " AND succeeded_count + failed_count < total_count)"
            " OR (status = 'succeeded' AND failed_count = 0"
            " AND succeeded_count = total_count)"
            " OR (status = 'failed' AND succeeded_count = 0"
            " AND failed_count = total_count)"
            " OR (status = 'partial' AND succeeded_count > 0 AND failed_count > 0"
            " AND succeeded_count + failed_count = total_count)",
            name="ck_v4_batch_status_counts",
        ),
        Index("ix_v4_batch_tenant", "tenant_id"),
        Index("ix_v4_batch_tenant_status", "tenant_id", "status"),
    )

    snapshot: Mapped[SettingsSnapshot] = relationship(lazy="select")
    evaluations: Mapped[list["Evaluation"]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Evaluation(Base):
    """One durable property job inside a batch (queue row)."""

    __tablename__ = "v4_evaluations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    result_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=5)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_token: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    lease_generation: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0
    )
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    checkpoint: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    input_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    retriable: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_eval_tenant_idem"
        ),
        UniqueConstraint("tenant_id", "id", name="uq_v4_eval_tenant_id"),
        ForeignKeyConstraint(
            ["tenant_id", "batch_id"],
            ["v4_batches.tenant_id", "v4_batches.id"],
            ondelete="CASCADE",
            name="fk_v4_eval_tenant_batch",
        ),
        CheckConstraint("attempts >= 0", name="ck_v4_eval_attempts_nonneg"),
        CheckConstraint("max_attempts >= 1", name="ck_v4_eval_max_attempts_pos"),
        CheckConstraint(
            "lease_generation >= 0", name="ck_v4_eval_lease_gen_nonneg"
        ),
        CheckConstraint(
            "status IN ('queued','claimed','running','succeeded','failed','dead')",
            name="ck_v4_eval_status",
        ),
        # `running` means the lease holder started execution: requires an
        # active lease (owner/token/expiry) and at least one attempt.
        CheckConstraint(
            "status <> 'running' OR (lease_owner IS NOT NULL"
            " AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL"
            " AND attempts > 0)",
            name="ck_v4_eval_running_lease",
        ),
        # Terminal execution states release the lease so one active lease
        # can consume at most one terminal result.
        CheckConstraint(
            "status NOT IN ('queued','claimed','running','succeeded','failed','dead')"
            " OR status IN ('queued','claimed','running')"
            " OR (lease_owner IS NULL AND lease_token IS NULL"
            " AND lease_expires_at IS NULL)",
            name="ck_v4_eval_terminal_no_lease",
        ),
        CheckConstraint(
            "result_status IS NULL OR result_status IN "
            "('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
            "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')",
            name="ck_v4_eval_result_status",
        ),
        Index("ix_v4_eval_tenant", "tenant_id"),
        Index("ix_v4_eval_batch", "batch_id"),
        Index(
            "ix_v4_eval_claim_scan",
            "tenant_id",
            "status",
            "next_attempt_at",
            "lease_expires_at",
        ),
        Index("ix_v4_eval_lease_expiry", "lease_expires_at"),
        Index("ix_v4_eval_lease_token", "lease_token"),
    )

    batch: Mapped[Batch] = relationship(back_populates="evaluations")
    results: Mapped[list["EvaluationResult"]] = relationship(
        back_populates="evaluation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="EvaluationResult.version",
    )


class EvaluationResult(Base):
    """Idempotent versioned result commits, one row per version."""

    __tablename__ = "v4_evaluation_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    evaluation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    methodology_version: Mapped[str] = mapped_column(String(64), nullable=False)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    result_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    result_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "evaluation_id", "version", name="uq_v4_result_eval_version"
        ),
        UniqueConstraint(
            "evaluation_id",
            "methodology_version",
            "snapshot_id",
            "status",
            "result_hash",
            name="uq_v4_result_identity",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "evaluation_id"],
            ["v4_evaluations.tenant_id", "v4_evaluations.id"],
            ondelete="CASCADE",
            name="fk_v4_result_tenant_eval",
        ),
        ForeignKeyConstraint(
            ["tenant_id", "snapshot_id"],
            ["v4_settings_snapshots.tenant_id", "v4_settings_snapshots.id"],
            ondelete="RESTRICT",
            name="fk_v4_result_tenant_snapshot",
        ),
        CheckConstraint("version >= 1", name="ck_v4_result_version_pos"),
        CheckConstraint(
            "status IN ('VALUED','REVIEW_REQUIRED','INSUFFICIENT_COMPS',"
            "'INSUFFICIENT_INVESTOR_DATA','INCOMPLETE','FAILED')",
            name="ck_v4_result_status",
        ),
        Index("ix_v4_result_eval", "evaluation_id"),
        Index("ix_v4_result_tenant", "tenant_id"),
    )

    evaluation: Mapped[Evaluation] = relationship(back_populates="results")


class ResultSnapshotBackfill(Base):
    """Auditable record of 0002 backfilled null/mismatched result snapshots."""

    __tablename__ = "v4_result_snapshot_backfill"

    result_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True
    )
    evaluation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    backfilled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
