"""Primary and secondary admins: rights are enforced on every request, the primary is untouchable."""
import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")


def bearer(client, email, pw):
    r = client.post("/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def primary(client):
    return bearer(client, "admin@gyt.com", "change-me-before-deploy")


def test_first_admin_is_primary_with_every_right(client, primary):
    me = client.get("/auth/me", headers=primary).json()
    assert me["is_primary"] is True and "berths" in me["rights"] and "banking" in me["rights"]
    admins = client.get("/admin/admins", headers=primary).json()
    assert admins[0]["email"] == "admin@gyt.com" and admins[0]["is_primary"]


def test_primary_adds_secondary_with_chosen_rights(client, primary):
    r = client.post("/admin/admins", headers=primary, json={"email": "amina.ops@example.com", "name": "Amina Wanjiru", "rights": ["berths", "bookings"]})
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["rights"] == ["berths", "bookings"] and not a["is_primary"] and len(a["temporary_password"]) >= 10
    sec = bearer(client, "amina.ops@example.com", a["temporary_password"])
    me = client.get("/auth/me", headers=sec).json()
    assert me["role"] == "admin" and me["is_primary"] is False and me["rights"] == ["berths", "bookings"]
    # allowed
    assert client.get("/admin/berths/board", headers=sec, params={"marina_id": "MARINA-DXB-001"}).status_code == 200
    assert client.get("/bookings", headers=sec).status_code == 200
    assert client.get("/admin/overview", headers=sec).status_code == 200      # the dashboard is for every admin
    # not allowed
    r = client.get("/admin/bank-accounts", headers=sec)
    assert r.status_code == 403 and "Banking details" in r.json()["detail"]
    assert client.get("/admin/users", headers=sec).status_code == 403
    assert client.get("/admin/autopilot", headers=sec).status_code in (403, 404)
    assert client.get("/admin/admins", headers=sec).status_code == 403          # only the primary manages admins
    assert client.post("/admin/admins", headers=sec, json={"email": "x@example.com", "name": "X Y", "rights": ["banking"]}).status_code == 403
    # a right taken away applies at once, with the same session
    r = client.patch(f"/admin/admins/{a['id']}", headers=primary, json={"rights": ["bookings"]})
    assert r.status_code == 200 and r.json()["rights"] == ["bookings"]
    assert client.get("/admin/berths/board", headers=sec, params={"marina_id": "MARINA-DXB-001"}).status_code == 403
    # suspended, then removed as admin
    assert client.patch(f"/admin/admins/{a['id']}", headers=primary, json={"status": "suspended"}).status_code == 200
    assert client.get("/bookings", headers=sec).status_code == 403
    assert client.delete(f"/admin/admins/{a['id']}", headers=primary).status_code == 204
    assert all(x["email"] != "amina.ops@example.com" for x in client.get("/admin/admins", headers=primary).json())
    bad = client.post("/admin/admins", headers=primary, json={"email": "z@example.com", "name": "Zed Q", "rights": ["everything"]})
    assert bad.status_code == 422


def test_primary_cannot_be_deleted_suspended_or_demoted(client, primary):
    pid = client.get("/auth/me", headers=primary).json()["id"]
    for call in (lambda: client.delete(f"/admin/users/{pid}", headers=ADMIN),
                 lambda: client.patch(f"/admin/users/{pid}", headers=ADMIN, json={"status": "suspended"}),
                 lambda: client.patch(f"/admin/users/{pid}", headers=ADMIN, json={"role": "client"}),
                 lambda: client.patch(f"/admin/admins/{pid}", headers=ADMIN, json={"rights": []}),
                 lambda: client.delete(f"/admin/admins/{pid}", headers=ADMIN)):
        r = call()
        assert r.status_code == 409 and "primary admin" in r.json()["detail"], r.text
    assert client.get("/auth/me", headers=primary).json()["is_primary"] is True


def test_database_itself_protects_the_primary(client):
    from sqlalchemy import create_engine, text
    import os
    eng = create_engine(os.environ["TEST_DATABASE_URL"])
    with eng.connect() as c:
        pid = c.execute(text("SELECT id FROM users WHERE is_primary")).scalar_one()
    for sql in ("DELETE FROM users WHERE id=:i", "UPDATE users SET status='suspended' WHERE id=:i",
                "UPDATE users SET role='client' WHERE id=:i", "UPDATE users SET is_primary=FALSE WHERE id=:i"):
        with pytest.raises(Exception, match="primary admin"):
            with eng.begin() as c:
                c.execute(text(sql), {"i": pid})
    with pytest.raises(Exception, match="already a primary"):
        with eng.begin() as c:
            c.execute(text("UPDATE users SET is_primary=TRUE WHERE id=(SELECT min(id) FROM users WHERE NOT is_primary)"))
    eng.dispose()


def test_secondary_with_users_right_cannot_touch_admins(client, primary):
    r = client.post("/admin/admins", headers=primary, json={"email": "kofi.users@example.com", "name": "Kofi Mensah", "rights": ["users"]})
    sec = bearer(client, "kofi.users@example.com", r.json()["temporary_password"])
    users = client.get("/admin/users", headers=sec).json()
    pid = next(u["id"] for u in users if u["is_primary"])
    assert client.patch(f"/admin/users/{pid}", headers=sec, json={"status": "suspended"}).status_code == 409
    client_user = next(u for u in users if u["role"] == "client")
    assert client.patch(f"/admin/users/{client_user['id']}", headers=sec, json={"role": "admin"}).status_code == 403
    assert client.patch(f"/admin/users/{client_user['id']}", headers=sec, json={"name": "Renamed Person"}).status_code == 200
