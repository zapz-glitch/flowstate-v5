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
    """Immutable typed settings snapshot with content hash and source JSON."""

    __tablename__ = "v4_settings_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    snapshot_version: Mapped[str] = mapped_column(String(64), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Full snapshot payload: values, units, enabled states, sources, scopes,
    # precedence, rounding policy. Stored as JSONB on PostgreSQL.
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # Where each value came from (request override, zip, city+state, ...).
    source: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "content_hash", name="uq_v4_snapshot_tenant_hash"
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
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("v4_settings_snapshots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    snapshot: Mapped[SettingsSnapshot | None] = relationship(lazy="joined")
    evaluations: Mapped[list["Evaluation"]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_batch_tenant_idem"
        ),
        CheckConstraint(
            "total_count >= 0", name="ck_v4_batch_total_nonneg"
        ),
        CheckConstraint(
            "succeeded_count >= 0", name="ck_v4_batch_succeeded_nonneg"
        ),
        CheckConstraint("failed_count >= 0", name="ck_v4_batch_failed_nonneg"),
        CheckConstraint(
            "status IN ('pending','running','succeeded','partial','failed')",
            name="ck_v4_batch_status",
        ),
        Index("ix_v4_batch_tenant", "tenant_id"),
        Index("ix_v4_batch_tenant_status", "tenant_id", "status"),
    )


class Evaluation(Base):
    """One durable property job inside a batch (queue row)."""

    __tablename__ = "v4_evaluations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("v4_batches.id", ondelete="CASCADE"),
        nullable=False,
    )
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=5)
    # Lease / heartbeat fields for atomic claims and stale recovery.
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Restart-safe checkpoint payload (opaque JSON).
    checkpoint: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Input evidence payload (subject, comps, permits, renovation input).
    input_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
    )

    batch: Mapped[Batch] = relationship(back_populates="evaluations")
    results: Mapped[list["EvaluationResult"]] = relationship(
        back_populates="evaluation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="EvaluationResult.version",
    )

    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "idempotency_key", name="uq_v4_eval_tenant_idem"
        ),
        CheckConstraint("attempts >= 0", name="ck_v4_eval_attempts_nonneg"),
        CheckConstraint("max_attempts >= 1", name="ck_v4_eval_max_attempts_pos"),
        CheckConstraint(
            "status IN ('queued','claimed','running','succeeded','failed','dead')",
            name="ck_v4_eval_status",
        ),
        Index("ix_v4_eval_tenant", "tenant_id"),
        Index("ix_v4_eval_batch", "batch_id"),
        # Claim scan: only queued rows whose lease expired (or never leased)
        # and whose next attempt is due.
        Index(
            "ix_v4_eval_claim_scan",
            "tenant_id",
            "status",
            "next_attempt_at",
            "lease_expires_at",
        ),
        Index("ix_v4_eval_lease_expiry", "lease_expires_at"),
    )


class EvaluationResult(Base):
    """Idempotent versioned result commits, one row per version."""

    __tablename__ = "v4_evaluation_results"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False)
    evaluation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("v4_evaluations.id", ondelete="CASCADE"),
        nullable=False,
    )
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    methodology_version: Mapped[str] = mapped_column(String(64), nullable=False)
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("v4_settings_snapshots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    result_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    result_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow
    )

    evaluation: Mapped[Evaluation] = relationship(back_populates="results")

    __table_args__ = (
        UniqueConstraint(
            "evaluation_id", "version", name="uq_v4_result_eval_version"
        ),
        CheckConstraint("version >= 1", name="ck_v4_result_version_pos"),
        CheckConstraint(
            "status IN ('succeeded','failed','incomplete')",
            name="ck_v4_result_status",
        ),
        Index("ix_v4_result_eval", "evaluation_id"),
        Index("ix_v4_result_tenant", "tenant_id"),
    )
