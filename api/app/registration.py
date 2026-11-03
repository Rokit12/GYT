"""Who can create a GYT account.

GYT is for people with a real connection to a yacht. With REGISTRATION_MODE=owners_and_invites
(the default) there are two ways in:

  1. Yacht owner: give the yacht's name, flag, length and its MMSI and/or IMO number, plus the
     registry number, then upload the certificate of registry. The account stays pending until the
     autopilot has screened the claim and an admin (or, if AUTOPILOT_AUTO_APPROVE is on, the
     autopilot itself when every check passes) approves it.
  2. Invited: an owner invites their captain or crew to one yacht, or an admin invites an investor,
     marina staff or a partner. The invite code is single-use, can be tied to one email address,
     and expires. Invited accounts are active straight away.

Anyone can still browse the public site, the map and passports without an account.

Screening checks (instant, no AI needed):
  * MMSI: 9 digits, starting with a valid Maritime Identification Digits (MID) country code, and
    that MID matches the flag the owner gave (for the flags we know)
  * IMO: 7 digits with a valid IMO check digit
  * no other account or yacht already uses that MMSI or IMO
  * a registry document was uploaded, and it really is a PDF or image
When ANTHROPIC_API_KEY is set, Claude also reads the uploaded certificate and reports whether the
name, flag and length on it match what the owner typed. Claude's reading is advice shown to the
admin; it can add a reason to review, but it can never approve anyone on its own.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import User, require_right, require_user
from .config import get_settings
from .db import get_db
from .devices import role_for
from .vessel import VesselClaim

router = APIRouter()
MAX_DOC = 10 * 1024 * 1024

# Maritime Identification Digits for flags common in yachting (ITU list, abridged).
MID: dict[str, set[str]] = {
    "antigua and barbuda": {"304", "305"}, "australia": {"503"}, "bahamas": {"308", "309", "311"},
    "bahrain": {"408"}, "belize": {"312"}, "bermuda": {"310"}, "british virgin islands": {"378"},
    "canada": {"316"}, "cayman islands": {"319"}, "china": {"412", "413", "414"}, "comoros": {"616"},
    "croatia": {"238"}, "cyprus": {"209", "210", "212"}, "denmark": {"219", "220"}, "egypt": {"622"},
    "france": {"226", "227", "228"}, "germany": {"211", "218"}, "gibraltar": {"236"}, "greece": {"237", "239", "240", "241"},
    "hong kong": {"477"}, "india": {"419"}, "indonesia": {"525"}, "isle of man": {"235"}, "italy": {"247"},
    "jamaica": {"339"}, "japan": {"431", "432"}, "kenya": {"634"}, "kuwait": {"447"}, "liberia": {"636", "637"},
    "madagascar": {"647"}, "malaysia": {"533"}, "maldives": {"455"}, "malta": {"215", "229", "248", "249", "256"},
    "marshall islands": {"538"}, "mauritius": {"645"}, "mexico": {"345"}, "monaco": {"254"}, "morocco": {"242"},
    "mozambique": {"650"}, "netherlands": {"244", "245", "246"}, "new zealand": {"512"}, "nigeria": {"657"},
    "norway": {"257", "258", "259"}, "oman": {"461"}, "panama": {"351", "352", "353", "354", "355", "356", "357", "370", "371", "372", "373"},
    "philippines": {"548"}, "portugal": {"255", "263"}, "qatar": {"466"}, "saudi arabia": {"403"}, "seychelles": {"664"},
    "singapore": {"563", "564", "565", "566"}, "south africa": {"601"}, "spain": {"224", "225"}, "sri lanka": {"417"},
    "st vincent and the grenadines": {"375", "376", "377"}, "sweden": {"265", "266"}, "tanzania": {"674", "677"},
    "thailand": {"567"}, "turkey": {"271"}, "uae": {"470", "471"}, "united arab emirates": {"470", "471"},
    "united kingdom": {"232", "233", "234", "235"}, "uk": {"232", "233", "234", "235"},
    "united states": {"338", "366", "367", "368", "369"}, "usa": {"338", "366", "367", "368", "369"}, "vietnam": {"574"},
}


def mmsi_problem(mmsi: str | None, flag: str) -> str | None:
    if not mmsi:
        return None
    if not re.fullmatch(r"\d{9}", mmsi):
        return "MMSI must be 9 digits"
    mid = mmsi[:3]
    if not ("201" <= mid <= "775"):
        return f"MMSI starts with {mid}, which is not a ship station country code"
    known = MID.get(flag.strip().lower())
    if known and mid not in known:
        return f"MMSI country code {mid} does not match the flag {flag}"
    return None


def imo_problem(imo: str | None) -> str | None:
    if not imo:
        return None
    d = imo.upper().removeprefix("IMO").strip()
    if not re.fullmatch(r"\d{7}", d):
        return "IMO number must be 7 digits"
    if sum(int(d[i]) * (7 - i) for i in range(6)) % 10 != int(d[6]):
        return "IMO number check digit is wrong"
    return None


def sniff_doc(data: bytes) -> str | None:
    if data[:5] == b"%PDF-":
        return "application/pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


# ---------------------------------------------------------------- sign-up pieces used by auth.signup


def check_claim_format(v: VesselClaim) -> None:
    if not (v.mmsi or v.imo):
        raise HTTPException(422, "Give your yacht's MMSI or IMO number so we can confirm it exists")
    for p in (mmsi_problem(v.mmsi, v.flag), imo_problem(v.imo)):
        if p:
            raise HTTPException(422, p)


def use_invite(db: Session, code: str, email: str) -> dict:
    inv = db.execute(text("SELECT * FROM invites WHERE code=:c FOR UPDATE"), {"c": code.strip().upper()}).mappings().first()
    if inv is None:
        raise HTTPException(422, "That invite code is not valid")
    if inv["used_by"] is not None:
        raise HTTPException(422, "That invite code has already been used")
    if inv["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(422, "That invite code has expired. Ask for a new one.")
    if inv["email"] and inv["email"].lower() != email.lower():
        raise HTTPException(422, "That invite was sent to a different email address")
    return dict(inv)


def after_signup(db: Session, uid: int, email: str, join_as: str, vessel: VesselClaim | None, invite: dict | None) -> None:
    if join_as == "owner" and vessel:
        db.execute(
            text("""INSERT INTO owner_claims (user_id, vessel_name, flag, mmsi, imo, loa_m, registry_number)
                    VALUES (:u,:n,:f,:m,:i,:l,:r)"""),
            {"u": uid, "n": vessel.name.strip(), "f": vessel.flag.strip(), "m": vessel.mmsi or None,
             "i": (vessel.imo or "").upper().removeprefix("IMO").strip() or None, "l": vessel.loa_m,
             "r": vessel.registry_number.strip()},
        )
    if invite:
        db.execute(text("UPDATE invites SET used_by=:u, used_at=now() WHERE code=:c"), {"u": uid, "c": invite["code"]})
        if invite["yacht_id"] and invite["role"] in ("crew", "captain"):
            db.execute(
                text("""INSERT INTO yacht_crew (yacht_id, user_id, role, added_by) VALUES (:y,:u,:r,:b)
                        ON CONFLICT (yacht_id, user_id) DO NOTHING"""),
                {"y": invite["yacht_id"], "u": uid, "r": invite["role"], "b": invite["created_by"]},
            )


# ---------------------------------------------------------------- screening


def screen_claim(db: Session, uid: int, use_ai: bool = True) -> dict:
    """Run every check on an owner's claim. Stores and returns {checks, ai, recommendation}."""
    c = db.execute(text("SELECT * FROM owner_claims WHERE user_id=:u"), {"u": uid}).mappings().first()
    if c is None:
        return {}
    checks: list[dict] = []

    def add(key, ok, msg):
        checks.append({"key": key, "ok": ok, "msg": msg})

    p = mmsi_problem(c["mmsi"], c["flag"])
    if c["mmsi"]:
        add("mmsi", p is None, p or f"MMSI {c['mmsi']} is valid for {c['flag']}"
            if MID.get(c["flag"].lower()) else p or f"MMSI {c['mmsi']} is well formed (flag {c['flag']} not on our country list)")
    p = imo_problem(c["imo"])
    if c["imo"]:
        add("imo", p is None, p or f"IMO {c['imo']} check digit is valid")
    for col in ("mmsi", "imo"):
        if c[col]:
            other = db.execute(
                text(f"""SELECT 'yacht' AS kind, id AS ref FROM yachts WHERE {col} = :v
                           AND (owner_user_id IS NULL OR owner_user_id <> :u)
                         UNION ALL SELECT 'claim', user_id::text FROM owner_claims WHERE {col} = :v AND user_id <> :u LIMIT 1"""),
                {"v": c[col], "u": uid},
            ).first()
            add(f"{col}_unique", other is None,
                f"{col.upper()} already belongs to {'yacht ' + other.ref if other.kind == 'yacht' else 'another sign-up'}" if other
                else f"No other account uses this {col.upper()}")
    add("document", c["doc_bytes"] is not None,
        f"Registry document uploaded ({c['doc_mime']}, #{c['doc_sha256'][:10]})" if c["doc_bytes"] is not None
        else "No registry document uploaded yet")

    ai = None
    if use_ai and c["doc_bytes"] is not None:
        from . import ai as ai_mod

        ai = ai_mod.read_registry_document(bytes(c["doc_bytes"]), c["doc_mime"], {
            "vessel_name": c["vessel_name"], "flag": c["flag"], "loa_m": float(c["loa_m"]),
            "registry_number": c["registry_number"], "mmsi": c["mmsi"], "imo": c["imo"]})
        if ai and ai.get("available"):
            add("ai_document", bool(ai.get("matches")),
                "AI read the certificate and it matches what the owner typed" if ai.get("matches")
                else "AI reading of the certificate disagrees: " + "; ".join(ai.get("mismatches") or ["unclear document"]))

    passed = all(x["ok"] for x in checks)
    rec = "recommend_approve" if passed else "needs_review"
    result = {"checks": checks, "ai": ai, "recommendation": rec, "at": datetime.now(timezone.utc).isoformat()}
    import json

    db.execute(text("UPDATE owner_claims SET screening=CAST(:s AS JSONB) WHERE user_id=:u"), {"s": json.dumps(result), "u": uid})
    return result


# ---------------------------------------------------------------- owner: upload proof, see status


@router.post("/me/registry-document")
async def upload_registry_document(request: Request, db: Session = Depends(get_db), user: User = Depends(require_user)):
    data = await request.body()
    if not data:
        raise HTTPException(422, "Send the certificate file as the request body")
    if len(data) > MAX_DOC:
        raise HTTPException(413, "Certificate is larger than 10 MB")
    mime = sniff_doc(data)
    if mime is None:
        raise HTTPException(415, "Upload the certificate as a PDF, JPEG, PNG or WebP")
    n = db.execute(
        text("UPDATE owner_claims SET doc_bytes=:b, doc_mime=:m, doc_sha256=:h WHERE user_id=:u"),
        {"b": data, "m": mime, "h": hashlib.sha256(data).hexdigest(), "u": user.id},
    ).rowcount
    if not n:
        raise HTTPException(404, "This account has no yacht claim to attach a document to")
    result = screen_claim(db, user.id)
    db.commit()
    return {"sha256": hashlib.sha256(data).hexdigest(), "mime": mime, "screening": _public(result)}


def _public(result: dict) -> dict:
    """What the owner sees: the checks, not the AI's raw notes."""
    return {"checks": result.get("checks", []), "recommendation": result.get("recommendation")}


@router.get("/me/registration")
def my_registration(db: Session = Depends(get_db), user: User = Depends(require_user)):
    c = db.execute(
        text("""SELECT c.vessel_name, c.flag, c.mmsi, c.imo, c.loa_m, c.registry_number, c.doc_sha256, c.doc_mime,
                       c.screening, u.status, u.joined_via
                FROM users u LEFT JOIN owner_claims c ON c.user_id = u.id WHERE u.id = :u"""),
        {"u": user.id},
    ).mappings().first()
    d = dict(c) if c else {}
    if d.get("loa_m") is not None:
        d["loa_m"] = float(d["loa_m"])
    d["screening"] = _public(d.get("screening") or {})
    return d


# ---------------------------------------------------------------- invites


class InviteIn(BaseModel):
    role: Literal["crew", "captain", "investor", "marina", "client"]
    yacht_id: str | None = None
    email: EmailStr | None = None
    note: str = Field("", max_length=200)


def _code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I
    g = lambda: "".join(secrets.choice(alphabet) for _ in range(4))
    return f"GYT-{g()}-{g()}"


@router.post("/invites", status_code=201)
def create_invite(body: InviteIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    if user.role != "admin":
        if user.status != "active":
            raise HTTPException(403, "Your account must be approved before you can invite people")
        if body.role not in ("crew", "captain") or not body.yacht_id:
            raise HTTPException(403, "Owners can invite crew or a captain to one of their yachts")
        if role_for(db, user, body.yacht_id) not in ("owner",):
            raise HTTPException(403, "Only the yacht's owner can invite crew to it")
    elif body.role in ("crew", "captain") and not body.yacht_id:
        raise HTTPException(422, "Crew and captain invites are for a specific yacht")
    code = _code()
    exp = datetime.now(timezone.utc) + timedelta(days=get_settings().invite_days)
    db.execute(
        text("""INSERT INTO invites (code, created_by, yacht_id, role, email, note, expires_at)
                VALUES (:c,:b,:y,:r,:e,:n,:x)"""),
        {"c": code, "b": user.id, "y": body.yacht_id, "r": body.role, "e": body.email, "n": body.note, "x": exp},
    )
    db.commit()
    return {"code": code, "role": body.role, "yacht_id": body.yacht_id, "email": body.email, "expires_at": exp}


@router.get("/invites")
def my_invites(db: Session = Depends(get_db), user: User = Depends(require_user)):
    rows = db.execute(
        text("""SELECT i.code, i.role, i.yacht_id, y.name AS yacht, i.email, i.note, i.created_at, i.expires_at,
                       i.used_at, u.name AS used_by_name
                FROM invites i LEFT JOIN yachts y ON y.id = i.yacht_id LEFT JOIN users u ON u.id = i.used_by
                WHERE i.created_by = :u OR :admin ORDER BY i.created_at DESC LIMIT 200"""),
        {"u": user.id, "admin": user.role == "admin"},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.delete("/invites/{code}")
def revoke_invite(code: str, db: Session = Depends(get_db), user: User = Depends(require_user)):
    n = db.execute(
        text("""UPDATE invites SET expires_at = now() WHERE code=:c AND used_by IS NULL AND (created_by=:u OR :admin)"""),
        {"c": code.upper(), "u": user.id, "admin": user.role == "admin"},
    ).rowcount
    db.commit()
    if not n:
        raise HTTPException(404, "Invite not found or already used")
    return {"revoked": True}


# ---------------------------------------------------------------- admin review


@router.get("/admin/registrations")
def registrations(status: str = "pending", db: Session = Depends(get_db), who=Depends(require_right("users"))):
    rows = db.execute(
        text("""SELECT u.id, u.name, u.email, u.status, u.created_at, c.vessel_name, c.flag, c.mmsi, c.imo, c.loa_m,
                       c.registry_number, c.doc_sha256, c.doc_mime, c.screening
                FROM owner_claims c JOIN users u ON u.id = c.user_id
                WHERE (:s = 'all' OR u.status = :s) ORDER BY u.created_at DESC LIMIT 200"""),
        {"s": status},
    ).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["loa_m"] = float(d["loa_m"])
        out.append(d)
    return out


@router.get("/admin/registrations/{uid}/document")
def registration_document(uid: int, db: Session = Depends(get_db), who=Depends(require_right("users"))):
    r = db.execute(text("SELECT doc_bytes, doc_mime FROM owner_claims WHERE user_id=:u"), {"u": uid}).first()
    if r is None or r.doc_bytes is None:
        raise HTTPException(404, "No document")
    return Response(bytes(r.doc_bytes), media_type=r.doc_mime, headers={"Cache-Control": "private, no-store"})


@router.post("/admin/registrations/{uid}/screen")
def rescreen(uid: int, db: Session = Depends(get_db), who=Depends(require_right("users"))):
    res = screen_claim(db, uid)
    db.commit()
    if not res:
        raise HTTPException(404, "No yacht claim for that user")
    return res
