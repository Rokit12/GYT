"""End-to-end flow against a real PostgreSQL + PostGIS database.

Runs only when TEST_DATABASE_URL is set (the schema is dropped and re-created). If CHAIN_RPC,
ANCHOR_PRIVATE_KEY and PROOF_REGISTRY_ADDRESS are also set, anchoring goes on-chain and the
proof is verified by the ProofRegistry contract itself.
"""
import json
import os
from datetime import date, datetime, timedelta, timezone

import pytest

from tests.conftest import ADMIN, DB  # noqa: E402

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")


def keys():
    from app.seed import KEYS_FILE

    return json.loads(KEYS_FILE.read_text())


def signed_fix(yacht_id, lat, lon, ts=None):
    from app.signing import gps_message, sign

    tid, k = next((t, v) for t, v in keys().items() if v["yacht_id"] == yacht_id)
    ts = (ts or datetime.now(timezone.utc)).replace(microsecond=0)
    return dict(tracker_id=tid, yacht_id=yacht_id, lat=lat, lon=lon, observed_at=ts.isoformat(),
                signature=sign(k["private_key"], gps_message(tid, yacht_id, lat, lon, ts)))


def test_fleet_and_passport(client):
    ys = client.get("/yachts").json()
    assert len(ys) == 8
    p = client.get("/yachts/YACHT-000006").json()
    assert p["condition"]["score"] < 85  # uninsured
    assert any(f["label"] == "Insurance not verified" for f in p["condition"]["factors"])


def test_onboarding_creates_twin_with_docs_root(client, client_bearer):
    docs = [{"kind": "registry", "filename": "reg.pdf", "sha256": "ab" * 32}, {"kind": "survey", "filename": "s.pdf", "sha256": "cd" * 32}]
    r = client.post("/yachts", headers=client_bearer, json=dict(
        name="Lamu Breeze", mmsi="634012455", flag="Kenya", loa_m=32, beam_m=7.2, year_built=2020,
        home_marina_id="MARINA-MBA-001", berth_code="K-2", valuation_usd=5.6e6, charter_week_usd=44000,
        units_total=10000, documents=docs))
    assert r.status_code == 201, r.text
    assert r.json()["id"] == "YACHT-000009" and len(r.json()["docs_root"]) == 64
    assert r.json()["twin_status"] == "pending"
    assert all(y["id"] != "YACHT-000009" for y in client.get("/yachts").json())  # not public until minted
    dup = client.post("/yachts", headers=client_bearer, json=dict(name="Copy", mmsi="634012455", flag="Kenya", loa_m=30, beam_m=7,
                                                          home_marina_id="MARINA-MBA-001"))
    assert dup.status_code == 409


def test_onboarding_requires_sign_in(client):
    r = client.post("/yachts", json=dict(name="x", flag="x", loa_m=10, beam_m=3, home_marina_id="MARINA-MBA-001"))
    assert r.status_code == 401


def test_berth_search_and_double_booking(client, client_bearer):
    arrive, depart = date.today() + timedelta(days=1), date.today() + timedelta(days=4)
    found = client.get("/berths/search", params=dict(loa_m=47, beam_m=9, arrive=arrive, depart=depart, region="Gulf")).json()
    codes = [b["code"] for b in found]
    assert "A040" in codes and "B128" not in codes  # B128 is too short for a 47 m yacht
    a040 = next(b for b in found if b["code"] == "A040")
    anon = client.post("/bookings/berth", json=dict(ref="BK-4097", yacht_id="YACHT-000007", berth_id=a040["id"],
                                                   arrive=str(arrive), depart=str(depart)))
    assert anon.status_code == 401
    ok = client.post("/bookings/berth", headers=client_bearer, json=dict(ref="BK-4098", yacht_id="YACHT-000007", berth_id=a040["id"],
                                                  arrive=str(arrive), depart=str(depart)))
    assert ok.status_code == 201 and ok.json()["amount_usd"] == 2100 * 3
    clash = client.post("/bookings/berth", headers=client_bearer, json=dict(ref="BK-4099", yacht_id="YACHT-000002", berth_id=a040["id"],
                                                     arrive=str(arrive + timedelta(days=1)), depart=str(depart + timedelta(days=2))))
    assert clash.status_code == 409 and "already booked" in clash.json()["detail"]
    after = client.get("/berths/search", params=dict(loa_m=47, beam_m=9, arrive=arrive, depart=depart, region="Gulf")).json()
    assert "A040" not in [b["code"] for b in after]


def test_gps_signature_enforced(client):
    fix = signed_fix("YACHT-000007", 25.091, 55.141)
    fix["lat"] = 25.2  # tampered after signing
    assert client.post("/tracking/gps", json=fix).status_code == 422
    other = signed_fix("YACHT-000007", 25.091, 55.141)
    other["yacht_id"] = "YACHT-000001"
    assert client.post("/tracking/gps", json=other).status_code == 403


def test_arrival_not_proven_without_corroboration(client):
    assert client.post("/tracking/gps", json=signed_fix("YACHT-000007", 25.0905, 55.1405)).status_code == 202
    r = client.post("/bookings/BK-4098/arrival", headers=ADMIN).json()
    assert r["arrived"] is False and "NO_INDEPENDENT_CORROBORATION" in r["reasons"]


def test_arrival_anchor_release_and_verify(client):
    now = datetime.now(timezone.utc).isoformat()
    client.post("/tracking/ais", headers=ADMIN, json=[dict(mmsi="470118320", lat=25.0908, lon=55.1402, observed_at=now)])
    client.post("/tracking/sar", headers=ADMIN, json=dict(yacht_id="YACHT-000007", lat=25.0899, lon=55.1398,
                                                         observed_at=now, est_length_m=46.0))
    r = client.post("/bookings/BK-4098/arrival", headers=ADMIN).json()
    assert r["arrived"] is True, r
    assert all(sig["ok"] for sig in r["signals"])

    early = client.post("/bookings/BK-4098/release", headers=ADMIN)
    assert early.status_code == 409  # not anchored yet

    a = client.post("/anchors", headers=ADMIN).json()
    assert a["leaf_count"] >= 1

    p = client.get(f"/proofs/{r['arrival_event_id']}").json()
    assert p["anchored"] and p["verified_offchain"] and p["leaf"] == r["leaf"]

    rel = client.post("/bookings/BK-4098/release", headers=ADMIN).json()
    assert rel["status"] == "released"
    assert rel["escrow_call"]["proof"] == ["0x" + x for x in p["proof"]]

    from app.chain import ChainClient

    chain = ChainClient()
    if chain.enabled:
        assert a["chain_tx"] and p["chain_index"] is not None
        ok = chain.verify(bytes.fromhex(p["leaf"]), [bytes.fromhex(x) for x in p["proof"]], p["leaf_index"], p["chain_index"])
        assert ok is True


def test_yachts_near_uses_postgis(client):
    near = client.get("/yachts-near", params=dict(lat=25.09, lon=55.14, km=5)).json()
    assert near and near[0]["yacht_id"] == "YACHT-000007" and near[0]["distance_m"] < 500
    track = client.get("/yachts/YACHT-000007/track", params=dict(hours=1)).json()
    assert track["properties"]["points"] >= 1


def test_use_or_earn(client, admin_bearer, client_bearer):
    other = client.post("/investors/INV-1043/stays", headers=client_bearer, json=dict(
        ref="CS-7299", yacht_id="YACHT-000003", arrive=str(date.today() + timedelta(days=30)), nights=1))
    assert other.status_code == 403  # not this client's wallet
    s = client.get("/investors/INV-1043/earn").json()
    assert s["use_credits_usd"] > 0 and s["earn_pool_usd"] > 0
    too_much = client.post("/investors/INV-1043/stays", headers=admin_bearer, json=dict(ref="CS-7300", yacht_id="YACHT-000004",
                                                                  arrive=str(date.today() + timedelta(days=30)), nights=14))
    assert too_much.status_code == 402
    uninsured = client.post("/investors/INV-1043/stays", headers=admin_bearer, json=dict(ref="CS-7301", yacht_id="YACHT-000006",
                                                                   arrive=str(date.today() + timedelta(days=30)), nights=1))
    assert uninsured.status_code == 422
    ok = client.post("/investors/INV-1043/stays", headers=admin_bearer, json=dict(ref="CS-7302", yacht_id="YACHT-000003",
                                                            arrive=str(date.today() + timedelta(days=30)), nights=3))
    assert ok.status_code == 201, ok.text
    after = client.get("/investors/INV-1043/earn").json()
    assert after["use_credits_left_usd"] == pytest.approx(s["use_credits_left_usd"] - ok.json()["credits_usd"], abs=0.01)


def test_compliance_preflight_and_kyc(client):
    blocked = client.post("/compliance/check-transfer", json=dict(investor_id="INV-1046", yacht_id="YACHT-000001", units=10)).json()
    assert not blocked["allowed"]
    assert client.post("/investors/INV-1044/kyc", headers=ADMIN, params={"status": "approved"}).status_code == 409
    ok = client.post("/compliance/check-transfer", json=dict(investor_id="INV-1043", yacht_id="YACHT-000001", units=500)).json()
    assert ok["allowed"], ok


def test_marina_dashboard(client):
    d = client.get("/marinas/MARINA-DXB-001/dashboard").json()
    assert len(d["berths"]) == 8 and any(a["ref"] == "BK-4098" for a in d["arrivals"])
