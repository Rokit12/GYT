"""The yacht details an owner gives at sign-up (kept separate to avoid import cycles)."""
from pydantic import BaseModel, Field


class VesselClaim(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    flag: str = Field(min_length=2, max_length=60)
    loa_m: float = Field(gt=3, le=200)
    mmsi: str | None = Field(default=None, max_length=12)
    imo: str | None = Field(default=None, max_length=12)
    registry_number: str = Field(min_length=2, max_length=40)
