"""Live feed end to end against a local stand-in for wss://stream.aisstream.io (same message shapes)."""
import asyncio
import json
import threading

import pytest

from tests.conftest import DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")


def test_aisstream_feed_reaches_map_and_positions(client):
    import websockets

    from app import live as live_mod
    from app.config import get_settings
    from app.db import SessionLocal

    got_subs = []

    async def handler(ws):
        sub = json.loads(await ws.recv())
        got_subs.append(sub)
        if sub.get("APIKey") != "test-key":
            await ws.send(json.dumps({"error": "Api Key Is Not Valid"}))
            return
        if sub.get("FiltersShipMMSI"):
            msgs = [("470118320", 25.11, 55.16, 37, "YAS FALCON")]  # our fleet, far from its berth
        else:
            msgs = [("247123456", 25.08, 55.13, 37, "SEA BREEZE"), ("636000001", 25.12, 55.2, 70, "CARGO")]
        for mmsi, lat, lon, typ, name in msgs:
            await ws.send(json.dumps({"MessageType": "PositionReport",
                                      "MetaData": {"MMSI": int(mmsi), "ShipName": name, "latitude": lat, "longitude": lon,
                                                   "time_utc": "2026-10-29 01:02:03 +0000 UTC"},
                                      "Message": {"PositionReport": {"UserID": int(mmsi), "Latitude": lat, "Longitude": lon,
                                                                     "Sog": 9.1, "Cog": 45, "TrueHeading": 44}}}))
            await ws.send(json.dumps({"MessageType": "ShipStaticData", "MetaData": {"MMSI": int(mmsi)},
                                      "Message": {"ShipStaticData": {"UserID": int(mmsi), "Name": name, "Type": typ,
                                                                     "Dimension": {"A": 40, "B": 7}}}}))
        await asyncio.sleep(6.5)  # long enough for one flush of fleet positions
        await ws.send(json.dumps({"MessageType": "PositionReport", "MetaData": {"MMSI": 1},
                                  "Message": {"PositionReport": {"UserID": 1, "Latitude": 0, "Longitude": 0}}}))
        await asyncio.sleep(0.5)

    s = get_settings()
    old = (s.aisstream_api_key, s.aisstream_url)
    stop = asyncio.Event()

    async def main():
        async with websockets.serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            s.aisstream_api_key, s.aisstream_url = "test-key", f"ws://127.0.0.1:{port}"
            task = asyncio.create_task(live_mod.run(SessionLocal, stop))
            await asyncio.sleep(8)
            stop.set()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    try:
        asyncio.run(main())
    finally:
        s.aisstream_api_key, s.aisstream_url = old

    assert len(got_subs) >= 2 and any("470118320" in x.get("FiltersShipMMSI", []) for x in got_subs)
    yachts = client.get("/live/vessels").json()["features"]
    by = {f["properties"]["mmsi"]: f["properties"] for f in yachts}
    assert by["247123456"]["kind"] == "yacht" and by["470118320"]["kind"] == "fleet"
    assert "636000001" not in by  # cargo ship only in kind=all
    assert any(f["properties"]["mmsi"] == "636000001" for f in client.get("/live/vessels", params={"kind": "all"}).json()["features"])
    assert client.get("/live/vessels", params={"bbox": "0,0,1"}).status_code == 422
    # the fleet yacht's AIS fix was written to positions and shows on the fleet layer
    from sqlalchemy import text
    with SessionLocal() as db:
        n = db.execute(text("SELECT count(*) FROM positions WHERE yacht_id='YACHT-000007' AND raw->>'provider'='aisstream'")).scalar()
    assert n >= 1
    fleet = {f["properties"]["id"]: f for f in client.get("/live/fleet").json()["features"]}
    assert "YACHT-000007" in fleet and fleet["YACHT-000007"]["properties"]["source"] in ("gps", "ais")
    st = client.get("/live/status").json()
    assert st["messages"] >= 3 and "aisstream" in st and "digitraffic" in st


def test_recent_proofs_public(client):
    r = client.get("/proofs/recent", params={"limit": 5})
    assert r.status_code == 200
    rows = r.json()
    assert rows and len(rows) <= 5 and all(len(x["leaf"]) == 64 and x["anchor_id"] for x in rows)
