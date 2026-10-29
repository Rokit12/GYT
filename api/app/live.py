"""Live AIS for the maps, from two free providers.

* aisstream.io: worldwide websocket feed, free API key from https://aisstream.io.
* Digitraffic (Fintraffic, Finland): open REST API, no key, CC BY 4.0. Covers the Baltic around
  Finland. Runs by default so the live map has real traffic out of the box.

One websocket connection subscribes to boxes around every partner marina plus the MMSIs of our
fleet. Every vessel heard is kept in a small in-memory cache for the live map; positions from our
own fleet are also written to the `positions` table (source 'ais'), throttled per vessel, so the
fusion engine and the admin monitoring see them.

aisstream.io asks that keys are not used from browsers, so the browser only talks to this API.
Message shapes follow https://github.com/aisstream/ais-message-models (type-definition.yaml).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from sqlalchemy import text

from .config import get_settings

log = logging.getLogger("gyt.live")

POSITION_TYPES = ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport")
STATIC_TYPES = ("ShipStaticData", "StaticDataReport", "ExtendedClassBPositionReport")
YACHT_TYPES = {36, 37}  # AIS ship type 36 = sailing, 37 = pleasure craft


@dataclass
class Vessel:
    mmsi: str
    lat: float
    lon: float
    name: str = ""
    sog: float | None = None
    cog: float | None = None
    heading: float | None = None
    ship_type: int | None = None
    length_m: float | None = None
    fleet_id: str | None = None
    updated: float = field(default_factory=time.time)

    @property
    def kind(self) -> str:
        if self.fleet_id:
            return "fleet"
        return "yacht" if self.ship_type in YACHT_TYPES else "vessel"


def _num(v, lo=None, hi=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if lo is not None and not lo <= f <= hi:
        return None
    return f


class LiveAIS:
    def __init__(self, max_vessels: int = 5000, stale_seconds: int = 1800):
        self.vessels: dict[str, Vessel] = {}
        self.fleet: dict[str, str] = {}  # mmsi -> yacht id
        self.status = "off"
        self.error: str | None = None
        self.messages = 0
        self.last_message_at: float | None = None
        self.max_vessels = max_vessels
        self.stale_seconds = stale_seconds
        self._last_write: dict[str, float] = {}
        self.pending_positions: list[tuple] = []
        self.dt_status = "off"
        self.dt_meta: dict[str, dict] = {}

    # ---------------------------------------------------------------- parsing
    def handle(self, msg: dict) -> Vessel | None:
        """Apply one aisstream message to the cache. Returns the updated vessel, if any."""
        mtype = msg.get("MessageType")
        meta = msg.get("MetaData") or {}
        body = (msg.get("Message") or {}).get(mtype) or {}
        mmsi = str(meta.get("MMSI") or body.get("UserID") or "").strip()
        if not mmsi or not mmsi.isdigit():
            return None
        self.messages += 1
        self.last_message_at = time.time()
        v = self.vessels.get(mmsi)

        if mtype in POSITION_TYPES:
            lat = _num(body.get("Latitude", meta.get("latitude")), -90, 90)
            lon = _num(body.get("Longitude", meta.get("longitude")), -180, 180)
            # AIS uses 91 / 181 for "not available"
            if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
                return None
            if v is None:
                v = Vessel(mmsi=mmsi, lat=lat, lon=lon)
                self.vessels[mmsi] = v
            v.lat, v.lon, v.updated = lat, lon, time.time()
            sog = _num(body.get("Sog"))
            v.sog = sog if sog is not None and sog < 102.3 else None
            cog = _num(body.get("Cog"))
            v.cog = cog if cog is not None and cog < 360 else None
            hdg = _num(body.get("TrueHeading"))
            v.heading = hdg if hdg is not None and hdg < 360 else None
            name = (meta.get("ShipName") or "").strip()
            if name:
                v.name = name
            v.fleet_id = self.fleet.get(mmsi)
            if v.fleet_id:
                self._queue_fleet_position(v, meta.get("time_utc"))

        if mtype in STATIC_TYPES:
            if v is None:
                lat = _num(meta.get("latitude"), -90, 90)
                lon = _num(meta.get("longitude"), -180, 180)
                if lat is None or lon is None:
                    return None
                v = Vessel(mmsi=mmsi, lat=lat, lon=lon)
                self.vessels[mmsi] = v
            src = body
            if mtype == "StaticDataReport":
                a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
                if a.get("Valid") and a.get("Name"):
                    v.name = str(a["Name"]).strip()
                src = b if b.get("Valid") else {}
                stype = src.get("ShipType")
            else:
                if body.get("Name"):
                    v.name = str(body["Name"]).strip()
                stype = src.get("Type")
            if stype is not None:
                try:
                    v.ship_type = int(stype)
                except (TypeError, ValueError):
                    pass
            dim = src.get("Dimension") or {}
            length = (_num(dim.get("A")) or 0) + (_num(dim.get("B")) or 0)
            if length:
                v.length_m = length
            v.fleet_id = self.fleet.get(mmsi)
        self._evict()
        return v

    def _queue_fleet_position(self, v: Vessel, time_utc: str | None, provider: str = "aisstream", at: datetime | None = None):
        now = time.time()
        if now - self._last_write.get(v.mmsi, 0) < 60:  # at most one stored fix per minute per yacht
            return
        self._last_write[v.mmsi] = now
        ts = at or _parse_time(time_utc) or datetime.now(timezone.utc)
        self.pending_positions.append((v.fleet_id, ts, v.lat, v.lon, v.sog, v.cog, provider))

    def _evict(self):
        if len(self.vessels) <= self.max_vessels:
            return
        cutoff = sorted(x.updated for x in self.vessels.values())[len(self.vessels) - self.max_vessels]
        for k in [k for k, x in self.vessels.items() if x.updated < cutoff and not x.fleet_id]:
            del self.vessels[k]

    # ---------------------------------------------------------------- Digitraffic
    def handle_digitraffic_location(self, f: dict) -> Vessel | None:
        """One feature from GET /api/ais/v1/locations (GeoJSON, [lon, lat])."""
        p = f.get("properties") or {}
        mmsi = str(p.get("mmsi") or f.get("mmsi") or "")
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if not mmsi.isdigit() or len(coords) < 2:
            return None
        lon, lat = _num(coords[0], -180, 180), _num(coords[1], -90, 90)
        if lat is None or lon is None:
            return None
        ts = (p.get("timestampExternal") or 0) / 1000 or time.time()
        v = self.vessels.get(mmsi)
        if v is None:
            v = self.vessels[mmsi] = Vessel(mmsi=mmsi, lat=lat, lon=lon)
        elif ts < v.updated:
            return v  # older than what we already have
        v.lat, v.lon, v.updated = lat, lon, min(ts, time.time())
        sog, cog, hdg = _num(p.get("sog")), _num(p.get("cog")), _num(p.get("heading"))
        v.sog = sog if sog is not None and sog < 102.3 else None
        v.cog = cog if cog is not None and cog < 360 else None
        v.heading = hdg if hdg is not None and hdg < 360 else None
        v.fleet_id = self.fleet.get(mmsi)
        if v.fleet_id:
            self._queue_fleet_position(v, None, provider="digitraffic", at=datetime.fromtimestamp(v.updated, timezone.utc))
        self.messages += 1
        self.last_message_at = time.time()
        return v

    def handle_digitraffic_vessel(self, meta: dict):
        """One record from GET /api/ais/v1/vessels: name, ship type and size."""
        mmsi = str(meta.get("mmsi") or "")
        if mmsi:
            self.dt_meta[mmsi] = meta
            v = self.vessels.get(mmsi)
            if v:
                self._apply_meta(v, meta)

    def _apply_meta(self, v: Vessel, meta: dict):
        if meta.get("name"):
            v.name = str(meta["name"]).strip()
        if meta.get("shipType") is not None:
            v.ship_type = int(meta["shipType"])
        length = (_num(meta.get("referencePointA")) or 0) + (_num(meta.get("referencePointB")) or 0)
        if length:
            v.length_m = length

    def apply_digitraffic(self, fc: dict) -> int:
        n = 0
        for f in fc.get("features") or []:
            v = self.handle_digitraffic_location(f)
            if v is not None:
                n += 1
                if v.mmsi in self.dt_meta and (not v.name or v.ship_type is None):
                    self._apply_meta(v, self.dt_meta[v.mmsi])
        self._evict()
        return n

    # ---------------------------------------------------------------- reading
    def snapshot(self, bbox: tuple[float, float, float, float] | None = None, kind: str = "yachts") -> dict:
        now = time.time()
        feats = []
        for v in self.vessels.values():
            if now - v.updated > self.stale_seconds:
                continue
            if bbox and not (bbox[0] <= v.lon <= bbox[2] and bbox[1] <= v.lat <= bbox[3]):
                continue
            k = v.kind
            if kind == "yachts" and k == "vessel":
                continue
            if kind == "fleet" and k != "fleet":
                continue
            p = {key: val for key, val in asdict(v).items() if key not in ("lat", "lon", "updated")}
            p.update(kind=k, age_s=round(now - v.updated))
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [v.lon, v.lat]}, "properties": p})
        return {"type": "FeatureCollection", "features": feats}

    def state(self) -> dict:
        s = get_settings()
        providers = []
        if s.aisstream_api_key:
            providers.append("aisstream.io")
        if s.digitraffic_enabled:
            providers.append("Digitraffic")
        status = self.status
        if status == "off" and self.dt_status == "live":
            status = "live"
        return {
            "provider": " + ".join(providers) or "none",
            "providers": providers,
            "enabled": bool(providers),
            "status": status,
            "aisstream": self.status,
            "digitraffic": self.dt_status,
            "error": self.error,
            "vessels": len(self.vessels),
            "messages": self.messages,
            "last_message_at": self.last_message_at,
        }

    # ---------------------------------------------------------------- persistence
    def flush(self, db) -> int:
        rows, self.pending_positions = self.pending_positions, []
        for yid, ts, lat, lon, sog, cog, provider in rows:
            db.execute(
                text("""INSERT INTO positions (yacht_id,source,observed_at,location,sog_kn,cog_deg,verified,raw)
                        VALUES (:y,'ais',:t,ST_MakePoint(:lon,:lat)::geography,:sog,:cog,FALSE,CAST(:raw AS jsonb))"""),
                dict(y=yid, t=ts, lat=lat, lon=lon, sog=sog, cog=cog, raw=json.dumps({"provider": provider})),
            )
        if rows:
            db.commit()
        return len(rows)


def _parse_time(s: str | None) -> datetime | None:
    if not s:
        return None
    # aisstream sends e.g. "2026-10-29 01:02:03.123456789 +0000 UTC"
    try:
        core = s.split(" +")[0].strip()
        if "." in core:
            head, frac = core.split(".")
            core = f"{head}.{frac[:6]}"
            return datetime.strptime(core, "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
        return datetime.strptime(core, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def subscriptions(api_key: str, marinas: list[tuple[float, float]], fleet_mmsis: list[str], box_deg: float) -> list[dict]:
    """Two subscriptions: traffic around partner marinas, and our fleet anywhere in the world.

    aisstream boxes are [[lat1, lon1], [lat2, lon2]]; FiltersShipMMSI takes at most 50 MMSIs.
    """
    types = sorted(set(POSITION_TYPES + STATIC_TYPES))
    subs = []
    if marinas:
        subs.append({"APIKey": api_key, "FilterMessageTypes": types,
                     "BoundingBoxes": [[[lat - box_deg, lon - box_deg], [lat + box_deg, lon + box_deg]] for lat, lon in marinas]})
    for i in range(0, len(fleet_mmsis), 50):
        subs.append({"APIKey": api_key, "FilterMessageTypes": types, "BoundingBoxes": [[[-90, -180], [90, 180]]],
                     "FiltersShipMMSI": fleet_mmsis[i:i + 50]})
    return subs


live = LiveAIS()


def load_targets(db) -> tuple[list[tuple[float, float]], dict[str, str]]:
    marinas = [(r.lat, r.lon) for r in db.execute(
        text("SELECT ST_Y(location::geometry) lat, ST_X(location::geometry) lon FROM marinas"))]
    fleet = {r.mmsi: r.id for r in db.execute(
        text("SELECT id, mmsi FROM yachts WHERE mmsi IS NOT NULL AND retired_at IS NULL"))}
    return marinas, fleet


async def _connection(sub: dict, session_factory, stop: asyncio.Event | None):
    import websockets

    s = get_settings()
    backoff = 2
    while not (stop and stop.is_set()):
        try:
            async with websockets.connect(s.aisstream_url, compression="deflate", open_timeout=20, max_size=2**22) as ws:
                await ws.send(json.dumps(sub))
                live.status, live.error = "live", None
                backoff = 2
                last_flush = time.time()
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if "error" in msg and "MessageType" not in msg:  # e.g. {"error": "Api Key Is Not Valid"}
                        raise RuntimeError(str(msg["error"]))
                    live.handle(msg)
                    if time.time() - last_flush > 5 and live.pending_positions:
                        with session_factory() as db:
                            await asyncio.to_thread(live.flush, db)
                        last_flush = time.time()
                    if stop and stop.is_set():
                        break
        except asyncio.CancelledError:
            raise
        except Exception as e:  # network drops are normal; the map keeps what it has
            live.status, live.error = "reconnecting", str(e)[:200]
            log.warning("aisstream: %s; retrying in %ss", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 120)


async def run_digitraffic(session_factory, stop: asyncio.Event | None = None, client=None):
    """Poll Digitraffic's open AIS API (no key). Locations every `digitraffic_poll_seconds`,
    vessel names and types every 15 minutes. Licence: CC BY 4.0, Fintraffic / digitraffic.fi."""
    import httpx

    s = get_settings()
    if not s.digitraffic_enabled:
        return
    headers = {"Digitraffic-User": s.digitraffic_user, "Accept-Encoding": "gzip"}
    own = client is None
    client = client or httpx.AsyncClient(base_url=s.digitraffic_url, headers=headers, timeout=30)
    last_ms, last_meta, backoff = int((time.time() - 900) * 1000), 0.0, s.digitraffic_poll_seconds
    try:
        while not (stop and stop.is_set()):
            try:
                if time.time() - last_meta > 900:
                    r = await client.get("/api/ais/v1/vessels", params={"from": int((time.time() - 86400 * 7) * 1000)})
                    r.raise_for_status()
                    for meta in r.json():
                        live.handle_digitraffic_vessel(meta)
                    last_meta = time.time()
                r = await client.get("/api/ais/v1/locations", params={"from": last_ms})
                r.raise_for_status()
                live.apply_digitraffic(r.json())
                last_ms = int((time.time() - 120) * 1000)  # small overlap; older fixes are ignored
                live.dt_status, backoff = "live", s.digitraffic_poll_seconds
                if live.pending_positions:
                    with session_factory() as db:
                        await asyncio.to_thread(live.flush, db)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                live.dt_status, live.error = "reconnecting", f"digitraffic: {str(e)[:180]}"
                log.warning("digitraffic: %s", e)
                backoff = min(backoff * 2, 600)
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff) if stop else await asyncio.sleep(backoff)
            except asyncio.TimeoutError:
                pass
    finally:
        live.dt_status = "off"
        if own:
            await client.aclose()


async def run(session_factory, stop: asyncio.Event | None = None):
    """Run every subscription until `stop` is set (or the task is cancelled)."""
    s = get_settings()
    with session_factory() as db:
        marinas, live.fleet = await asyncio.to_thread(load_targets, db)
    if not s.aisstream_api_key:
        live.status = "off"
        return
    live.status = "connecting"
    subs = subscriptions(s.aisstream_api_key, marinas, list(live.fleet), s.live_box_deg)
    try:
        await asyncio.gather(*(_connection(sub, session_factory, stop) for sub in subs))
    finally:
        live.status = "off"
