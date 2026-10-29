"""Client accounts: wizard sign-up, profile and settings, follows, dashboard, and unit economics."""
import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")


@pytest.fixture(scope="module")
def amina(client):
    r = client.post("/auth/signup", json={
        "name": "Amina Yusuf", "email": "amina@example.com", "password": "Harbour2026",
        "phone": "+254 700 123456", "country": "ke", "interests": ["charter", "invest", "spam"],
        "follow": ["YACHT-000003", "YACHT-000007", "YACHT-NOPE"]})
    assert r.status_code == 201, r.text
    return {"h": {"Authorization": f"Bearer {r.json()['token']}"}, "id": r.json()["user"]["id"]}


def test_signup_wizard_fields_and_follows(client, amina):
    p = client.get("/me/profile", headers=amina["h"]).json()
    assert (p["phone"], p["country"], p["interests"], p["status"]) == ("+254 700 123456", "KE", ["charter", "invest"], "pending")
    assert p["notify"]["arrivals"] is True and p["notify"]["weekly"] is False
    assert client.get("/me/follows", headers=amina["h"]).json() == ["YACHT-000003", "YACHT-000007"]


def test_profile_updates_and_validation(client, amina):
    h = amina["h"]
    r = client.patch("/me/profile", headers=h, json={"name": "Amina Y. Yusuf", "notify": {"weekly": True}, "interests": ["own"]})
    assert r.status_code == 200 and r.json()["name"] == "Amina Y. Yusuf"
    assert r.json()["notify"]["weekly"] is True and r.json()["notify"]["arrivals"] is True  # merged, not replaced
    assert client.patch("/me/profile", headers=h, json={"wallet_address": "0x123"}).status_code == 422
    assert client.patch("/me/profile", headers=h, json={"phone": "call me"}).status_code == 422
    assert client.patch("/me/profile", headers=h, json={"notify": {"sms_spam": True}}).status_code == 422
    w = "0x" + "aB" * 20
    assert client.patch("/me/profile", headers=h, json={"wallet_address": w}).json()["wallet_address"] == w
    assert client.get("/me/profile").status_code == 401


def test_password_change(client, amina):
    h = amina["h"]
    assert client.post("/me/password", headers=h, json={"current": "wrong", "new": "Anchor2027x"}).status_code == 403
    assert client.post("/me/password", headers=h, json={"current": "Harbour2026", "new": "short"}).status_code == 422
    assert client.post("/me/password", headers=h, json={"current": "Harbour2026", "new": "Anchor2027x"}).status_code == 200
    assert client.post("/auth/login", json={"email": "amina@example.com", "password": "Harbour2026"}).status_code == 401
    assert client.post("/auth/login", json={"email": "amina@example.com", "password": "Anchor2027x"}).status_code == 200


def test_follow_unfollow_and_dashboard(client, amina):
    h = amina["h"]
    assert client.put("/me/follows/YACHT-000002", headers=h).status_code == 204
    assert client.put("/me/follows/YACHT-NOPE", headers=h).status_code == 404
    assert client.delete("/me/follows/YACHT-000003", headers=h).status_code == 204
    d = client.get("/me/dashboard", headers=h).json()
    assert {y["id"] for y in d["yachts"]} == {"YACHT-000002", "YACHT-000007"}
    assert d["summary"]["following"] == 2 and d["summary"]["units"] == 0
    assert d["activity"] and all(a["yacht_id"] in ("YACHT-000002", "YACHT-000007") for a in d["activity"])
    assert all(len(a["leaf"]) == 64 for a in d["activity"])
    # once an admin links her to an investor profile, holdings join the dashboard
    client.patch(f"/admin/users/{amina['id']}", headers=ADMIN, json={"investor_id": "INV-1042"})
    d = client.get("/me/dashboard", headers=h).json()
    held = {y["id"]: y for y in d["yachts"] if y["units"]}
    assert "YACHT-000003" in held and not held["YACHT-000003"]["following"]
    y3 = held["YACHT-000003"]
    assert y3["holding_value_usd"] == round(y3["units"] * y3["unit_price_usd"], 2)
    assert d["summary"]["portfolio_usd"] == round(sum(y["holding_value_usd"] for y in d["yachts"]), 2)


def test_units_price_holders_and_history(client, amina):
    u = client.get("/yachts/YACHT-000002/units").json()
    assert u["unit_price_usd"] == round(u["valuation_usd"] / u["units_total"], 2) == 600.0
    assert u["unit_share_pct"] == round(100 / u["units_total"], 6)
    assert u["units_held"] == sum(h["units"] for h in u["holders"]) and u["units_available"] == u["units_total"] - u["units_held"]
    assert u["holders"] == sorted(u["holders"], key=lambda h: -h["units"])
    assert all("INV-" not in h["label"] for h in u["holders"])  # pseudonymous
    assert len(u["history"]) == 8 and u["history"][-1]["unit_price_usd"] == u["unit_price_usd"]
    mine = client.get("/yachts/YACHT-000003/units", headers=amina["h"]).json()
    assert [h["you"] for h in mine["holders"]].count(True) == 1
    assert client.get("/yachts/YACHT-NOPE/units").status_code == 404
