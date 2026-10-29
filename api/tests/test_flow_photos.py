"""Owner photo uploads: type sniffing, ownership, cover handling, anchoring event, public file serving."""
import hashlib
import struct
import zlib

import pytest

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")


def png(seed: int) -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes([seed % 256, 80, 120]) * 4 for _ in range(4))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


@pytest.fixture(scope="module")
def owner(client, tmp_path_factory):
    from app.config import get_settings
    get_settings().media_dir = str(tmp_path_factory.mktemp("media"))
    r = client.post("/auth/signup", json={"name": "Omar Haddad", "email": "omar@example.com", "password": "Spinnaker88"})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    client.patch(f"/admin/users/{r.json()['user']['id']}", headers=ADMIN, json={"status": "active"})
    h = {"Authorization": f"Bearer {client.get('/auth/me', headers=h).json()['token']}"}  # token carries the new status
    y = client.post("/yachts", headers=h, json={
        "name": "Dhow Light", "flag": "UAE", "loa_m": 24, "beam_m": 6, "home_marina_id": "MARINA-DXB-001", "documents": []})
    assert y.status_code == 201, y.text
    return {"h": h, "yacht": y.json()["id"]}


def test_owner_uploads_and_manages_photos(client, owner):
    h, y = owner["h"], owner["yacht"]
    up = lambda body, ctype="image/png", cap="": client.post(f"/yachts/{y}/photos", params={"caption": cap}, headers={**h, "Content-Type": ctype}, content=body)
    assert up(b"GIF89a....").status_code == 415           # sniffed, not trusted from the header
    assert up(b"").status_code == 422
    a = up(png(1), cap="At anchor, Jumeirah")
    assert a.status_code == 201, a.text
    a = a.json()
    assert a["is_cover"] and a["caption"] == "At anchor, Jumeirah" and a["sha256"] == hashlib.sha256(png(1)).hexdigest()
    assert up(png(1)).status_code == 409                  # duplicate
    b = up(png(2)).json()
    assert not b["is_cover"]
    lst = client.get(f"/yachts/{y}/photos", headers=h).json()
    assert lst["can_manage"] and [p["id"] for p in lst["photos"]] == [a["id"], b["id"]]
    assert client.patch(f"/yachts/{y}/photos/{b['id']}", headers=h, json={"is_cover": True}).json()["is_cover"]
    assert client.get(f"/yachts/{y}/photos").json()["photos"][0]["id"] == b["id"]
    f = client.get(f"/photos/{a['id']}")
    assert f.status_code == 200 and f.headers["content-type"] == "image/png" and f.content == png(1)
    # the upload is a hashed, anchorable record
    ev = client.get(f"/verify/{hashlib.sha256(png(1)).hexdigest()}")
    dash = client.get("/me/dashboard", headers=h).json()
    mine = [x for x in dash["yachts"] if x["id"] == y][0]
    assert mine["owner"] and mine["photo_count"] == 2 and mine["cover_photo_id"] == b["id"] and dash["summary"]["owned"] == 1
    assert client.delete(f"/yachts/{y}/photos/{b['id']}", headers=h).status_code == 204
    assert client.get(f"/yachts/{y}/photos").json()["photos"][0]["is_cover"]  # next photo promoted
    assert client.get(f"/photos/{b['id']}").status_code == 404
    del ev


def test_strangers_cannot_manage_photos(client, owner, client_bearer):
    y = owner["yacht"]
    assert client.post(f"/yachts/{y}/photos", headers={**client_bearer, "Content-Type": "image/png"}, content=png(3)).status_code == 403
    assert client.post(f"/yachts/{y}/photos", headers={"Content-Type": "image/png"}, content=png(3)).status_code == 401
    assert client.get(f"/yachts/{y}/photos", headers=client_bearer).json()["can_manage"] is False
    assert client.post("/yachts/YACHT-NOPE/photos", headers={**client_bearer, "Content-Type": "image/png"}, content=png(3)).status_code == 404
