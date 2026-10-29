"""Client accounts: profile and settings, followed yachts, the personal dashboard, and unit economics.

Unit economics, in one place:
  * Each tokenized yacht is owned by its own company (SPV). That company issues `units_total` units.
  * One unit is an equal economic share of the SPV: 1 / units_total of the yacht.
  * Indicative unit price = latest independent valuation / units_total. It moves only when a new
    valuation is recorded; it is not a market quote and nobody is obliged to buy at it.
"""
from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import User, current_user, hash_password, password_problems, require_user, verify_password
from .db import get_db

router = APIRouter()

INTERESTS = {"charter", "invest", "own", "marina", "track"}
NOTIFY_KEYS = {"arrivals", "ais_gaps", "documents", "bookings", "payouts", "weekly"}
WALLET_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def unit_price(valuation, units_total) -> float | None:
    if not valuation or not units_total:
        return None
    return round(float(valuation) / int(units_total), 2)


# ---------------------------------------------------------------- profile

class ProfileIn(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    phone: str | None = Field(default=None, max_length=32)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    interests: list[str] | None = None
    notify: dict[str, bool] | None = None
    wallet_address: str | None = None


def _profile(db: Session, uid: int) -> dict:
    r = db.execute(text("""
        SELECT u.id, u.email, u.name, u.role, u.status, u.phone, u.country, u.interests, u.notify, u.wallet_address,
               u.investor_id, u.created_at, u.last_login_at, u.password_changed_at,
               i.kyc_status, i.screening, i.professional, i.kyc_expires
        FROM users u LEFT JOIN investors i ON i.id = u.investor_id WHERE u.id = :i"""), {"i": uid}).mappings().first()
    if r is None:
        raise HTTPException(401, "Account no longer exists")
    p = dict(r)
    p["interests"] = list(p["interests"] or [])
    return p


@router.get("/me/profile")
def get_profile(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return _profile(db, user.id)


@router.patch("/me/profile")
def update_profile(body: ProfileIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    sets, params = [], {"i": user.id}
    if body.name is not None:
        sets.append("name=:name"); params["name"] = body.name.strip()
    if body.phone is not None:
        phone = body.phone.strip()
        if phone and not re.fullmatch(r"\+?[0-9 ()-]{6,30}", phone):
            raise HTTPException(422, "Phone number should contain digits, spaces and an optional leading +")
        sets.append("phone=:phone"); params["phone"] = phone or None
    if body.country is not None:
        sets.append("country=:country"); params["country"] = body.country.upper()
    if body.interests is not None:
        bad = set(body.interests) - INTERESTS
        if bad:
            raise HTTPException(422, f"Unknown interest: {', '.join(sorted(bad))}")
        sets.append("interests=:interests"); params["interests"] = sorted(set(body.interests))
    if body.notify is not None:
        bad = set(body.notify) - NOTIFY_KEYS
        if bad:
            raise HTTPException(422, f"Unknown notification: {', '.join(sorted(bad))}")
        import json
        sets.append("notify = notify || CAST(:notify AS jsonb)"); params["notify"] = json.dumps(body.notify)
    if body.wallet_address is not None:
        w = body.wallet_address.strip()
        if w and not WALLET_RE.match(w):
            raise HTTPException(422, "Wallet address should be 0x followed by 40 hex characters")
        sets.append("wallet_address=:w"); params["w"] = w or None
    if sets:
        db.execute(text(f"UPDATE users SET {', '.join(sets)} WHERE id=:i"), params)
        db.commit()
    return _profile(db, user.id)


class PasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=128)
    new: str = Field(min_length=8, max_length=128)


@router.post("/me/password")
def change_password(body: PasswordIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    h = db.execute(text("SELECT password_hash FROM users WHERE id=:i"), {"i": user.id}).scalar()
    if not h or not verify_password(body.current, h):
        raise HTTPException(403, "Current password is incorrect")
    probs = password_problems(body.new)
    if probs:
        raise HTTPException(422, "New password needs " + ", ".join(probs))
    if body.new == body.current:
        raise HTTPException(422, "Choose a password you have not used for this account")
    db.execute(text("UPDATE users SET password_hash=:h, password_changed_at=now() WHERE id=:i"), {"h": hash_password(body.new), "i": user.id})
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- follows

def follow_yachts(db: Session, uid: int, ids: list[str]) -> list[str]:
    ok = [r[0] for r in db.execute(text("SELECT id FROM yachts WHERE id = ANY(:ids) AND retired_at IS NULL"), {"ids": ids})]
    for yid in ok:
        db.execute(text("INSERT INTO follows (user_id, yacht_id) VALUES (:u,:y) ON CONFLICT DO NOTHING"), {"u": uid, "y": yid})
    return ok


@router.get("/me/follows")
def list_follows(user: User = Depends(require_user), db: Session = Depends(get_db)):
    return [r[0] for r in db.execute(text("SELECT yacht_id FROM follows WHERE user_id=:u ORDER BY created_at"), {"u": user.id})]


@router.put("/me/follows/{yacht_id}", status_code=204)
def follow(yacht_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if not follow_yachts(db, user.id, [yacht_id]):
        raise HTTPException(404, "Yacht not found")
    db.commit()


@router.delete("/me/follows/{yacht_id}", status_code=204)
def unfollow(yacht_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    db.execute(text("DELETE FROM follows WHERE user_id=:u AND yacht_id=:y"), {"u": user.id, "y": yacht_id})
    db.commit()


# ---------------------------------------------------------------- dashboard

@router.get("/me/dashboard")
def dashboard(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Everything about the yachts this person follows or holds units in, in one call."""
    inv = db.execute(text("SELECT investor_id FROM users WHERE id=:u"), {"u": user.id}).scalar()
    yachts = [dict(r) for r in db.execute(text("""
        WITH mine AS (
            SELECT yacht_id FROM follows WHERE user_id = :u
            UNION SELECT yacht_id FROM holdings WHERE investor_id = :inv AND units > 0
            UNION SELECT id FROM yachts WHERE owner_user_id = :u)
        SELECT y.id, y.name, y.flag, y.loa_m, y.units_total, y.valuation_usd, y.charter_week_usd, y.tokenized,
               y.inspection_status, y.insurance_verified, m.name AS marina_name, y.twin_status,
               (y.owner_user_id = :u) AS owner,
               (SELECT id FROM yacht_photos ph WHERE ph.yacht_id = y.id AND ph.status = 'published'
                ORDER BY ph.is_cover DESC, ph.id LIMIT 1) AS cover_photo_id,
               (SELECT count(*) FROM yacht_photos ph WHERE ph.yacht_id = y.id) AS photo_count,
               (f.user_id IS NOT NULL) AS following, COALESCE(h.units, 0) AS units, h.mode,
               p.source AS pos_source, p.observed_at AS pos_at, p.lat, p.lon, p.sog_kn,
               (SELECT count(*) FROM events e WHERE e.yacht_id = y.id AND e.observed_at > now() - interval '7 days') AS events_7d
        FROM mine JOIN yachts y ON y.id = mine.yacht_id
        LEFT JOIN marinas m ON m.id = y.home_marina_id
        LEFT JOIN follows f ON f.yacht_id = y.id AND f.user_id = :u
        LEFT JOIN holdings h ON h.yacht_id = y.id AND h.investor_id = :inv
        LEFT JOIN LATERAL (
            SELECT source, observed_at, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, sog_kn
            FROM positions WHERE yacht_id = y.id ORDER BY observed_at DESC LIMIT 1) p ON TRUE
        ORDER BY y.name"""), {"u": user.id, "inv": inv}).mappings()]
    for y in yachts:
        y["unit_price_usd"] = unit_price(y["valuation_usd"], y["units_total"])
        y["holding_value_usd"] = round(y["unit_price_usd"] * y["units"], 2) if y["unit_price_usd"] and y["units"] else 0
        y["share_pct"] = round(100 * y["units"] / y["units_total"], 4) if y["units_total"] and y["units"] else 0
    ids = [y["id"] for y in yachts]
    activity = [dict(r) for r in db.execute(text("""
        SELECT e.id, e.yacht_id, y.name AS yacht_name, e.event_type, e.observed_at, e.marina_id, e.leaf, e.anchor_id, e.payload
        FROM events e JOIN yachts y ON y.id = e.yacht_id
        WHERE e.yacht_id = ANY(:ids) ORDER BY e.observed_at DESC, e.id DESC LIMIT 80"""), {"ids": ids}).mappings()] if ids else []
    bookings = [dict(r) for r in db.execute(text("""
        SELECT b.ref, b.kind, b.yacht_id, y.name AS yacht_name, m.name AS marina_name, b.arrive, b.depart, b.amount_usd, b.status, b.created_at
        FROM bookings b JOIN yachts y ON y.id = b.yacht_id JOIN marinas m ON m.id = b.marina_id
        WHERE b.investor_id = :inv OR b.yacht_id = ANY(:ids) ORDER BY b.arrive DESC LIMIT 20"""), {"inv": inv, "ids": ids}).mappings()]
    upcoming = sum(1 for b in bookings if b["arrive"] >= date.today() and b["status"] in ("escrowed", "arrived"))
    return {
        "profile": _profile(db, user.id),
        "yachts": yachts,
        "activity": activity,
        "bookings": bookings,
        "summary": {
            "following": sum(1 for y in yachts if y["following"]),
            "owned": sum(1 for y in yachts if y["owner"]),
            "holdings": sum(1 for y in yachts if y["units"]),
            "units": sum(y["units"] for y in yachts),
            "portfolio_usd": round(sum(y["holding_value_usd"] for y in yachts), 2),
            "upcoming_bookings": upcoming,
            "events_7d": sum(y["events_7d"] for y in yachts),
        },
    }


# ---------------------------------------------------------------- units (public)

def _holder_label(row, n: int) -> str:
    if row["wallet"]:
        return f"{row['wallet'][:6]}…{row['wallet'][-4:]}"
    return f"Holder {n:02d}"


@router.get("/yachts/{yacht_id}/units")
def yacht_units(yacht_id: str, db: Session = Depends(get_db), user: User | None = Depends(current_user)):
    """Who owns a yacht's units (pseudonymous), what one unit is worth, and how that price has moved."""
    y = db.execute(text("""SELECT id, name, units_total, units_minted, valuation_usd, tokenized, units_contract
                           FROM yachts WHERE id=:y"""), {"y": yacht_id}).mappings().first()
    if y is None:
        raise HTTPException(404, "Yacht not found")
    me_inv = None
    if user:
        me_inv = db.execute(text("SELECT investor_id FROM users WHERE id=:u"), {"u": user.id}).scalar()
    rows = db.execute(text("""
        SELECT h.investor_id, h.units, h.mode, i.kind, i.professional, i.wallet
        FROM holdings h JOIN investors i ON i.id = h.investor_id
        WHERE h.yacht_id = :y AND h.units > 0 AND i.deleted_at IS NULL ORDER BY h.units DESC"""), {"y": yacht_id}).mappings().all()
    total = int(y["units_total"] or 0)
    price = unit_price(y["valuation_usd"], total)
    held = sum(r["units"] for r in rows)
    holders = [{
        "label": _holder_label(r, n), "kind": r["kind"], "professional": r["professional"], "units": r["units"],
        "pct": round(100 * r["units"] / total, 3) if total else 0, "mode": r["mode"],
        "value_usd": round(r["units"] * price, 2) if price else None, "you": bool(me_inv and r["investor_id"] == me_inv),
    } for n, r in enumerate(rows, 1)]
    history = [{"date": r.valued_at.isoformat(), "value_usd": float(r.value_usd), "unit_price_usd": unit_price(r.value_usd, total), "source": r.source}
               for r in db.execute(text("SELECT valued_at, value_usd, source FROM valuations WHERE yacht_id=:y ORDER BY valued_at"), {"y": yacht_id})]
    return {
        "yacht_id": y["id"], "name": y["name"], "tokenized": y["tokenized"], "contract": y["units_contract"],
        "units_total": total, "units_minted": int(y["units_minted"] or 0), "units_held": held,
        "units_available": max(0, total - held),
        "valuation_usd": float(y["valuation_usd"]) if y["valuation_usd"] else None,
        "unit_price_usd": price, "unit_share_pct": round(100 / total, 6) if total else None,
        "holders": holders, "holder_count": len(holders), "history": history,
    }
