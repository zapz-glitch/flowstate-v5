"""Label and reason vocabularies for comp review.

These are the structured signals a reviewer records. `not_reviewed` is a
real state — an unexamined comp is not a rejected comp, and a comp the
evaluator skipped is not automatically a bad comp.
"""

COMP_LABELS = ("strong_arv", "usable_with_adjustment", "unsuitable", "not_reviewed")

LABEL_REASONS = (
    "condition_mismatch",
    "different_neighborhood",
    "incompatible_construction",
    "geographic_barrier",
    "bad_transaction",
    "better_evidence_available",
    "renovation_quality_match",
    "renovation_quality_mismatch",
    "transaction_recency",
    "price_outlier",
    "other",
)

REVIEW_STATUSES = ("needs_review", "needs_more_evidence", "approved", "excluded")
SNAPSHOT_STATUSES = (
    "submitted", "needs_review", "approved", "needs_more_evidence", "excluded",
)
APPROVAL_SCOPES = ("comp_ranking", "valuation_benchmark")

JOB_TYPES = ("train_model", "shadow_score")
JOB_STATUSES = ("queued", "claimed", "running", "succeeded", "failed", "dead")

__all__ = [
    "APPROVAL_SCOPES",
    "COMP_LABELS",
    "JOB_STATUSES",
    "JOB_TYPES",
    "LABEL_REASONS",
    "REVIEW_STATUSES",
    "SNAPSHOT_STATUSES",
]
