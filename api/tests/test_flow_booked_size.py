"""Booking with a size: the client enters length, beam and draft; it decides fit and is kept on the booking."""
import pytest

from tests.conftest import ADMIN, DB
from tests.test_flow_berths import DXB, owner_with_yacht

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
DATES = {"arrive": "2032-06-01", "depart": "2032-06-04"}


@pytest.fixture(scope="module")
def two(client):
    return {"me": owner_with_yacht(client, "Sara Odhiambo", "sara.size@example.com", "Sea Lark", 27, 6.5),
            "other": owner_with_yacht(client, "Omar Haddad", "omar.size@example.com", "Blue Heron", 18, 5.0)}


def avail(client, who, **kw):
    h, y = who
    return client.get("/berths/availability", headers=h, params={"marina_id": DXB, "yacht_id": y, **DATES, **kw})


def test_entered_size_decides_fit(client, two):
    r = avail(client, two["me"]).json()
    assert r["yacht"]["loa_m"] == 27 and r["yacht"]["custom"] is False
    berths = {b["code"]: b for b in r["berths"]}
    assert berths["B130"]["state"] == "available"                      # 30 m berth, 27 m yacht

    r = avail(client, two["me"], loa_m=29.5, beam_m=6.8, draft_m=2.6).json()
    assert r["yacht"]["loa_m"] == 29.5 and r["yacht"]["registered"]["loa_m"] == 27 and r["yacht"]["custom"] is True
    berths = {b["code"]: b for b in r["berths"]}
    assert berths["B130"]["state"] == "available" and berths["B130"]["fit"]["spare_loa_m"] == 0.5

    r = avail(client, two["me"], loa_m=31).json()                       # with a tender on the stern
    berths = {b["code"]: b for b in r["berths"]}
    assert berths["B130"]["state"] == "too_small" and "31 m long" in berths["B130"]["fit"]["reasons"][0]
    assert not any(b.get("best_fit") and b["max_loa_m"] < 31 for b in r["berths"])


def test_size_cannot_be_below_the_registered_size(client, two):
    r = avail(client, two["me"], loa_m=25)
    assert r.status_code == 422 and "registered 27 m" in r.json()["detail"]
    r = avail(client, two["me"], beam_m=6.0)
    assert r.status_code == 422 and "beam" in r.json()["detail"]
    h, y = two["me"]
    bid = {b["code"]: b for b in avail(client, two["me"]).json()["berths"]}["B130"]["id"]
    r = client.post(f"/berths/{bid}/hold", headers=h, json={"yacht_id": y, **DATES, "loa_m": 20})
    assert r.status_code == 422


def test_hold_and_booking_keep_the_entered_size(client, two):
    h, y = two["me"]
    bid = {b["code"]: b for b in avail(client, two["me"]).json()["berths"]}["B130"]["id"]
    big = client.post(f"/berths/{bid}/hold", headers=h, json={"yacht_id": y, **DATES, "loa_m": 31})
    assert big.status_code == 422 and "does not fit berth B130" in big.json()["detail"]
    r = client.post(f"/berths/{bid}/hold", headers=h, json={"yacht_id": y, **DATES, "loa_m": 29.5, "beam_m": 6.8, "draft_m": 2.6})
    assert r.status_code == 201, r.text
    assert r.json()["size"]["loa_m"] == 29.5 and r.json()["size"]["custom"] is True
    # other yachts see the hold by its booked size, never the name
    seen = {b["code"]: b for b in avail(client, two["other"]).json()["berths"]}["B130"]
    assert seen["state"] == "held" and seen["held_by"] == "another yacht (29.5 m)"
    c = client.post(f"/berths/holds/{r.json()['hold_id']}/confirm", headers=h, json={"ref": "BK-SZ2032"})
    assert c.status_code == 201, c.text
    board = client.get("/admin/berths/board", headers=ADMIN, params={"marina_id": DXB, "day": DATES["arrive"]}).json()
    row = next(b for b in board["berths"] if b["code"] == "B130")
    assert row["booking"]["ref"] == "BK-SZ2032" and row["booking"]["loa_m"] == 29.5
    assert any("Snug fit" in i for i in row["issues"])                 # 0.5 m spare is flagged for the marina
