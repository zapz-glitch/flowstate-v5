"""Request/response contracts for the V4 evaluation engine.

These mirror the data the existing TS pipeline already produces
(comps, subject facts) so the Python engine can be fed without
changing any existing producer code.
"""
from pydantic import BaseModel, Field


class SubjectProperty(BaseModel):
    address: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    beds: float | None = None
    baths: float | None = None
    sqft: float | None = None
    lot_sqft: float | None = None
    year_built: int | None = None
    property_type: str = ""


class Comparable(BaseModel):
    address: str = ""
    sale_price: float | None = None
    sale_date: str = ""
    beds: float | None = None
    baths: float | None = None
    sqft: float | None = None
    distance_miles: float | None = None


class EvaluateRequest(BaseModel):
    subject: SubjectProperty
    comps: list[Comparable] = Field(default_factory=list)


class DecisionStep(BaseModel):
    node: str
    outcome: str
    detail: str = ""


class EvaluateResponse(BaseModel):
    estimated_value: float
    confidence: str = "unknown"
    decision_path: list[DecisionStep] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "eval-engine-v4"
