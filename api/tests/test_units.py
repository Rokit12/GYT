from datetime import date, datetime, timedelta, timezone

import pytest

from app import fusion, policy, proof, signing

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)

# ---------------------------------------------------------------- proof


def test_shared_vector_with_solidity():
    """Same vector is asserted in contracts/test/ProofAndEscrow.t.sol and web/lib/merkle.test.ts."""
    leaves = [proof.sha256(bytes([i])) for i in range(5)]
    assert proof.merkle_root(leaves).hex() == "9674600fd139741c0f7dd7a32d984a0e74401cc90e6e8e5d203ed973d27324fe"
    assert [p.hex() for p in proof.merkle_proof(leaves, 4)] == [
        "e52d9c508c502347344d8c07ad91cbd6068afc75ff6292f062a09ca381c89e71",
        "0e68f91a160a8a636202faf51d6b64cdc99ab3a1261f61f4556dc481997c66cb",
        "9675e04b4ba9dc81b06e81731e2d21caa2c95557a85dcfa3fff70c9ff0f30b2e",
    ]


def test_arrival_leaf_matches_solidity():
    leaf = proof.arrival_leaf(proof.to_bytes32("BK-4098"), 7, proof.to_bytes32("MARINA-DXB-001"), proof.sha256(b"fusion"))
    assert leaf.hex() == "18684d7cb64c93be014d1f7f75f63f077873c000c2f602b6d380c0db4e5d7060"


@pytest.mark.parametrize("n", [1, 2, 3, 7, 8, 33])
def test_every_leaf_proves(n):
    leaves = [proof.sha256(f"e{i}".encode()) for i in range(n)]
    root = proof.merkle_root(leaves)
    for i, leaf in enumerate(leaves):
        assert proof.compute_root(leaf, proof.merkle_proof(leaves, i), i) == root
    assert proof.compute_root(proof.sha256(b"forged"), proof.merkle_proof(leaves, 0), 0) != root


def test_canonical_event_is_stable():
    a = proof.canonical_event("YACHT-000001", "POSITION", NOW, "MARINA-DXB-001", "B128", 25.09, 55.14, "")
    assert a == b"YACHT-000001|POSITION|MARINA-DXB-001|B128|2026-10-28T12:00:00.000000Z|25.090000|55.140000|"


# ---------------------------------------------------------------- signing


def test_signature_roundtrip_and_tamper():
    priv, pub = signing.new_keypair()
    msg = signing.gps_message("TRK-1", "YACHT-000001", 25.09, 55.14, NOW)
    sig = signing.sign(priv, msg)
    assert signing.verify(pub, msg, sig)
    moved = signing.gps_message("TRK-1", "YACHT-000001", 25.10, 55.14, NOW)
    assert not signing.verify(pub, moved, sig)


# ---------------------------------------------------------------- fusion

DXB = (25.09, 55.14)


def obs(src, dlat=0.0, dlon=0.0, verified=True, length=None):
    return fusion.Obs(src, DXB[0] + dlat, DXB[1] + dlon, NOW, verified, length)


def test_arrival_with_gps_and_ais():
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps", 0.001), ais=obs("ais", 0.0015, verified=False), sar=None)
    assert r.arrived and not r.spoofing_suspected and len(r.digest) == 64


def test_no_signed_gps_means_no_arrival():
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=None, ais=obs("ais"), sar=obs("sar", length=35))
    assert not r.arrived and "GPS_MISSING" in r.reasons


def test_unsigned_gps_rejected():
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps", verified=False), ais=obs("ais"), sar=None)
    assert not r.arrived and "GPS_UNSIGNED" in r.reasons


def test_ais_spoof_requires_sar():
    far_ais = obs("ais", 0.3)  # ~33 km away from where GPS says
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps"), ais=far_ais, sar=None)
    assert not r.arrived and r.spoofing_suspected
    r2 = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps"), ais=far_ais, sar=obs("sar", 0.001, length=36))
    assert r2.arrived and r2.spoofing_suspected


def test_sar_hull_length_must_match():
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps"), ais=None, sar=obs("sar", length=80))
    assert not r.arrived


def test_gps_outside_radius():
    r = fusion.fuse_arrival(*DXB, 600, 35, gps=obs("gps", 0.02), ais=obs("ais", 0.02), sar=None)
    assert not r.arrived and "GPS_NOT_AT_TARGET" in r.reasons


# ---------------------------------------------------------------- policy

INV = policy.InvestorView("approved", "clear", 404, False, date(2027, 10, 1))


def test_transfer_allowed_within_retail_cap():
    checks = policy.transfer_checks(INV, 400, 0, 20_000, [404], 2500, 200, None, NOW)
    assert all(c.ok for c in checks)


def test_transfer_blocked_reasons():
    sanctioned = policy.InvestorView("pending", "sanctions_hit", 0, False, None)
    checks = {c.rule: c.ok for c in policy.transfer_checks(sanctioned, 10, 0, 20_000, [404], 2500, 200, NOW + timedelta(days=5), NOW)}
    assert checks == {"IDENTITY_VERIFIED": False, "SCREENING_CLEAR": False, "COUNTRY_ALLOWED": False, "HOLDING_CAP": True, "LOCKUP": False}


def test_credits_and_payout():
    hs = [policy.HoldingView("A", 400, 20_000, 12.5e6, "use"), policy.HoldingView("B", 300, 8_000, 4.2e6, "earn")]
    s = policy.credit_summary(hs, 1_000, 0.06, 0.85, 0.8, 0.7)
    assert s["use_credits_usd"] == 15_000
    assert s["use_credits_left_usd"] == 14_000
    assert s["earn_pool_usd"] == 9_450
    assert s["earn_payout_est_usd"] == round(9_450 / 0.85 * 0.8 * 0.7, 2)
    assert policy.stay_cost(38_000, 3, 0.85) == round(38_000 / 7 * 0.85 * 3, 2)


def test_condition_score():
    score, factors = policy.condition_score("PENDING", False, 2, 2014, 3, 2026)
    assert score == 100 - 15 - 20 - 6 - 4 + 3
    assert ("Insurance not verified", -20) in factors


# ---------------------------------------------------------------- live AIS (aisstream.io message shapes)

def _pos(mmsi, lat, lon, mtype="PositionReport", name="", sog=7.4, cog=91.0, hdg=90):
    return {"MessageType": mtype,
            "MetaData": {"MMSI": int(mmsi), "ShipName": name, "latitude": lat, "longitude": lon,
                         "time_utc": "2026-10-29 01:02:03.123456789 +0000 UTC"},
            "Message": {mtype: {"UserID": int(mmsi), "Latitude": lat, "Longitude": lon, "Sog": sog, "Cog": cog,
                                "TrueHeading": hdg, "Valid": True}}}


def test_live_parses_positions_and_static_types():
    from app.live import LiveAIS

    L = LiveAIS()
    L.handle(_pos("319001234", 25.09, 55.14, name="AZURE MERIDIAN   "))
    L.handle({"MessageType": "ShipStaticData", "MetaData": {"MMSI": 319001234, "latitude": 25.09, "longitude": 55.14},
              "Message": {"ShipStaticData": {"UserID": 319001234, "Name": "AZURE MERIDIAN", "Type": 37,
                                             "Dimension": {"A": 30, "B": 5, "C": 4, "D": 4}, "Valid": True}}})
    v = L.vessels["319001234"]
    assert (v.name, v.ship_type, v.length_m, v.kind) == ("AZURE MERIDIAN", 37, 35, "yacht")
    # class B position + StaticDataReport part B gives the type for small yachts
    L.handle(_pos("247000001", 43.73, 7.42, mtype="StandardClassBPositionReport"))
    L.handle({"MessageType": "StaticDataReport", "MetaData": {"MMSI": 247000001},
              "Message": {"StaticDataReport": {"UserID": 247000001, "PartNumber": True, "ReportA": {"Valid": False},
                                               "ReportB": {"Valid": True, "ShipType": 36, "Dimension": {"A": 12, "B": 3}}}}})
    assert L.vessels["247000001"].kind == "yacht"
    # a cargo ship stays out of the yachts layer but is in 'all'
    L.handle(_pos("636015988", 25.2, 55.2))
    assert {f["properties"]["mmsi"] for f in L.snapshot(kind="yachts")["features"]} == {"319001234", "247000001"}
    assert len(L.snapshot(kind="all")["features"]) == 3
    assert [f["properties"]["mmsi"] for f in L.snapshot((7, 43, 8, 44), "all")["features"]] == ["247000001"]


def test_live_rejects_unavailable_values_and_queues_fleet():
    from app.live import LiveAIS

    L = LiveAIS()
    assert L.handle(_pos("111111111", 91, 181)) is None  # AIS "not available"
    L.fleet = {"470118320": "YACHT-000007"}
    v = L.handle(_pos("470118320", 25.09, 55.14, sog=102.3, cog=360, hdg=511))
    assert (v.sog, v.cog, v.heading, v.kind) == (None, None, None, "fleet")
    L.handle(_pos("470118320", 25.10, 55.15))  # within a minute: not stored again
    assert len(L.pending_positions) == 1 and L.pending_positions[0][0] == "YACHT-000007"
    assert L.pending_positions[0][1].isoformat().startswith("2026-10-29T01:02:03.123456")


def test_live_subscriptions():
    from app.live import subscriptions

    subs = subscriptions("k", [(25.09, 55.14)], [str(i) for i in range(60)], 0.5)
    assert subs[0]["BoundingBoxes"] == [[[24.59, 54.64], [25.59, 55.64]]]
    assert [len(s.get("FiltersShipMMSI", [])) for s in subs] == [0, 50, 10]
    assert all(s["APIKey"] == "k" for s in subs)


def _dt_feature(mmsi, lon, lat, ts_ms, sog=6.2, cog=181.4, heading=180):
    return {"mmsi": mmsi, "type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"mmsi": mmsi, "sog": sog, "cog": cog, "navStat": 0, "rot": 0, "posAcc": True, "raim": False,
                           "heading": heading, "timestamp": 30, "timestampExternal": ts_ms}}


def test_digitraffic_locations_and_metadata():
    import time as _t

    from app.live import LiveAIS

    L = LiveAIS()
    now = int(_t.time() * 1000)
    L.handle_digitraffic_vessel({"mmsi": 230111222, "name": "AALTO ", "shipType": 37, "referencePointA": 9, "referencePointB": 5})
    L.handle_digitraffic_vessel({"mmsi": 230999000, "name": "CARGO ONE", "shipType": 70, "referencePointA": 120, "referencePointB": 30})
    n = L.apply_digitraffic({"type": "FeatureCollection", "features": [
        _dt_feature(230111222, 24.95, 60.16, now),
        _dt_feature(230999000, 22.2, 60.4, now, sog=102.3, cog=360, heading=511),
        _dt_feature(230555000, 181, 91, now),  # not available
    ]})
    assert n == 2
    y = L.vessels["230111222"]
    assert (y.name, y.ship_type, y.length_m, y.kind, y.sog) == ("AALTO", 37, 14, "yacht", 6.2)
    c = L.vessels["230999000"]
    assert (c.kind, c.sog, c.cog, c.heading) == ("vessel", None, None, None)
    # an older fix never moves a vessel backwards
    L.apply_digitraffic({"features": [_dt_feature(230111222, 25.5, 60.0, now - 60_000)]})
    assert L.vessels["230111222"].lon == 24.95
    snap = L.snapshot(kind="yachts")
    assert [f["properties"]["mmsi"] for f in snap["features"]] == ["230111222"]


def test_digitraffic_fleet_positions_are_queued_with_provider():
    import time as _t

    from app.live import LiveAIS

    L = LiveAIS()
    L.fleet = {"230111222": "YACHT-000004"}
    L.apply_digitraffic({"features": [_dt_feature(230111222, 24.95, 60.16, int(_t.time() * 1000))]})
    assert len(L.pending_positions) == 1
    yid, ts, lat, lon, sog, cog, provider = L.pending_positions[0]
    assert (yid, lat, lon, provider) == ("YACHT-000004", 60.16, 24.95, "digitraffic")


def test_run_digitraffic_polls_with_user_header():
    import asyncio

    import httpx

    from app import live as live_mod
    from app.config import get_settings

    get_settings().digitraffic_enabled = True  # the suite turns the real poller off
    seen = []

    def respond(req: httpx.Request):
        seen.append((req.url.path, req.headers.get("Digitraffic-User")))
        if req.url.path.endswith("/vessels"):
            return httpx.Response(200, json=[{"mmsi": 230222333, "name": "SAILOR", "shipType": 36, "referencePointA": 8, "referencePointB": 4}])
        import time as _t
        return httpx.Response(200, json={"type": "FeatureCollection", "features": [_dt_feature(230222333, 21.0, 59.9, int(_t.time() * 1000))]})

    async def go():
        stop = asyncio.Event()
        client = httpx.AsyncClient(base_url="https://meri.digitraffic.fi", transport=httpx.MockTransport(respond),
                                   headers={"Digitraffic-User": "GYT/test"})
        task = asyncio.create_task(live_mod.run_digitraffic(lambda: None, stop, client=client))
        for _ in range(50):
            await asyncio.sleep(0.02)
            if live_mod.live.dt_status == "live":
                break
        state = live_mod.live.state()
        stop.set()
        await task
        await client.aclose()
        return state

    state = asyncio.run(go())
    assert seen[0] == ("/api/ais/v1/vessels", "GYT/test") and seen[1][0] == "/api/ais/v1/locations"
    assert live_mod.live.vessels["230222333"].name == "SAILOR"
    assert state["digitraffic"] == "live" and state["status"] == "live"
