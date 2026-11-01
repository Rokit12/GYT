"""Owner-only sign-up (yacht proof or invite), screening, AI document reading (mocked) and the autopilot."""
import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


@pytest.fixture()
def restricted():
    from app.config import get_settings
    s = get_settings()
    old = s.registration_mode
    s.registration_mode = "owners_and_invites"
    yield s
    s.registration_mode = old


def vessel(**kw):
    return {"name": "Malindi Dawn", "flag": "Kenya", "loa_m": 24, "mmsi": "634112233", "imo": "9074729",
            "registry_number": "KE-REG-2219", **kw}


def test_unchecked_formats(restricted):
    from app.registration import imo_problem, mmsi_problem
    assert mmsi_problem("634112233", "Kenya") is None
    assert "does not match the flag" in mmsi_problem("470112233", "Kenya")
    assert "9 digits" in mmsi_problem("63411", "Kenya")
    assert "not a ship station" in mmsi_problem("111222333", "Kenya")
    assert mmsi_problem("999112233".replace("999", "540"), "Atlantis") is None  # unknown flag: format only
    assert imo_problem("9074729") is None and imo_problem("IMO 9074729") is None
    assert "check digit" in imo_problem("9074728")


def test_anyone_without_a_yacht_is_turned_away(client, restricted):
    r = client.post("/auth/signup", json={"name": "Just Curious", "email": "curious@example.com", "password": "Browsing2031"})
    assert r.status_code == 422 and "yacht owners and people they invite" in r.json()["detail"]
    r = client.post("/auth/signup", json={"name": "No Boat", "email": "noboat@example.com", "password": "Browsing2031",
                                          "join_as": "owner"})
    assert r.status_code == 422
    r = client.post("/auth/signup", json={"name": "Bad Id", "email": "badid@example.com", "password": "Browsing2031",
                                          "join_as": "owner", "vessel": vessel(mmsi="470112233", imo=None)})
    assert r.status_code == 422 and "does not match the flag Kenya" in r.json()["detail"]
    r = client.post("/auth/signup", json={"name": "No Ids", "email": "noids@example.com", "password": "Browsing2031",
                                          "join_as": "owner", "vessel": vessel(mmsi=None, imo=None)})
    assert r.status_code == 422 and "MMSI or IMO" in r.json()["detail"]
    r = client.post("/auth/signup", json={"name": "Fake Code", "email": "fake@example.com", "password": "Browsing2031",
                                          "join_as": "invite", "invite_code": "GYT-AAAA-BBBB"})
    assert r.status_code == 422 and "not valid" in r.json()["detail"]


def test_owner_signup_screening_and_ai(client, restricted, admin_bearer, monkeypatch):
    r = client.post("/auth/signup", json={"name": "Zawadi Mwangi", "email": "zawadi@example.com", "password": "Kilifi2031",
                                          "join_as": "owner", "vessel": vessel()})
    assert r.status_code == 201, r.text
    assert r.json()["user"]["status"] == "pending"
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    uid = r.json()["user"]["id"]
    st = client.get("/me/registration", headers=h).json()
    assert st["vessel_name"] == "Malindi Dawn" and st["joined_via"] == "owner" and st["status"] == "pending"
    assert client.post("/me/registry-document", headers={**h, "Content-Type": "application/pdf"}, content=b"hello").status_code == 415

    # AI on (mocked): it reads the certificate and reports a length mismatch
    from app import ai
    monkeypatch.setattr(restricted, "anthropic_api_key", "test-key")
    calls = []

    def fake_call(system, content, tool, max_tokens=800):
        calls.append(tool["name"])
        if tool["name"] == "report_certificate":
            assert content[0]["type"] == "document" and content[0]["source"]["media_type"] == "application/pdf"
            return {"is_registry_certificate": True, "vessel_name": "MALINDI DAWN", "flag": "Kenya", "length_m": 31,
                    "mismatches": ["Certificate says 31 m; owner typed 24 m"], "confidence": "high"}
        return {"headline": "One owner needs review", "actions": ["Check Malindi Dawn's length"]}
    monkeypatch.setattr(ai, "_call", fake_call)

    up = client.post("/me/registry-document", headers={**h, "Content-Type": "application/pdf"}, content=PDF)
    assert up.status_code == 200, up.text
    scr = up.json()["screening"]
    assert scr["recommendation"] == "needs_review"
    keys = {c["key"]: c["ok"] for c in scr["checks"]}
    assert keys == {"mmsi": True, "imo": True, "mmsi_unique": True, "imo_unique": True, "document": True, "ai_document": False}
    assert "ai" not in scr                                         # owners see checks, not the AI's notes
    adm = [x for x in client.get("/admin/registrations", headers=admin_bearer).json() if x["id"] == uid][0]
    assert adm["screening"]["ai"]["read"]["length_m"] == 31
    doc = client.get(f"/admin/registrations/{uid}/document", headers=admin_bearer)
    assert doc.status_code == 200 and doc.content == PDF

    # the AI's disagreement blocks the autopilot's recommendation; it never approves anyone itself
    run = client.post("/admin/autopilot/run", headers=admin_bearer).json()
    assert run["registrations_screened"] >= 1 and run["approved"] == 0 and run["brief"]["headline"]
    ap = client.get("/admin/autopilot", headers=admin_bearer).json()
    assert ap["ai_enabled"] and any(l["job"] == "registrations" and l["outcome"] == "needs_review" and l["used_ai"] for l in ap["log"])
    assert client.post("/admin/autopilot/approve-recommended", headers=admin_bearer).json()["approved"] == []

    # AI agrees -> every check passes -> recommended -> one-click approval
    monkeypatch.setattr(ai, "_call", lambda *a, **k: {"is_registry_certificate": True, "mismatches": [], "confidence": "high"})
    assert client.post(f"/admin/registrations/{uid}/screen", headers=admin_bearer).json()["recommendation"] == "recommend_approve"
    assert client.post("/admin/autopilot/approve-recommended", headers=admin_bearer).json()["approved"] == [uid]
    assert client.get("/auth/me", headers=h).json()["status"] == "active"

    # AI down: rules still work, nothing breaks
    def boom(*a, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(ai, "_call", boom)
    assert ai.read_registry_document(PDF, "application/pdf", {})["available"] is False


def test_duplicate_mmsi_is_flagged(client, restricted):
    r = client.post("/auth/signup", json={"name": "Copy Cat", "email": "copycat@example.com", "password": "Kilifi2031",
                                          "join_as": "owner", "vessel": vessel(name="Kilindini Star", mmsi="634009871", imo=None)})
    assert r.status_code == 201
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    scr = client.post("/me/registry-document", headers={**h, "Content-Type": "application/pdf"}, content=PDF).json()["screening"]
    bad = [c for c in scr["checks"] if not c["ok"]]
    assert scr["recommendation"] == "needs_review" and bad[0]["key"] == "mmsi_unique" and "YACHT-000003" in bad[0]["msg"]


def test_invites(client, restricted, admin_bearer):
    # an approved owner invites their captain to their yacht
    from app.config import get_settings
    get_settings().registration_mode = "open"
    r = client.post("/auth/signup", json={"name": "Owner Inv", "email": "owner.inv@example.com", "password": "Kilifi2031"})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    client.patch(f"/admin/users/{r.json()['user']['id']}", headers=ADMIN, json={"status": "active"})
    h = {"Authorization": f"Bearer {client.get('/auth/me', headers=h).json()['token']}"}
    y = client.post("/yachts", headers=h, json={"name": "Shela Wind", "flag": "Kenya", "loa_m": 22, "beam_m": 5.8,
                                                 "home_marina_id": "MARINA-MBA-001", "documents": []}).json()["id"]
    get_settings().registration_mode = "owners_and_invites"
    assert client.post("/invites", headers=h, json={"role": "investor"}).status_code == 403
    assert client.post("/invites", headers=h, json={"role": "captain", "yacht_id": "YACHT-000001"}).status_code == 403
    inv = client.post("/invites", headers=h, json={"role": "captain", "yacht_id": y, "email": "skipper@example.com"})
    assert inv.status_code == 201 and inv.json()["code"].startswith("GYT-")
    code = inv.json()["code"]
    wrong = client.post("/auth/signup", json={"name": "Not Skipper", "email": "other@example.com", "password": "Kilifi2031",
                                              "join_as": "invite", "invite_code": code})
    assert wrong.status_code == 422 and "different email" in wrong.json()["detail"]
    ok = client.post("/auth/signup", json={"name": "Skipper Juma", "email": "skipper@example.com", "password": "Kilifi2031",
                                           "join_as": "invite", "invite_code": code.lower()})
    assert ok.status_code == 201 and ok.json()["user"]["status"] == "active"
    sk = {"Authorization": f"Bearer {ok.json()['token']}"}
    assert [t["id"] for t in client.get("/me/trackable", headers=sk).json()["yachts"]] == [y]   # crew of that yacht
    reuse = client.post("/auth/signup", json={"name": "Again", "email": "skipper2@example.com", "password": "Kilifi2031",
                                              "join_as": "invite", "invite_code": code})
    assert reuse.status_code == 422 and "already been used" in reuse.json()["detail"]
    mine = client.get("/invites", headers=h).json()
    assert mine[0]["used_by_name"] == "Skipper Juma"
    # admins can invite investors without a yacht
    a = client.post("/invites", headers=admin_bearer, json={"role": "investor", "note": "Seed round"})
    assert a.status_code == 201
    assert client.delete(f"/invites/{a.json()['code']}", headers=admin_bearer).json()["revoked"]
    late = client.post("/auth/signup", json={"name": "Late Inv", "email": "late@example.com", "password": "Kilifi2031",
                                             "join_as": "invite", "invite_code": a.json()["code"]})
    assert late.status_code == 422 and "expired" in late.json()["detail"]


def test_autopilot_holds_and_fit(client, admin_bearer):
    from sqlalchemy import text
    from app.db import engine
    with engine.begin() as c:
        # a hold that ran out, and a booked yacht that grew (refit) beyond its berth
        b = c.execute(text("SELECT id FROM berths WHERE code='C214'")).scalar()
        uid = c.execute(text("SELECT id FROM users WHERE email='admin@gyt.com'")).scalar()
        c.execute(text("INSERT INTO berth_holds (berth_id,yacht_id,user_id,arrive,depart,expires_at) "
                       "VALUES (:b,'YACHT-000008',:u,'2032-01-01','2032-01-03', now() - interval '1 min')"), {"b": b, "u": uid})
        b2 = c.execute(text("SELECT id FROM berths WHERE code='A050'")).scalar()
        c.execute(text("INSERT INTO bookings (ref,kind,yacht_id,marina_id,berth_id,arrive,depart,amount_usd) "
                       "VALUES ('BK-77001','berth','YACHT-000006','MARINA-DXB-001',:b,CURRENT_DATE + 30,CURRENT_DATE + 33,9600)"), {"b": b2})
        c.execute(text("UPDATE yachts SET draft_m = 9 WHERE id = 'YACHT-000006'"))
    res = client.post("/admin/autopilot/run", headers=admin_bearer).json()
    assert res["holds_released"] >= 1 and res["flags"] >= 1
    log = client.get("/admin/autopilot", headers=admin_bearer).json()["log"]
    fitf = [l for l in log if l["job"] == "berth_fit" and l["subject"] == "BK-77001"]
    assert fitf and "draws 9 m" in fitf[0]["summary"]
    # the same finding is not repeated on the next run, and shows on the marina board
    again = client.post("/admin/autopilot/run", headers=admin_bearer).json()
    assert again["flags"] == 0
    board = client.get("/admin/berths/board", headers=admin_bearer, params={"marina_id": "MARINA-DXB-001"}).json()
    assert any("draws 9 m" in f["summary"] for f in board["flags"])
    assert client.post(f"/admin/autopilot/{fitf[0]['id']}/resolve", headers=admin_bearer).json()["resolved"]
