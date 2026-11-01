"""Three-signal position fusion.

AIS is self-reported and can be switched off or spoofed. A signed onboard GPS fix proves the
tracker's key was aboard. A satellite SAR detection proves a hull of the right size was
physically there. Arrival is proven when the independent sources agree with each other and
with the marina location.

Rules:
  * signed GPS is required (it is the only source bound to the yacht by a key)
  * at least one of AIS or SAR must agree with GPS within max_spread_m
  * if AIS disagrees with GPS by more than max_spread_m it is flagged as possible spoofing,
    and SAR becomes required
  * SAR length estimate, when present, must be within 20% of the registered LOA

Yachts without tracking hardware: a fix from a signed-in phone or laptop ('device') may stand in
for signed GPS when there is no signed GPS fix at all. It must be a good fix (precise, no
impossible jumps), and AIS or SAR must still agree with it, exactly as for GPS. The result then
says primary='device' and assurance='standard' instead of 'high', so anyone reading the proof
can see it rests on a signed-in device rather than sealed hardware.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime

EARTH_R = 6_371_008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


@dataclass
class Obs:
    source: str  # ais | gps | sar | device
    lat: float
    lon: float
    observed_at: datetime
    verified: bool = False
    est_length_m: float | None = None


@dataclass
class Signal:
    source: str
    present: bool
    ok: bool
    distance_to_target_m: float | None = None
    note: str = ""


@dataclass
class FusionResult:
    arrived: bool
    signals: list[Signal]
    spoofing_suspected: bool
    reasons: list[str] = field(default_factory=list)
    digest: str = ""  # hex sha256 of the canonical record; goes into the arrival leaf
    primary: str = "gps"  # which source the proof rests on: gps (hardware) or device (phone/laptop)
    assurance: str = "high"  # high = signed hardware GPS, standard = signed-in device

    def as_dict(self) -> dict:
        return asdict(self)


def fuse_arrival(
    target_lat: float,
    target_lon: float,
    radius_m: float,
    loa_m: float,
    gps: Obs | None,
    ais: Obs | None,
    sar: Obs | None,
    max_spread_m: float = 1500,
    device: Obs | None = None,
) -> FusionResult:
    reasons: list[str] = []
    sig: dict[str, Signal] = {}
    primary, assurance = "gps", "high"
    if gps is None and device is not None:
        # No hardware on board: the signed-in device takes GPS's place, at a lower assurance level.
        primary, assurance = "device", "standard"
        gps = Obs("device", device.lat, device.lon, device.observed_at, device.verified)

    def at_target(o: Obs) -> float:
        return haversine_m(o.lat, o.lon, target_lat, target_lon)

    # GPS: required and must be signature-verified
    if gps is None:
        sig["gps"] = Signal("gps", False, False, note="No signed GPS fix in window")
        reasons.append("GPS_MISSING")
    else:
        d = at_target(gps)
        ok = gps.verified and d <= radius_m
        if primary == "device":
            note = "" if gps.verified else "Device fix not precise enough"
        else:
            note = "" if gps.verified else "Signature not verified"
        if gps.verified and d > radius_m:
            note = f"Outside {radius_m:.0f} m arrival radius"
        sig["gps"] = Signal(primary, True, ok, d, note)
        if not ok:
            if primary == "device":
                reasons.append("DEVICE_NOT_AT_TARGET" if gps.verified else "DEVICE_FIX_TOO_VAGUE")
            else:
                reasons.append("GPS_NOT_AT_TARGET" if gps.verified else "GPS_UNSIGNED")

    spoof = False
    if ais is None:
        sig["ais"] = Signal("ais", False, False, note="AIS dark in window")
    else:
        d = at_target(ais)
        agrees = gps is not None and haversine_m(ais.lat, ais.lon, gps.lat, gps.lon) <= max_spread_m
        if gps is not None and not agrees:
            spoof = True
        sig["ais"] = Signal("ais", True, agrees and d <= radius_m, d, "Disagrees with signed GPS" if spoof else "")

    if sar is None:
        sig["sar"] = Signal("sar", False, False, note="No satellite pass in window")
    else:
        d = at_target(sar)
        len_ok = sar.est_length_m is None or abs(sar.est_length_m - loa_m) <= 0.2 * loa_m
        agrees = gps is not None and haversine_m(sar.lat, sar.lon, gps.lat, gps.lon) <= max_spread_m
        note = "" if len_ok else f"Hull estimate {sar.est_length_m:.0f} m vs registered {loa_m:.0f} m"
        sig["sar"] = Signal("sar", True, agrees and len_ok and d <= radius_m, d, note)

    corroborated = sig["ais"].ok or sig["sar"].ok
    if spoof and not sig["sar"].ok:
        reasons.append("AIS_SPOOF_SUSPECTED_SAR_REQUIRED")
    if not corroborated:
        reasons.append("NO_INDEPENDENT_CORROBORATION")

    arrived = sig["gps"].ok and corroborated and not (spoof and not sig["sar"].ok)
    signals = [sig["ais"], sig["gps"], sig["sar"]]
    record = {
        "target": [round(target_lat, 6), round(target_lon, 6), radius_m],
        **({"primary": "device"} if primary == "device" else {}),
        "obs": {
            o.source: [round(o.lat, 6), round(o.lon, 6), o.observed_at.isoformat(), o.verified, o.est_length_m]
            for o in (gps, ais, sar)
            if o is not None
        },
        "arrived": arrived,
    }
    digest = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return FusionResult(arrived, signals, spoof, reasons, digest, primary, assurance)
