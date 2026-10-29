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
