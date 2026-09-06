"""Comparable candidate evidence contract."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .base import DecimalString


class CompCandidateV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    comp_id: str
    provider_property_id: str = ""
    address: str = ""
    verified_sale_price: DecimalString | None = None
    sale_date: str = ""
    sqft: DecimalString | None = None
    beds: DecimalString | None = None
    baths: DecimalString | None = None
    year_built: int | None = None
    property_type: str = ""
    distance_miles: DecimalString | None = None
    transaction_code: str = ""
    transaction_type: str = ""
    evidence_ref: str = ""
    duplicate_of: str = ""
    is_sale: bool | None = None
    subdivision: str = ""


__all__ = ["CompCandidateV4"]
