"""Subject property evidence contract."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .base import DecimalString


class SubjectPropertyV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    subject_id: str = Field(default="", min_length=0, max_length=128)
    address: str = Field(default="", min_length=0, max_length=256)
    city: str = Field(default="", max_length=128)
    state: str = Field(default="", max_length=64)
    zip_code: str = Field(default="", alias="zip", max_length=32)
    property_type: str = Field(default="", max_length=64)
    building_style: str = Field(default="", max_length=128)
    garage_spaces: int | None = Field(default=None, ge=0, le=100)
    beds: DecimalString | None = None
    baths: DecimalString | None = None
    sqft: DecimalString | None = None
    lot_sqft: DecimalString | None = None
    year_built: int | None = Field(default=None, ge=1600, le=2100)
    property_age_years: DecimalString | None = None
    subdivision: str = Field(default="", max_length=128)

    @field_validator("subject_id", "address", mode="after")
    @classmethod
    def _strip_ids(cls, value: str) -> str:
        return value.strip()

    @field_validator("beds", "baths", "sqft", "lot_sqft", "property_age_years", mode="after")
    @classmethod
    def _non_negative(cls, value: object) -> object:
        from decimal import Decimal as _Decimal

        if value is not None and isinstance(value, _Decimal) and value < 0:
            raise ValueError("measurement must be non-negative")
        return value


IsoDate = date

__all__ = ["IsoDate", "SubjectPropertyV4"]
