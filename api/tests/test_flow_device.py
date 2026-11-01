"""Software tracking from a signed-in phone or laptop: permissions, fix checks, crew, fleet map, arrival."""
from datetime import datetime, timedelta, timezone

import pytest

from app import fusion
from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")

DXB = (25.0805, 55.1403)  # Dubai Marina


def now(sec=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=sec)).isoformat()


def signup(client, name, email):
    r = client.post("/auth/signup", json={"name": name, "email": email, "password": "Bowline2026"})
    assert r.status_code == 201, r.text
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    client.patch(f"/admin/users/{r.json()['user']['id']}", headers=ADMIN, json={"status": "active"})
    return {"Authorization": f"Bearer {client.get('/auth/me', headers=h).json()['token']}"}


@pytest.fixture(scope="module")
def boat(client):
    owner = signup(client, "Amina Said", "amina.device@example.com")
    y = client.post("/yachts", headers=owner, json={
        "name": "Kusi Breeze", "flag": "Kenya", "loa_m": 18, "beam_m": 5, "home_marina_id": "MARINA-DXB-001", "documents": []})
    assert y.status_code == 201, y.text
    return {"owner": owner, "yacht": y.json()["id"]}


def test_only_owner_crew_or_admin_can_share(client, boat, admin_bearer):
    y = boat["yacht"]
    stranger = signup(client, "Peter Otieno", "peter.device@example.com")
    assert client.post(f"/yachts/{y}/device/start", json={}).status_code == 401
    assert client.post(f"/yachts/{y}/device/start", headers=stranger, json={}).status_code == 403
    assert client.post("/yachts/YACHT-NOPE/device/start", headers=stranger, json={}).status_code == 404
    # owner adds the stranger as captain, who may then share
    assert client.post(f"/yachts/{y}/crew", headers=stranger, json={"email": "peter.device@example.com"}).status_code == 403
    assert client.post(f"/yachts/{y}/crew", headers=boat["owner"], json={"email": "nobody@example.com"}).status_code == 404
    r = client.post(f"/yachts/{y}/crew", headers=boat["owner"], json={"email": "peter.device@example.com", "role": "captain"})
    assert r.status_code == 201 and r.json()["role"] == "captain"
    assert [c["name"] for c in client.get(f"/yachts/{y}/crew", headers=boat["owner"]).json()] == ["Peter Otieno"]
    mine = client.get("/me/trackable", headers=stranger).json()
    assert [(t["id"], t["role"]) for t in mine["yachts"]] == [(y, "crew")] and mine["settings"]["enabled"]
    s = client.post(f"/yachts/{y}/device/start", headers=stranger, json={"label": "Captain's phone"})
    assert s.status_code == 201
    # removing crew ends their session
    assert client.delete(f"/yachts/{y}/crew/{client.get('/auth/me', headers=stranger).json()['id']}",
                         headers=boat["owner"]).status_code == 200
    assert client.post(f"/yachts/{y}/device/fix", headers=stranger, json={
        "session_id": s.json()["session_id"], "lat": DXB[0], "lon": DXB[1], "accuracy_m": 10, "observed_at": now()}).status_code == 403
    assert client.post(f"/yachts/{y}/device/start", headers=admin_bearer, json={}).json()["role"] == "admin"


def test_fix_checks_and_storage(client, boat):
    h, y = boat["owner"], boat["yacht"]
    sid = client.post(f"/yachts/{y}/device/start", headers=h, json={"label": "Amina's iPhone"}).json()["session_id"]
    fix = lambda **k: client.post(f"/yachts/{y}/device/fix", headers=h, json={"session_id": sid, **k})
    base = dict(lat=DXB[0], lon=DXB[1], accuracy_m=8)
    assert fix(**{**base, "accuracy_m": 5000}, observed_at=now()).json()["code"] == "LOW_ACCURACY"
    assert fix(**base, observed_at=now(600)).json()["code"] == "CLOCK_AHEAD"
    assert fix(**base, observed_at=now(-3600)).json()["code"] == "TOO_OLD"
    ok = fix(**base, observed_at=now(-50), speed_mps=0.5, heading_deg=90).json()
    assert ok == {"accepted": True, "good": True, "flags": []}
    assert fix(**base, observed_at=now(-45)).json()["code"] == "THROTTLED"
    # 20 km in 15 s is not a boat: stored, flagged, not "good"
    jump = fix(lat=DXB[0] + 0.18, lon=DXB[1], accuracy_m=8, observed_at=now(-35)).json()
    assert jump["accepted"] and not jump["good"] and jump["flags"][0].startswith("JUMP_")
    vague = fix(lat=DXB[0] + 0.18, lon=DXB[1] + 0.0005, accuracy_m=300, observed_at=now(-22)).json()
    assert vague["accepted"] and not vague["good"]
    # a batch uploaded after a dead zone
    batch = client.post(f"/yachts/{y}/device/fixes", headers=h, json={"session_id": sid, "fixes": [
        {**base, "observed_at": now(-7)}, {**base, "observed_at": now(-10)}]}).json()
    assert batch["accepted"] == 1  # second one is within the throttle window once sorted
    sess = client.get(f"/yachts/{y}/device/sessions", headers=h).json()[0]
    assert sess["label"] == "Amina's iPhone" and sess["fixes"] == 4 and sess["rejected"] == 3 and sess["shared_by"] == "Amina Said"
    tr = client.get(f"/track/{y}?hours=1", headers=h).json()
    dev = [p for p in tr["positions"] if p["source"] == "device"]
    assert len(dev) == 4 and dev[0]["accuracy_m"] == 8 and dev[0]["verified"]
    assert {"DEVICE_TRACKING_STARTED"} <= {e["event_type"] for e in tr["events"]}
    assert client.post(f"/yachts/{y}/device/stop", headers=h, json={"session_id": sid}).json()["stopped"]
    assert fix(**base, observed_at=now()).status_code == 409
    assert "DEVICE_TRACKING_STOPPED" in {e["event_type"] for e in client.get(f"/track/{y}?hours=1", headers=h).json()["events"]}


def test_device_yacht_on_fleet_map(client, boat, admin_bearer):
    y = boat["yacht"]
    # minted yachts only appear on the public map; mint this one through the admin flow if available
    from sqlalchemy import text
    from app.db import engine
    with engine.begin() as c:
        c.execute(text("UPDATE yachts SET twin_status='minted' WHERE id=:y"), {"y": y})
    feats = {f["properties"]["id"]: f for f in client.get("/live/fleet").json()["features"]}
    p = feats[y]["properties"]
    assert p["source"] == "device" and p["accuracy_m"] is not None
    mon = {m["id"]: m for m in client.get("/admin/monitoring", headers=admin_bearer).json()}
    assert any("phone or laptop" in a["text"] for a in mon[y]["alerts"])


def test_fusion_device_stands_in_for_gps():
    t = datetime.now(timezone.utc)
    dev = fusion.Obs("device", 25.0806, 55.1404, t, verified=True)
    ais = fusion.Obs("ais", 25.0807, 55.1402, t)
    r = fusion.fuse_arrival(*DXB, 300, 18, gps=None, ais=ais, sar=None, device=dev)
    assert r.arrived and r.primary == "device" and r.assurance == "standard"
    assert r.signals[1].source == "device"
    # device alone is never enough
    assert not fusion.fuse_arrival(*DXB, 300, 18, gps=None, ais=None, sar=None, device=dev).arrived
    # a vague device fix does not count
    vague = fusion.Obs("device", 25.0806, 55.1404, t, verified=False)
    r = fusion.fuse_arrival(*DXB, 300, 18, gps=None, ais=ais, sar=None, device=vague)
    assert not r.arrived and "DEVICE_FIX_TOO_VAGUE" in r.reasons
    # signed hardware GPS always wins when present
    gps = fusion.Obs("gps", 25.0805, 55.1403, t, verified=True)
    r = fusion.fuse_arrival(*DXB, 300, 18, gps=gps, ais=ais, sar=None, device=dev)
    assert r.primary == "gps" and r.assurance == "high"
    assert r.digest == fusion.fuse_arrival(*DXB, 300, 18, gps=gps, ais=ais, sar=None).digest
