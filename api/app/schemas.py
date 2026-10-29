from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator


class DocumentIn(BaseModel):
    kind: str
    filename: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class YachtCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    mmsi: str | None = Field(default=None, pattern=r"^\d{9}$")
    imo: str | None = Field(default=None, pattern=r"^\d{7}$")
    flag: str
    registry_ref: str | None = None
    loa_m: float = Field(gt=2, lt=250)
    beam_m: float = Field(gt=1, lt=40)
    year_built: int | None = Field(default=None, ge=1900, le=2030)
    builder: str | None = None
    home_marina_id: str
    berth_code: str | None = None
    valuation_usd: float | None = Field(default=None, gt=0)
    charter_week_usd: float | None = Field(default=None, ge=0)
    units_total: int = Field(default=0, ge=0)
    documents: list[DocumentIn] = []


class TrackerCreate(BaseModel):
    tracker_id: str
    yacht_id: str
    public_key: str = Field(pattern=r"^[0-9a-f]{64}$")


class GpsFix(BaseModel):
    tracker_id: str
    yacht_id: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    observed_at: datetime
    sog_kn: float | None = None
    cog_deg: float | None = None
    signature: str = Field(pattern=r"^[0-9a-f]{128}$")


class AisIn(BaseModel):
    mmsi: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    observed_at: datetime
    sog_kn: float | None = None
    cog_deg: float | None = None


class SarIn(BaseModel):
    yacht_id: str
    lat: float
    lon: float
    observed_at: datetime
    est_length_m: float | None = None
    provider: str = "gfw"


class BerthBookingIn(BaseModel):
    ref: str = Field(pattern=r"^[A-Z]{2}-\d{3,8}$")
    yacht_id: str
    berth_id: int
    arrive: date
    depart: date

    @field_validator("depart")
    @classmethod
    def after_arrive(cls, v, info):
        if "arrive" in info.data and v <= info.data["arrive"]:
            raise ValueError("depart must be after arrive")
        return v


class CreditStayIn(BaseModel):
    ref: str = Field(pattern=r"^CS-\d{3,8}$")
    yacht_id: str
    arrive: date
    nights: int = Field(ge=1, le=14)


class ModeIn(BaseModel):
    mode: str = Field(pattern=r"^(use|earn)$")


class TransferCheckIn(BaseModel):
    investor_id: str
    yacht_id: str
    units: int = Field(gt=0)
