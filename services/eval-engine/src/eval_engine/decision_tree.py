"""Deterministic V4 decision entry points.

The legacy ``evaluate`` stub stays unimplemented until the HTTP bridge
lands. New deterministic evaluation lives in ``eval_engine.domain`` and
is exposed here as ``evaluate_v4`` without changing existing routes.
"""

from .domain.evaluate import evaluate_v4
from .schemas import DecisionStep, EvaluateRequest, EvaluateResponse


def evaluate(request: EvaluateRequest) -> EvaluateResponse:
    raise NotImplementedError(
        "Decision tree not yet implemented: awaiting accepted typed V4 contract."
    )


def _step(node: str, outcome: str, detail: str = "") -> DecisionStep:
    return DecisionStep(node=node, outcome=outcome, detail=detail)


__all__ = ["_step", "evaluate", "evaluate_v4"]
