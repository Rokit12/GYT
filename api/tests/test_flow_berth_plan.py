"""Berth plan import: image stored, berths created and updated with plan positions, nothing deleted."""
import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
DXB = "MARINA-PLN-001"   # a marina of its own, so other berth tests are untouched
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64   # enough for the type check


@pytest.fixture(scope="module", autouse=True)
def plan_marina(client):
    r = client.post("/admin/marinas", headers=ADMIN, json={"id": DXB, "name": "Plan Test Marina", "region": "Gulf", "lat": 25.1, "lon": 55.1})
    assert r.status_code in (201, 409), r.text
    for code, loa in (("B130", 30), ("C214", 20)):
        r = client.post("/admin/berths", headers=ADMIN, json={"marina_id": DXB, "code": code, "max_loa_m": loa, "max_beam_m": 7, "rate_usd_day": 690})
        assert r.status_code in (201, 409), r.text


def test_plan_image_upload_and_checks(client, client_bearer):
    assert client.put(f"/admin/marinas/{DXB}/plan/image", content=PNG, headers=client_bearer).status_code == 403
    assert client.put(f"/admin/marinas/{DXB}/plan/image", content=b"GIF89a....", headers=ADMIN).status_code == 415
    assert client.put(f"/admin/marinas/{DXB}/plan/image", content=b"", headers=ADMIN).status_code == 422
    assert client.put("/admin/marinas/MARINA-XXX-999/plan/image", content=PNG, headers=ADMIN).status_code == 404
    r = client.put(f"/admin/marinas/{DXB}/plan/image", content=PNG, headers=ADMIN)
    assert r.status_code == 200, r.text
    img = client.get(f"/marinas/{DXB}/plan/image")
    assert img.status_code == 200 and img.headers["content-type"] == "image/png" and img.content == PNG


def test_save_plan_creates_updates_and_never_deletes(client):
    body = {"width_m": 160, "height_m": 110, "berths": [
        {"code": "b130", "max_loa_m": 30.2, "max_beam_m": 7.4, "max_draft_m": 3.5, "x": -20, "z": -30, "rot": 0},
        {"code": "P01", "max_loa_m": 22, "max_beam_m": 6, "rate_usd_day": 480, "x": 40, "z": -40, "rot": 3.1416},
        {"code": "P02", "max_loa_m": 18, "max_beam_m": 5.5, "x": 47, "z": -40, "rot": -1.5708},
    ]}
    r = client.put(f"/admin/marinas/{DXB}/plan", json=body, headers=ADMIN)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["created"] == ["P01", "P02"] and out["updated"] == ["B130"]
    assert "C214" in out["off_plan"] and "left as they were" in out["message"]
    plan = client.get(f"/marinas/{DXB}/plan").json()
    assert plan["plan"]["width_m"] == 160 and plan["plan"]["image"].startswith(f"/marinas/{DXB}/plan/image?v=")
    pos = {b["code"]: b for b in plan["berths"]}
    assert pos["B130"] == {"code": "B130", "x": -20, "z": -30, "rot": 0}
    assert abs(pos["P01"]["rot"]) == pytest.approx(3.1416, abs=1e-3) and "C214" not in pos
    # rates stay as the marina set them; new berths take the plan's rate
    board = {b["code"]: b for b in client.get("/admin/berths/board", headers=ADMIN, params={"marina_id": DXB}).json()["berths"]}
    assert board["B130"]["rate_usd_day"] == 690 and board["B130"]["max_loa_m"] == 30.2 and board["B130"]["max_draft_m"] == 3.5
    assert board["P01"]["rate_usd_day"] == 480 and board["C214"]["max_loa_m"] == 20


def test_save_plan_validation(client, client_bearer):
    ok = {"code": "Q1", "max_loa_m": 20, "max_beam_m": 6, "x": 0, "z": 0, "rot": 0}
    assert client.put(f"/admin/marinas/{DXB}/plan", json={"width_m": 100, "height_m": 80, "berths": [ok]}, headers=client_bearer).status_code == 403
    dup = client.put(f"/admin/marinas/{DXB}/plan", json={"width_m": 100, "height_m": 80, "berths": [ok, ok]}, headers=ADMIN)
    assert dup.status_code == 422 and "Q1" in dup.json()["detail"]
    bad = client.put(f"/admin/marinas/{DXB}/plan", json={"width_m": 100, "height_m": 80, "berths": [{**ok, "code": "no spaces!"}]}, headers=ADMIN)
    assert bad.status_code == 422
    assert client.put(f"/admin/marinas/{DXB}/plan", json={"width_m": 100, "height_m": 80, "berths": []}, headers=ADMIN).status_code == 422


def test_ai_read_is_off_without_a_key(client):
    r = client.post(f"/admin/marinas/{DXB}/plan/read", content=PNG, headers=ADMIN)
    assert r.status_code == 200 and r.json() == {"available": False}
