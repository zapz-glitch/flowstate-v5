"""Owner's property-evaluation decision tree, ported to Python.

PRIMARY TASK SOURCE: docs/EVALUATION_V4.md, derived from the owner directive.
This module remains a deliberate stub until the accepted typed contract lands.

Implementation rules for the backend worker:
- One function per decision node, named after the node in the markdown.
- Every evaluation must return the full decision_path trace so the
  report can show exactly which branches were taken.
- No LLM calls inside the valuation path. Deterministic math only.
- Pure functions where possible: (subject, comps) -> (value, path).
"""
from .schemas import DecisionStep, EvaluateRequest, EvaluateResponse


def evaluate(request: EvaluateRequest) -> EvaluateResponse:
    """Run the owner's decision tree over subject + comps."""
    raise NotImplementedError(
        "Decision tree not yet implemented: awaiting accepted typed V4 contract."
    )


def _step(node: str, outcome: str, detail: str = "") -> DecisionStep:
    return DecisionStep(node=node, outcome=outcome, detail=detail)
