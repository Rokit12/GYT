"""Tracker + AIS + SAR simulator for local development.

Sends signed GPS fixes the way an onboard tracker would, plus matching AIS and an occasional
satellite detection, so the fusion and escrow flows can be exercised end to end.

    python -m app.simulate arrive YACHT-000007 MARINA-DXB-001   # put a yacht at a marina
    python -m app.simulate loop                                  # move underway yachts forever
"""
from __future__ import annotations

import json
import math
import random
import sys
import time
from datetime import datetime, timezone

import httpx

from .config import get_settings
from .seed import KEYS_FILE, MARINAS, YACHTS
from .signing import gps_message, sign

API = "http://localhost:8000"
MARINA = {m[0]: m for m in MARINAS}


def _jitter(lat, lon, metres):
    d = metres / 111_320
    return lat + random.uniform(-d, d), lon + random.uniform(-d, d) / max(0.2, math.cos(math.radians(lat)))


def send_gps(client, keys, yacht_id, lat, lon):
    tid, k = next((t, v) for t, v in keys.items() if v["yacht_id"] == yacht_id)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    sig = sign(k["private_key"], gps_message(tid, yacht_id, lat, lon, now))
    r = client.post(f"{API}/tracking/gps", json=dict(tracker_id=tid, yacht_id=yacht_id, lat=lat, lon=lon,
                                                       observed_at=now.isoformat(), signature=sig))
    r.raise_for_status()


def arrive(yacht_id: str, marina_id: str):
    keys = json.loads(KEYS_FILE.read_text())
    m = MARINA[marina_id]
    y = next(y for y in YACHTS if y[0] == yacht_id)
    admin = {"X-Admin-Token": get_settings().admin_token}
    with httpx.Client(timeout=20) as c:
        lat, lon = _jitter(m[3], m[4], 120)
        send_gps(c, keys, yacht_id, lat, lon)
        a_lat, a_lon = _jitter(m[3], m[4], 150)
        now = datetime.now(timezone.utc).isoformat()
        c.post(f"{API}/tracking/ais", headers=admin,
               json=[dict(mmsi=y[2], lat=a_lat, lon=a_lon, observed_at=now, sog_kn=0.2)]).raise_for_status()
        s_lat, s_lon = _jitter(m[3], m[4], 200)
        c.post(f"{API}/tracking/sar", headers=admin,
               json=dict(yacht_id=yacht_id, lat=s_lat, lon=s_lon, observed_at=now, est_length_m=y[4] + random.uniform(-2, 2),
                         provider="simulated")).raise_for_status()
    print(f"{yacht_id} placed at {m[1]} with GPS, AIS and SAR observations")


def loop():
    keys = json.loads(KEYS_FILE.read_text())
    routes = {"YACHT-000002": ("MARINA-MCO-001", "MARINA-OLB-001"), "YACHT-000003": ("MARINA-MBA-001", "MARINA-ZNZ-001"),
              "YACHT-000007": ("MARINA-AUH-002", "MARINA-DXB-001")}
    t = 0.0
    with httpx.Client(timeout=20) as c:
        while True:
            t = (t + 0.01) % 2
            f = t if t <= 1 else 2 - t
            for yid, (a, b) in routes.items():
                A, B = MARINA[a], MARINA[b]
                send_gps(c, keys, yid, A[3] + (B[3] - A[3]) * f, A[4] + (B[4] - A[4]) * f)
            time.sleep(30)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "loop"
    arrive(sys.argv[2], sys.argv[3]) if cmd == "arrive" else loop()
