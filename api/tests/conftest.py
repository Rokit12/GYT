"""Shared fixtures: one seeded database per test session (flow tests run first, then admin tests)."""
import json
import os

import pytest

DB = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")

if DB:
    os.environ["DATABASE_URL"] = DB
    os.environ["ANCHOR_INTERVAL_SECONDS"] = "0"
    os.environ["ADMIN_TOKEN"] = "test-admin"
    os.environ["JWT_SECRET"] = "test-secret-" + "x" * 40
    os.environ["ADMIN_EMAIL"] = "admin@gyt.com"
    os.environ["ADMIN_PASSWORD"] = "change-me-before-deploy"
    os.environ["BANK_DATA_KEY"] = "11" * 32


@pytest.fixture(scope="session")
def client():
    import sys

    from fastapi.testclient import TestClient

    from app import seed

    sys.argv = ["seed", "--reset"]
    seed.main()
    from app.main import app

    with TestClient(app) as c:
        yield c


ADMIN = {"X-Admin-Token": "test-admin"}


@pytest.fixture(scope="session")
def admin_bearer(client):
    r = client.post("/auth/login", json={"email": "admin@gyt.com", "password": "change-me-before-deploy"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "admin"
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="session")
def client_bearer(client):
    r = client.post("/auth/signup", json={"name": "Wanjiru K.", "email": "wanjiru@example.com", "password": "Sailing2026"})
    assert r.status_code == 201, r.text
    assert r.json()["user"]["status"] == "pending"
    pending = {"Authorization": f"Bearer {r.json()['token']}"}
    # pending users can browse but not transact
    assert client.post("/bookings/berth", headers=pending, json=dict(ref="BK-1000", yacht_id="YACHT-000001", berth_id=1,
                       arrive="2030-01-01", depart="2030-01-02")).status_code == 403
    uid = r.json()["user"]["id"]
    assert client.patch(f"/admin/users/{uid}", headers=ADMIN, json={"status": "active"}).status_code == 200
    me = client.get("/auth/me", headers=pending).json()
    assert me["status"] == "active"
    return {"Authorization": f"Bearer {me['token']}"}


def test_auth_rules(client, admin_bearer, client_bearer):
    assert client.post("/auth/signup", json={"name": "Dup", "email": "WANJIRU@example.com", "password": "Sailing2026"}).status_code == 409
    assert client.post("/auth/signup", json={"name": "Weak", "email": "weak@example.com", "password": "password"}).status_code == 422
    assert client.post("/auth/login", json={"email": "admin@gyt.com", "password": "wrong"}).status_code == 401
    assert client.get("/auth/me", headers=client_bearer).json()["role"] == "client"
    assert client.get("/bookings", headers=client_bearer).status_code == 403
    assert client.get("/bookings").status_code == 401
    assert client.get("/bookings", headers=admin_bearer).status_code == 200
    assert client.get("/bookings", headers={"Authorization": "Bearer forged.token.value"}).status_code == 401


def test_login_rate_limit(client):
    for _ in range(5):
        assert client.post("/auth/login", json={"email": "nobody@example.com", "password": "x"}).status_code == 401
    assert client.post("/auth/login", json={"email": "nobody@example.com", "password": "x"}).status_code == 429


def test_password_never_stored_plain(client):
    from sqlalchemy import text
    from app.db import engine
    with engine.connect() as c:
        h = c.execute(text("SELECT password_hash FROM users WHERE email='admin@gyt.com'")).scalar()
    assert h.startswith("scrypt$") and "change-me-before-deploy" not in h


