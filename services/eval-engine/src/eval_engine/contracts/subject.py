"""Subject property evidence contract."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .base import DecimalString


class SubjectPropertyV4(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    address: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = Field(default="", alias="zip")
    property_type: str = ""
    beds: DecimalString | None = None
    baths: DecimalString | None = None
    sqft: DecimalString | None = None
    lot_sqft: DecimalString | None = None
    year_built: int | None = None
    property_age_years: DecimalString | None = None
    subdivision: str = ""

    def model_dump_json_v4(self) -> dict:
        return self.model_dump(mode="json", by_alias=True)


__all__ = ["SubjectPropertyV4"]
