"""Adapters for external data. Each returns plain observations and does nothing without keys,
so the platform runs locally with simulated data and switches to live feeds via env vars.

  AIS     AISHub exchange (free with data sharing) or a commercial feed (Spire, MarineTraffic,
          Kpler). AISHub is implemented; commercial feeds follow the same interface.
  SAR     Global Fishing Watch API (SAR vessel detections from Sentinel-1). Requires a free
          GFW token. Confirm dataset ids and parameters against their current docs.
  OSIRIS  CNR-ISTI / ESA research platform. No public API; this adapter reads detections from
          a deployment run under a research partnership (OSIRIS_ENDPOINT).
  KYC     Provider-agnostic interface; wire Sumsub, Onfido or Jumio behind it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from .config import get_settings


@dataclass
class AisRecord:
    mmsi: str
    lat: float
    lon: float
    sog_kn: float | None
    cog_deg: float | None
    observed_at: datetime


@dataclass
class SarDetection:
    lat: float
    lon: float
    observed_at: datetime
    est_length_m: float | None
    source: str  # gfw | osiris | commercial


class AisHub:
    URL = "https://data.aishub.net/ws.php"

    def __init__(self, username: str | None = None):
        self.username = username or get_settings().aishub_username

    def fetch_box(self, latmin: float, latmax: float, lonmin: float, lonmax: float) -> list[AisRecord]:
        if not self.username:
            return []
        r = httpx.get(
            self.URL,
            params=dict(
                username=self.username, format=1, output="json", compress=0,
                latmin=latmin, latmax=latmax, lonmin=lonmin, lonmax=lonmax,
            ),
            timeout=30,
        )
        r.raise_for_status()
        payload = r.json()
        if not isinstance(payload, list) or len(payload) < 2 or payload[0].get("ERROR"):
            return []
        out = []
        for v in payload[1]:
            out.append(
                AisRecord(
                    mmsi=str(v["MMSI"]),
                    lat=float(v["LATITUDE"]),
                    lon=float(v["LONGITUDE"]),
                    sog_kn=float(v.get("SOG")) if v.get("SOG") is not None else None,
                    cog_deg=float(v.get("COG")) if v.get("COG") is not None else None,
                    observed_at=datetime.strptime(v["TIME"], "%Y-%m-%d %H:%M:%S GMT").replace(tzinfo=timezone.utc),
                )
            )
        return out


class GlobalFishingWatchSar:
    BASE = "https://gateway.api.globalfishingwatch.org/v3"

    def __init__(self, token: str | None = None):
        self.token = token or get_settings().gfw_api_token

    def detections_near(self, lat: float, lon: float, since: datetime, until: datetime) -> list[SarDetection]:
        """Query SAR detections around a point. Returns [] when no token is configured.

        Uses the 4Wings report endpoint with the public SAR presence dataset and a small
        GeoJSON region. Verify dataset id and response shape against GFW docs before production.
        """
        if not self.token:
            return []
        d = 0.02  # ~2 km box
        region = {
            "geojson": {
                "type": "Polygon",
                "coordinates": [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
            }
        }
        r = httpx.post(
            f"{self.BASE}/4wings/report",
            params={
                "datasets[0]": "public-global-sar-presence:latest",
                "date-range": f"{since:%Y-%m-%d},{until:%Y-%m-%d}",
                "spatial-resolution": "HIGH",
                "temporal-resolution": "ENTIRE",
                "format": "JSON",
            },
            json=region,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=60,
        )
        r.raise_for_status()
        out = []
        for entry in r.json().get("entries", []):
            for _, rows in entry.items():
                for row in rows or []:
                    out.append(
                        SarDetection(
                            lat=float(row["lat"]), lon=float(row["lon"]), observed_at=until,
                            est_length_m=row.get("length"), source="gfw",
                        )
                    )
        return out


class OsirisAdapter:
    """Reads vessel detections produced by an OSIRIS deployment.

    Expected response: [{"lat":..,"lon":..,"time":"ISO-8601","length_m":..,"heading":..,"speed_kn":..}]
    """

    def __init__(self, endpoint: str | None = None):
        self.endpoint = endpoint or get_settings().osiris_endpoint

    def detections_near(self, lat: float, lon: float, since: datetime, until: datetime) -> list[SarDetection]:
        if not self.endpoint:
            return []
        r = httpx.get(
            f"{self.endpoint.rstrip('/')}/detections",
            params=dict(lat=lat, lon=lon, radius_km=3, since=since.isoformat(), until=until.isoformat()),
            timeout=60,
        )
        r.raise_for_status()
        return [
            SarDetection(
                lat=float(d["lat"]), lon=float(d["lon"]),
                observed_at=datetime.fromisoformat(d["time"].replace("Z", "+00:00")),
                est_length_m=d.get("length_m"), source="osiris",
            )
            for d in r.json()
        ]


@dataclass
class ScreeningResult:
    status: str  # clear | pep_review | sanctions_hit
    reference: str


class KycProvider:
    """Interface. Replace `screen` with the provider SDK call; keep results as references only."""

    def screen(self, investor_id: str, name: str, country_code: int) -> ScreeningResult:
        if not get_settings().kyc_provider_key:
            # Local development: deterministic simulated result
            lowered = name.lower()
            status = "sanctions_hit" if "sanction" in lowered else "pep_review" if "pep" in lowered else "clear"
            return ScreeningResult(status, f"sim-{investor_id}")
        raise NotImplementedError("Wire your KYC provider SDK here")
