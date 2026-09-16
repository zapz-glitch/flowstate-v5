"""CDARV persistence models — the curated report library and registry.

Production targets the existing PostgreSQL database (DATABASE_URL);
portable column types (generic JSON, String(36) ids, LargeBinary
artifacts) let the unit-test profile run the same schema on SQLite.
Queue lease semantics are exercised against Postgres in staging — the
SQLite test profile exists for domain logic, not concurrency claims.
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
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


# ─── Snapshots: the versioned report library ──────────────────────────────────

class Snapshot(Base):
    """One immutable capture of a submitted report.

    A resubmission with identical content reuses the row; changed content
    (e.g. reviewer edited comps in prod then re-sent) creates a new version.
    The original evaluator output lives inside report_json and is never
    mutated by reviews — corrections live on review versions.
    """

    __tablename__ = "cdarv_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    report_id: Mapped[str] = mapped_column(String(128), nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="submitted")
    completeness: Mapped[str] = mapped_column(String(16), nullable=False)
    completeness_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    report_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    provenance_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    submitted_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        UniqueConstraint("report_id", "content_hash", name="uq_cdarv_snap_content"),
        UniqueConstraint("report_id", "version", name="uq_cdarv_snap_version"),
        CheckConstraint(
            "status IN ('submitted','needs_review','approved',"
            "'needs_more_evidence','excluded')",
            name="ck_cdarv_snap_status",
        ),
        CheckConstraint(
            "completeness IN ('complete','incomplete')",
            name="ck_cdarv_snap_completeness",
        ),
        Index("ix_cdarv_snap_status", "status"),
        Index("ix_cdarv_snap_user", "user_id"),
    )


class Review(Base):
    """One review version against a snapshot. Immutable once created —
    corrections produce a new version rather than mutating history."""

    __tablename__ = "cdarv_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    snapshot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_snapshots.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="needs_review")
    reviewer_id: Mapped[str] = mapped_column(String(128), nullable=False)
    summary_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("snapshot_id", "version", name="uq_cdarv_review_version"),
        CheckConstraint(
            "status IN ('needs_review','needs_more_evidence','approved','excluded')",
            name="ck_cdarv_review_status",
        ),
        Index("ix_cdarv_review_snapshot", "snapshot_id"),
    )


class CompLabel(Base):
    """Reviewer label for one candidate comp within a review version.

    `not_reviewed` is an explicit state — never folded into negatives.
    `transaction_key` pins the specific sale (comp id + sale date) so a
    property with multiple transactions is unambiguous.
    """

    __tablename__ = "cdarv_comp_labels"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_reviews.id", ondelete="CASCADE"), nullable=False
    )
    comp_id: Mapped[str] = mapped_column(String(128), nullable=False)
    transaction_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    label: Mapped[str] = mapped_column(String(32), nullable=False)
    reasons_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        UniqueConstraint("review_id", "comp_id", name="uq_cdarv_label_comp"),
        CheckConstraint(
            "label IN ('strong_arv','usable_with_adjustment','unsuitable','not_reviewed')",
            name="ck_cdarv_label_value",
        ),
        Index("ix_cdarv_label_review", "review_id"),
    )


class Preference(Base):
    """Pairwise reviewer judgment: preferred comp over another, with reason."""

    __tablename__ = "cdarv_preferences"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_reviews.id", ondelete="CASCADE"), nullable=False
    )
    preferred_comp_id: Mapped[str] = mapped_column(String(128), nullable=False)
    over_comp_id: Mapped[str] = mapped_column(String(128), nullable=False)
    reasons_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (Index("ix_cdarv_pref_review", "review_id"),)


class ExternalComp(Base):
    """Reviewer-identified comparable outside the original candidate pool."""

    __tablename__ = "cdarv_external_comps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_reviews.id", ondelete="CASCADE"), nullable=False
    )
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    transaction_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    availability_date: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (Index("ix_cdarv_ext_review", "review_id"),)


class Approval(Base):
    """Approval decision attached to a review version.

    comp_ranking and valuation_benchmark are separate scopes — a report can
    teach comp selection without its ARV being benchmark-trustworthy.
    Gold standard records who asserted it and the supporting evidence.
    """

    __tablename__ = "cdarv_approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_reviews.id", ondelete="CASCADE"),
        nullable=False, unique=True,
    )
    comp_ranking_approved: Mapped[bool] = mapped_column(nullable=False, default=False)
    valuation_benchmark_approved: Mapped[bool] = mapped_column(nullable=False, default=False)
    gold_standard: Mapped[bool] = mapped_column(nullable=False, default=False)
    gold_standard_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    gold_standard_evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


# ─── Datasets: frozen manifests ───────────────────────────────────────────────

class Dataset(Base):
    __tablename__ = "cdarv_datasets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    manifest_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    feature_spec_version: Mapped[str] = mapped_column(String(32), nullable=False)
    code_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    split_summary_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    geo_summary_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("name", "version", name="uq_cdarv_dataset_name_version"),
        Index("ix_cdarv_dataset_name", "name"),
    )


class DatasetMember(Base):
    __tablename__ = "cdarv_dataset_members"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    dataset_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_datasets.id", ondelete="CASCADE"), nullable=False
    )
    snapshot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    review_id: Mapped[str] = mapped_column(String(36), nullable=False)
    split: Mapped[str] = mapped_column(String(8), nullable=False)

    __table_args__ = (
        UniqueConstraint("dataset_id", "snapshot_id", name="uq_cdarv_member_snap"),
        CheckConstraint("split IN ('train','val','test')", name="ck_cdarv_member_split"),
        Index("ix_cdarv_member_dataset", "dataset_id"),
    )


# ─── Jobs: the background work queue ──────────────────────────────────────────

class Job(Base):
    """Lease-claim job row, same shape as the V4 evaluation queue."""

    __tablename__ = "cdarv_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=3)
    lease_owner: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    __table_args__ = (
        CheckConstraint(
            "type IN ('train_model','shadow_score')", name="ck_cdarv_job_type"
        ),
        CheckConstraint(
            "status IN ('queued','claimed','running','succeeded','failed','dead')",
            name="ck_cdarv_job_status",
        ),
        Index("ix_cdarv_job_claim", "status", "next_attempt_at"),
    )


# ─── Model registry + shadow state + predictions ─────────────────────────────

class Model(Base):
    __tablename__ = "cdarv_models"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    dataset_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_datasets.id", ondelete="RESTRICT"), nullable=False
    )
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    target: Mapped[str] = mapped_column(String(32), nullable=False)
    feature_names_json: Mapped[list] = mapped_column(JSON, nullable=False)
    metrics_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    dataset_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    artifact: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="candidate")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("name", "version", name="uq_cdarv_model_name_version"),
        CheckConstraint(
            "status IN ('candidate','shadow','retired')", name="ck_cdarv_model_status"
        ),
    )


class ShadowState(Base):
    """Singleton: which model (if any) produces shadow predictions."""

    __tablename__ = "cdarv_shadow_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    active_model_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    activated_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (CheckConstraint("id = 1", name="ck_cdarv_shadow_singleton"),)


class Prediction(Base):
    """One shadow prediction: model output on a snapshot. Never written
    back to production reports."""

    __tablename__ = "cdarv_predictions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    snapshot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_snapshots.id", ondelete="CASCADE"), nullable=False
    )
    model_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cdarv_models.id", ondelete="RESTRICT"), nullable=False
    )
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    selected_comp_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    scores_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    shadow_arv: Mapped[float | None] = mapped_column(nullable=True)
    recalc_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint("snapshot_id", "model_id", name="uq_cdarv_pred_snap_model"),
        CheckConstraint(
            "status IN ('scored','insufficient_evidence','error')",
            name="ck_cdarv_pred_status",
        ),
        Index("ix_cdarv_pred_model", "model_id"),
    )


class Guidance(Base):
    """Versioned human guidance: desired behavior + representative examples.
    Informs dataset curation; never silently rewrites production rules."""

    __tablename__ = "cdarv_guidance"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    examples_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','active','retired')", name="ck_cdarv_guidance_status"
        ),
    )


__all__ = [
    "Approval", "Base", "CompLabel", "Dataset", "DatasetMember", "ExternalComp",
    "Guidance", "Job", "Model", "Prediction", "Preference", "Review",
    "ShadowState", "Snapshot",
]
