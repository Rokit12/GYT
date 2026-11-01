"""Software tracking: follow a yacht from a signed-in phone or laptop, no hardware GPS needed.

The owner (or crew the owner adds, or an admin) opens "Track from this device" while aboard and
presses Start. The browser reads the device's location and sends a fix every few seconds while
the page stays open. Each fix is stored in `positions` with source 'device'.

How much a device fix is trusted:
  * it is tied to a signed-in person and a sharing session, not to a key sealed in hardware,
    so it ranks below signed onboard GPS and above nothing;
  * fixes vaguer than DEVICE_MAX_ACCURACY_M are refused; fixes within DEVICE_GOOD_ACCURACY_M are
    marked verified (good), the rest are stored as approximate;
  * a jump faster than DEVICE_MAX_SPEED_KN from the previous fix is stored but flagged, never
    marked good;
  * for an arrival proof a good device fix may stand in for signed GPS, but AIS or satellite
    radar must still agree with it (see fusion.fuse_arrival).

Starting and stopping a session each record a hashed event on the yacht's timeline.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import User, require_user
from .config import get_settings
from .db import get_db
from .events import record_event
from .fusion import haversine_m

router = APIRouter()
MS_TO_KN = 1.943844


def role_for(db: Session, user: User, yacht_id: str) -> str | None:
    """'admin', 'owner', 'crew' or None."""
    if user.role == "admin":
        return "admin"
    r = db.execute(
        text(
            """SELECT CASE WHEN y.owner_user_id = :u THEN 'owner'
                           WHEN EXISTS (SELECT 1 FROM yacht_crew c WHERE c.yacht_id = y.id AND c.user_id = :u) THEN 'crew'
                      END AS role
               FROM yachts y WHERE y.id = :y"""
        ),
        {"y": yacht_id, "u": user.id},
    ).first()
    return r.role if r else None


def _require_yacht(db: Session, yacht_id: str):
    y = db.execute(text("SELECT id, name, retired_at FROM yachts WHERE id=:y"), {"y": yacht_id}).first()
    if y is None:
        raise HTTPException(404, "Yacht not found")
    if y.retired_at is not None:
        raise HTTPException(409, "This yacht is retired")
    return y


def _require_tracker(db: Session, user: User, yacht_id: str) -> str:
    if not get_settings().device_tracking_enabled:
        raise HTTPException(503, "Device tracking is switched off on this server")
    _require_yacht(db, yacht_id)
    role = role_for(db, user, yacht_id)
    if role is None:
        raise HTTPException(403, "Only this yacht's owner, its crew or an admin can share its location")
    return role


# ---------------------------------------------------------------- which yachts can I track


@router.get("/me/trackable")
def my_trackable(db: Session = Depends(get_db), user: User = Depends(require_user)):
    """Yachts the signed-in person may share location for, with any session they have running."""
    cond = "TRUE" if user.role == "admin" else "(y.owner_user_id = :u OR c.user_id IS NOT NULL)"
    rows = db.execute(
        text(
            f"""SELECT y.id, y.name, y.twin_status, y.loa_m,
                       CASE WHEN :admin THEN 'admin' WHEN y.owner_user_id = :u THEN 'owner' ELSE 'crew' END AS role,
                       s.id AS session_id, s.started_at, s.last_seen_at, s.fixes,
                       (SELECT json_build_object('lat', ST_Y(p.location::geometry), 'lon', ST_X(p.location::geometry),
                                                 'at', p.observed_at, 'source', p.source, 'accuracy_m', p.accuracy_m)
                          FROM positions p WHERE p.yacht_id = y.id ORDER BY p.observed_at DESC LIMIT 1) AS last_position
                FROM yachts y
                LEFT JOIN yacht_crew c ON c.yacht_id = y.id AND c.user_id = :u
                LEFT JOIN LATERAL (SELECT * FROM device_sessions d WHERE d.yacht_id = y.id AND d.user_id = :u
                                   AND d.ended_at IS NULL ORDER BY d.started_at DESC LIMIT 1) s ON TRUE
                WHERE y.retired_at IS NULL AND {cond}
                ORDER BY y.name"""
        ),
        {"u": user.id, "admin": user.role == "admin"},
    ).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["loa_m"] = float(d["loa_m"]) if d["loa_m"] is not None else None
        d["session_id"] = str(d["session_id"]) if d["session_id"] else None
        out.append(d)
    return {"yachts": out, "settings": _public_settings()}


def _public_settings():
    s = get_settings()
    return {
        "enabled": s.device_tracking_enabled,
        "min_interval_s": s.device_min_interval_s,
        "max_accuracy_m": s.device_max_accuracy_m,
        "good_accuracy_m": s.device_good_accuracy_m,
    }


# ---------------------------------------------------------------- sessions


class StartIn(BaseModel):
    label: str = Field("", max_length=60)


@router.post("/yachts/{yacht_id}/device/start", status_code=201)
def start_session(yacht_id: str, body: StartIn, request: Request, db: Session = Depends(get_db),
                  user: User = Depends(require_user)):
    role = _require_tracker(db, user, yacht_id)
    # One running session per person per yacht: starting again closes the old one.
    db.execute(
        text("UPDATE device_sessions SET ended_at = now() WHERE yacht_id=:y AND user_id=:u AND ended_at IS NULL"),
        {"y": yacht_id, "u": user.id},
    )
    sid = uuid.uuid4()
    label = body.label.strip() or "Phone or laptop"
    db.execute(
        text("""INSERT INTO device_sessions (id, yacht_id, user_id, label, user_agent)
                VALUES (:i, :y, :u, :l, :ua)"""),
        {"i": sid, "y": yacht_id, "u": user.id, "l": label, "ua": request.headers.get("user-agent", "")[:300]},
    )
    record_event(db, yacht_id, "DEVICE_TRACKING_STARTED",
                 payload={"session": str(sid), "by": role, "user_id": user.id, "label": label})
    db.commit()
    return {"session_id": str(sid), "role": role, "label": label, "settings": _public_settings()}


def _session(db: Session, user: User, yacht_id: str, sid: str):
    try:
        uuid.UUID(sid)
    except ValueError:
        raise HTTPException(404, "Sharing session not found")
    s = db.execute(
        text("SELECT * FROM device_sessions WHERE id=:i AND yacht_id=:y"), {"i": sid, "y": yacht_id}
    ).mappings().first()
    if s is None or (s["user_id"] != user.id and user.role != "admin"):
        raise HTTPException(404, "Sharing session not found")
    return s


class StopIn(BaseModel):
    session_id: str


@router.post("/yachts/{yacht_id}/device/stop")
def stop_session(yacht_id: str, body: StopIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_tracker(db, user, yacht_id)
    s = _session(db, user, yacht_id, body.session_id)
    if s["ended_at"] is None:
        db.execute(text("UPDATE device_sessions SET ended_at = now() WHERE id=:i"), {"i": s["id"]})
        record_event(db, yacht_id, "DEVICE_TRACKING_STOPPED",
                     payload={"session": str(s["id"]), "fixes": s["fixes"], "rejected": s["rejected"]})
        db.commit()
    return {"stopped": True, "fixes": s["fixes"]}


class PointIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(gt=0, le=100_000)
    observed_at: datetime
    speed_mps: float | None = Field(None, ge=0, le=200)
    heading_deg: float | None = Field(None, ge=0, le=360)


class FixIn(PointIn):
    session_id: str


@router.post("/yachts/{yacht_id}/device/fix", status_code=202)
def device_fix(yacht_id: str, fix: FixIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_tracker(db, user, yacht_id)
    s = _session(db, user, yacht_id, fix.session_id)
    if s["ended_at"] is not None:
        raise HTTPException(409, "This sharing session has ended. Start sharing again.")
    return _store_fix(db, yacht_id, s, fix)


class BatchIn(BaseModel):
    session_id: str
    fixes: list[PointIn] = Field(max_length=500)


@router.post("/yachts/{yacht_id}/device/fixes", status_code=202)
def device_fixes(yacht_id: str, body: BatchIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    """Upload fixes a device kept while it had no connection (sent in time order)."""
    _require_tracker(db, user, yacht_id)
    s = _session(db, user, yacht_id, body.session_id)
    results = [_store_fix(db, yacht_id, s, f, commit=False) for f in sorted(body.fixes, key=lambda f: f.observed_at)]
    db.commit()
    return {"accepted": sum(1 for r in results if r["accepted"]), "results": results}


def _store_fix(db: Session, yacht_id: str, s, fix: PointIn, commit: bool = True) -> dict:
    cfg = get_settings()
    now = datetime.now(timezone.utc)
    ts = fix.observed_at if fix.observed_at.tzinfo else fix.observed_at.replace(tzinfo=timezone.utc)

    def refuse(reason: str, code: str):
        db.execute(text("UPDATE device_sessions SET rejected = rejected + 1, last_seen_at = now() WHERE id=:i"), {"i": s["id"]})
        if commit:
            db.commit()
        return {"accepted": False, "reason": reason, "code": code}

    if ts > now + timedelta(minutes=2):
        return refuse("The device clock is ahead of the server. Check the date and time settings.", "CLOCK_AHEAD")
    if ts < s["started_at"] - timedelta(minutes=1) or ts < now - timedelta(days=7):
        return refuse("This fix is older than the sharing session.", "TOO_OLD")
    if fix.accuracy_m > cfg.device_max_accuracy_m:
        return refuse(f"Location is too vague ({fix.accuracy_m:.0f} m). Turn on precise location or move into the open.",
                      "LOW_ACCURACY")

    prev = db.execute(
        text(
            """SELECT ST_Y(location::geometry) lat, ST_X(location::geometry) lon, observed_at
               FROM positions WHERE yacht_id=:y AND source='device' AND raw->>'session' = :sid
               ORDER BY observed_at DESC LIMIT 1"""
        ),
        {"y": yacht_id, "sid": str(s["id"])},
    ).first()
    flags: list[str] = []
    if prev is not None:
        dt = (ts - prev.observed_at).total_seconds()
        if dt <= 0:
            return {"accepted": False, "reason": "Already have a newer fix.", "code": "OUT_OF_ORDER"}
        if dt < cfg.device_min_interval_s:
            return {"accepted": False, "reason": "Too soon after the last fix.", "code": "THROTTLED"}
        dist = haversine_m(prev.lat, prev.lon, fix.lat, fix.lon)
        kn = dist / dt * MS_TO_KN
        # Allow for the fixes' own uncertainty before calling a jump impossible.
        if dist > 2 * fix.accuracy_m and kn > cfg.device_max_speed_kn:
            flags.append(f"JUMP_{kn:.0f}KN")

    good = fix.accuracy_m <= cfg.device_good_accuracy_m and not flags
    sog = round(fix.speed_mps * MS_TO_KN, 1) if fix.speed_mps is not None else None
    raw = {"session": str(s["id"]), "label": s["label"], "user_id": s["user_id"], "flags": flags}
    db.execute(
        text(
            """INSERT INTO positions (yacht_id,source,observed_at,location,sog_kn,cog_deg,verified,accuracy_m,raw)
               VALUES (:y,'device',:t,ST_MakePoint(:lon,:lat)::geography,:sog,:cog,:v,:acc,CAST(:raw AS JSONB))"""
        ),
        dict(y=yacht_id, t=ts, lat=fix.lat, lon=fix.lon, sog=sog, cog=fix.heading_deg, v=good, acc=fix.accuracy_m,
             raw=json.dumps(raw)),
    )
    db.execute(text("UPDATE device_sessions SET fixes = fixes + 1, last_seen_at = now() WHERE id=:i"), {"i": s["id"]})
    if commit:
        db.commit()
    return {"accepted": True, "good": good, "flags": flags}


@router.get("/yachts/{yacht_id}/device/sessions")
def sessions(yacht_id: str, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_tracker(db, user, yacht_id)
    rows = db.execute(
        text(
            """SELECT d.id::text AS id, d.label, d.started_at, d.last_seen_at, d.ended_at, d.fixes, d.rejected,
                      u.name AS shared_by
               FROM device_sessions d JOIN users u ON u.id = d.user_id
               WHERE d.yacht_id = :y ORDER BY d.started_at DESC LIMIT 50"""
        ),
        {"y": yacht_id},
    ).mappings().all()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- crew


class CrewIn(BaseModel):
    email: EmailStr
    role: str = Field("crew", pattern="^(crew|captain)$")


def _require_owner(db: Session, user: User, yacht_id: str):
    _require_yacht(db, yacht_id)
    if role_for(db, user, yacht_id) not in ("owner", "admin"):
        raise HTTPException(403, "Only the yacht's owner or an admin can manage its crew")


@router.get("/yachts/{yacht_id}/crew")
def list_crew(yacht_id: str, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_owner(db, user, yacht_id)
    rows = db.execute(
        text("""SELECT u.id, u.name, u.email, c.role, c.added_at FROM yacht_crew c JOIN users u ON u.id = c.user_id
                WHERE c.yacht_id = :y ORDER BY c.added_at"""),
        {"y": yacht_id},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.post("/yachts/{yacht_id}/crew", status_code=201)
def add_crew(yacht_id: str, body: CrewIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_owner(db, user, yacht_id)
    u = db.execute(text("SELECT id, name FROM users WHERE email = :e"), {"e": body.email}).first()
    if u is None:
        raise HTTPException(404, "No GYT account uses that email. Ask them to sign up first, then add them.")
    db.execute(
        text("""INSERT INTO yacht_crew (yacht_id, user_id, role, added_by) VALUES (:y, :u, :r, :b)
                ON CONFLICT (yacht_id, user_id) DO UPDATE SET role = EXCLUDED.role"""),
        {"y": yacht_id, "u": u.id, "r": body.role, "b": user.id},
    )
    db.commit()
    return {"id": u.id, "name": u.name, "role": body.role}


@router.delete("/yachts/{yacht_id}/crew/{user_id}")
def remove_crew(yacht_id: str, user_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_owner(db, user, yacht_id)
    db.execute(text("DELETE FROM yacht_crew WHERE yacht_id=:y AND user_id=:u"), {"y": yacht_id, "u": user_id})
    db.execute(text("UPDATE device_sessions SET ended_at = now() WHERE yacht_id=:y AND user_id=:u AND ended_at IS NULL"),
               {"y": yacht_id, "u": user_id})
    db.commit()
    return {"removed": True}
