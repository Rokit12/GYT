"""Admin console: approvals, banking, minting, monitoring, CRUD, hashes, audit.

Runs after test_api_flow on the same session database (see conftest.py).
"""
import json
import os
from pathlib import Path

import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")

TWIN_ARTIFACT = Path(__file__).resolve().parents[2] / "contracts/out/YachtTwin.sol/YachtTwin.json"


@pytest.fixture(scope="module")
def fresh_twin_contract():
    """Deploy a new YachtTwin per run so on-chain mints never collide with earlier runs."""
    rpc, key = os.environ.get("CHAIN_RPC"), os.environ.get("ANCHOR_PRIVATE_KEY")
    if not (rpc and key and TWIN_ARTIFACT.exists()):
        yield None
        return
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(rpc))
    acct = w3.eth.account.from_key(key)
    art = json.loads(TWIN_ARTIFACT.read_text())
    c = w3.eth.contract(abi=art["abi"], bytecode=art["bytecode"]["object"])
    tx = c.constructor(acct.address, "http://localhost/twins/").build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address)})
    h = w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction)
    addr = w3.eth.wait_for_transaction_receipt(h).contractAddress
    from app.config import get_settings
    old = get_settings().yacht_twin_address
    get_settings().yacht_twin_address = addr
    yield addr
    get_settings().yacht_twin_address = old


def test_clients_cannot_reach_admin(client, client_bearer):
    for path in ["/admin/overview", "/admin/users", "/admin/bank-accounts", "/admin/hashes", "/admin/monitoring"]:
        assert client.get(path, headers=client_bearer).status_code == 403
        assert client.get(path).status_code == 401


def test_overview_and_monitoring(client, admin_bearer):
    o = client.get("/admin/overview", headers=admin_bearer).json()
    assert o["yachts_active"] >= 8 and o["users_total"] >= 2
    mon = {m["id"]: m for m in client.get("/admin/monitoring", headers=admin_bearer).json()}
    assert "gps" in (mon["YACHT-000007"]["last_fix"] or {})
    assert any(a["text"] == "Insurance not verified" for a in mon["YACHT-000006"]["alerts"])


def test_user_management(client, admin_bearer):
    r = client.post("/auth/signup", json={"name": "Temp User", "email": "temp@example.com", "password": "Temp12345"})
    uid = r.json()["user"]["id"]
    pend = client.get("/admin/users", headers=admin_bearer, params={"status": "pending"}).json()
    assert any(u["id"] == uid for u in pend)
    assert client.patch(f"/admin/users/{uid}", headers=admin_bearer, json={"status": "suspended"}).status_code == 200
    assert client.post("/auth/login", json={"email": "temp@example.com", "password": "Temp12345"}).status_code == 403
    assert client.patch(f"/admin/users/{uid}", headers=admin_bearer, json={"investor_id": "INV-1042"}).json()["investor_id"] == "INV-1042"
    assert client.patch(f"/admin/users/{uid}", headers=admin_bearer, json={"wallet_address": "nope"}).status_code == 422
    assert client.delete(f"/admin/users/{uid}", headers=admin_bearer).status_code == 204
    me = client.get("/auth/me", headers=admin_bearer).json()
    assert client.delete(f"/admin/users/{me['id']}", headers=admin_bearer).status_code == 409
    assert client.patch(f"/admin/users/{me['id']}", headers=admin_bearer, json={"role": "client"}).status_code == 409


def test_banking_is_encrypted_and_masked(client, admin_bearer):
    body = dict(owner_type="marina", owner_id="MARINA-DXB-001", account_name="Dubai Harbour Marina LLC",
                bank_name="Emirates NBD", country="UAE", currency="AED", swift_bic="EBILAEAD",
                account_number="AE07 0331 2345 6789 0123 456")
    r = client.post("/admin/bank-accounts", headers=admin_bearer, json=body)
    assert r.status_code == 201, r.text
    acct = r.json()
    assert acct["last4"] == "3456" and "account_number" not in acct and "number_enc" not in acct
    from sqlalchemy import text
    from app.admin import decrypt_number
    from app.db import engine
    with engine.connect() as c:
        enc = c.execute(text("SELECT number_enc FROM bank_accounts WHERE id=:i"), {"i": acct["id"]}).scalar()
    assert "0331" not in enc and decrypt_number(enc) == "AE070331234567890123456"
    upd = client.patch(f"/admin/bank-accounts/{acct['id']}", headers=admin_bearer, json={"status": "verified"}).json()
    assert upd["status"] == "verified"
    upd = client.patch(f"/admin/bank-accounts/{acct['id']}", headers=admin_bearer, json={"account_number": "AE070331000000000009999"}).json()
    assert upd["last4"] == "9999" and upd["status"] == "pending_verification"  # new number needs re-verification
    assert client.post("/admin/bank-accounts", headers=admin_bearer, json={**body, "swift_bic": "bad"}).status_code == 422
    assert client.delete(f"/admin/bank-accounts/{acct['id']}", headers=admin_bearer).status_code == 204
    audit = client.get("/admin/audit", headers=admin_bearer).json()
    assert any(a["entity"] == "bank_account" and a["action"] == "delete" for a in audit)
    assert not any("0331" in json.dumps(a["detail"]) for a in audit)  # numbers never land in the audit log


def test_minting_flow(client, admin_bearer, fresh_twin_contract):
    y = "YACHT-000009"  # onboarded in test_api_flow, still pending
    assert client.post(f"/admin/yachts/{y}/mint-twin", headers=admin_bearer).status_code == 409  # must verify first
    assert client.post(f"/admin/yachts/{y}/verify", headers=admin_bearer).json()["twin_status"] == "verified"
    m = client.post(f"/admin/yachts/{y}/mint-twin", headers=admin_bearer).json()
    assert m["twin_status"] == "minted"
    if fresh_twin_contract:
        assert m["on_chain"] and m["tx_hash"] and m["token_id"] == 1
    blocked = client.post(f"/admin/yachts/{y}/mint-units", headers=admin_bearer, json={"investor_id": "INV-1046", "units": 10})
    assert blocked.status_code == 422 and "SCREENING_CLEAR" in blocked.json()["detail"]
    comp = client.put(f"/admin/yachts/{y}/compliance", headers=admin_bearer,
                      json={"allowed_countries": [404, 784, 840], "professional_max_bps": 2500, "retail_max_bps": 200})
    assert comp.status_code == 200 and comp.json()["allowed_countries"] == [404, 784, 840]
    assert client.put(f"/admin/yachts/{y}/compliance", headers=admin_bearer,
                      json={"professional_max_bps": 100, "retail_max_bps": 200}).status_code == 422
    ok = client.post(f"/admin/yachts/{y}/mint-units", headers=admin_bearer, json={"investor_id": "INV-1045", "units": 2000})
    assert ok.status_code == 200, ok.text
    too_many = client.post(f"/admin/yachts/{y}/mint-units", headers=admin_bearer, json={"investor_id": "INV-1045", "units": 9000})
    assert too_many.status_code == 409
    assert client.patch(f"/admin/yachts/{y}", headers=admin_bearer, json={"units_total": 1000}).status_code == 409
    h = client.get("/admin/hashes", headers=admin_bearer).json()
    kinds = {t["kind"] for t in h["chain_txs"]}
    assert {"twin_mint", "units_mint", "anchor"} <= kinds
    twin = next(t for t in h["twins"] if t["id"] == y)
    assert twin["twin_status"] == "minted"


def test_yacht_edit_and_retire(client, admin_bearer):
    r = client.patch("/admin/yachts/YACHT-000006", headers=admin_bearer, json={"insurance_verified": True, "charter_week_usd": 72000})
    assert r.status_code == 200 and r.json()["insurance_verified"] is True
    assert client.delete("/admin/yachts/YACHT-000003", headers=admin_bearer).status_code == 409  # CS-7302 in escrow
    assert client.delete("/admin/yachts/YACHT-000008", headers=admin_bearer).status_code == 204
    assert all(y["id"] != "YACHT-000008" for y in client.get("/admin/monitoring", headers=admin_bearer).json())


def test_marina_berth_booking_investor_crud(client, admin_bearer):
    m = dict(id="MARINA-LAM-001", name="Lamu Marina", region="East Africa", lat=-2.27, lon=40.90)
    assert client.post("/admin/marinas", headers=admin_bearer, json=m).status_code == 201
    assert client.post("/admin/marinas", headers=admin_bearer, json=m).status_code == 409
    assert client.patch("/admin/marinas/MARINA-LAM-001", headers=admin_bearer, json={"arrival_radius_m": 400}).status_code == 200
    b = client.post("/admin/berths", headers=admin_bearer, json=dict(marina_id="MARINA-LAM-001", code="L-1", max_loa_m=30, max_beam_m=7, rate_usd_day=250))
    bid = b.json()["id"]
    assert client.patch(f"/admin/berths/{bid}", headers=admin_bearer, json={"rate_usd_day": 275}).json()["rate_usd_day"] == 275
    assert client.delete(f"/admin/berths/{bid}", headers=admin_bearer).status_code == 204
    assert client.delete("/admin/marinas/MARINA-LAM-001", headers=admin_bearer).status_code == 204
    assert client.delete("/admin/marinas/MARINA-DXB-001", headers=admin_bearer).status_code == 409
    assert client.post("/admin/bookings/CS-7302/cancel", headers=admin_bearer).json()["status"] == "refunded"
    assert client.post("/admin/bookings/BK-4098/cancel", headers=admin_bearer).status_code == 409  # already released
    inv = dict(id="INV-2001", name="Coastline Partners", kind="entity", country_code=404, professional=True)
    assert client.post("/admin/investors", headers=admin_bearer, json=inv).status_code == 201
    assert client.patch("/admin/investors/INV-2001", headers=admin_bearer, json={"wallet": "0x" + "ab" * 20}).status_code == 200
    assert client.delete("/admin/investors/INV-2001", headers=admin_bearer).status_code == 204
    assert client.delete("/admin/investors/INV-1043", headers=admin_bearer).status_code == 409  # holds units


def test_client_track_and_public_verify(client, client_bearer):
    assert client.get("/track/YACHT-000007").status_code == 401
    t = client.get("/track/YACHT-000007", headers=client_bearer).json()
    assert t["positions"] and t["events"]
    anchored = next(e for e in t["events"] if e["anchor_id"])
    v = client.get(f"/verify/{anchored['leaf']}").json()  # public, no sign-in
    assert v["verified_offchain"] and v["root"] == anchored["root"]
    assert client.get("/verify/" + "0" * 64).status_code == 404
    assert client.get("/verify/xyz").status_code == 422
