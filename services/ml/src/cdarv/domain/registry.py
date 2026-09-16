"""Model registry + shadow activation state.

Shadow activation is explicit and reversible: one singleton row points at
at most one model. `deactivate` is the rollback path — clearing the active
model stops all new shadow predictions without touching history.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..persistence.models import Model, ShadowState


class RegistryError(ValueError):
    pass


def _state(session: Session) -> ShadowState:
    row = session.execute(select(ShadowState)).scalar_one_or_none()
    if row is None:
        row = ShadowState(id=1)
        session.add(row)
        session.flush()
    return row


def shadow_state(session: Session) -> dict:
    row = _state(session)
    model = session.get(Model, row.active_model_id) if row.active_model_id else None
    return {
        "active_model_id": row.active_model_id,
        "active_model": (
            {"id": model.id, "name": model.name, "version": model.version}
            if model else None
        ),
        "activated_by": row.activated_by,
        "activated_at": row.activated_at.isoformat() if row.activated_at else None,
    }


def activate_shadow(session: Session, *, model_id: str, activated_by: str) -> dict:
    model = session.get(Model, model_id)
    if model is None:
        raise RegistryError("model not found")
    if model.status == "retired":
        raise RegistryError("retired models cannot be activated")
    # Demote any previously active model; never delete it.
    prev = _state(session)
    if prev.active_model_id and prev.active_model_id != model_id:
        old = session.get(Model, prev.active_model_id)
        if old is not None and old.status == "shadow":
            old.status = "candidate"
    model.status = "shadow"
    prev.active_model_id = model_id
    prev.activated_by = activated_by
    prev.activated_at = datetime.now(timezone.utc)
    session.flush()
    return shadow_state(session)


def deactivate_shadow(session: Session) -> dict:
    """Rollback: stop all new shadow predictions. History is untouched."""
    prev = _state(session)
    if prev.active_model_id:
        old = session.get(Model, prev.active_model_id)
        if old is not None and old.status == "shadow":
            old.status = "candidate"
    prev.active_model_id = None
    prev.activated_by = None
    prev.activated_at = None
    session.flush()
    return shadow_state(session)


def list_models(session: Session) -> list[Model]:
    return list(
        session.execute(
            select(Model).order_by(Model.name, Model.version.desc())
        ).scalars()
    )


__all__ = [
    "RegistryError",
    "activate_shadow",
    "deactivate_shadow",
    "list_models",
    "shadow_state",
]
