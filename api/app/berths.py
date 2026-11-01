"""Finding and holding a berth, sized to the yacht.

How a berth is chosen:
  * Fit is a hard rule: the yacht's length (LOA) and beam must be within the berth's maximums,
    and its draft within the berth's depth when both are known. A berth that is too small is never
    offered, whatever anyone (or any AI) suggests.
  * Among the berths that fit, the best fit is the one that wastes the least space, so a 28 m yacht
    is offered a 30 m berth before a 60 m one, keeping big berths for big yachts.

How "someone else found it first" works:
  * When an owner picks a berth, the API places a HOLD for those dates (BERTH_HOLD_MINUTES, 10 by
    default) while they confirm and pay. Every other yacht searching the same marina immediately
    sees the berth as "Held by another yacht" with the time the hold runs out.
  * Placing a hold locks the berth row (SELECT ... FOR UPDATE) and the database also refuses two
    active holds, or a hold over a booking, for overlapping dates. Two owners pressing at the same
    moment cannot both win: one gets the hold, the other gets a clear 409 and the next best berth.
  * Confirming turns the hold into an escrowed booking. Holds that are not confirmed expire and the
    berth is offered again.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import User, require_active, require_admin, require_user
from .config import get_settings
from .db import get_db
from .devices import role_for
from .events import record_event

router = APIRouter()


def fit(yacht: dict, berth: dict) -> dict:
    """Does this yacht fit this berth? Returns ok, reasons it doesn't, spare room and a snug flag."""
    reasons = []
    loa, beam = float(yacht["loa_m"]), float(yacht["beam_m"])
    if loa > float(berth["max_loa_m"]):
        reasons.append(f"{loa:g} m long; berth takes up to {float(berth['max_loa_m']):g} m")
    if beam > float(berth["max_beam_m"]):
        reasons.append(f"{beam:g} m beam; berth takes up to {float(berth['max_beam_m']):g} m")
    draft, depth = yacht.get("draft_m"), berth.get("max_draft_m")
    if draft is not None and depth is not None and float(draft) > float(depth):
        reasons.append(f"draws {float(draft):g} m; berth depth {float(depth):g} m")
    spare = round(float(berth["max_loa_m"]) - loa, 2)
    return {
        "ok": not reasons,
        "reasons": reasons,
        "spare_loa_m": spare,
        "snug": not reasons and spare < get_settings().berth_snug_margin_m,
        "draft_unchecked": draft is None or depth is None,
    }


def expire_holds(db: Session) -> int:
    n = db.execute(text("UPDATE berth_holds SET status='expired' WHERE status='active' AND expires_at < now()")).rowcount
    return n or 0


def _dates(arrive: date, depart: date):
    if depart <= arrive:
        raise HTTPException(422, "Departure must be after arrival")
    if (depart - arrive).days > 365:
        raise HTTPException(422, "Book at most a year at a time")


def _yacht(db: Session, yacht_id: str) -> dict:
    y = db.execute(
        text("SELECT id, name, loa_m, beam_m, draft_m, retired_at FROM yachts WHERE id=:i"), {"i": yacht_id}
    ).mappings().first()
    if y is None or y["retired_at"] is not None:
        raise HTTPException(404, "Yacht not found")
    return dict(y)


def _require_yacht_role(db: Session, user: User, yacht_id: str):
    if role_for(db, user, yacht_id) is None:
        raise HTTPException(403, "Only this yacht's owner, its crew or an admin can book berths for it")


# ---------------------------------------------------------------- availability


@router.get("/berths/availability")
def availability(marina_id: str, yacht_id: str, arrive: date, depart: date, db: Session = Depends(get_db),
                 user: User = Depends(require_user)):
    """Every berth at a marina, as this yacht sees it right now, best fit first."""
    _dates(arrive, depart)
    y = _yacht(db, yacht_id)
    expire_holds(db)
    db.commit()
    rows = db.execute(
        text(
            """SELECT b.id, b.code, b.max_loa_m, b.max_beam_m, b.max_draft_m, b.rate_usd_day, b.services, b.status,
                      (SELECT json_build_object('id', h.id, 'yacht_id', h.yacht_id, 'user_id', h.user_id,
                                                'loa_m', hy.loa_m, 'expires_at', h.expires_at)
                         FROM berth_holds h JOIN yachts hy ON hy.id = h.yacht_id
                        WHERE h.berth_id = b.id AND h.status = 'active'
                          AND daterange(h.arrive, h.depart) && daterange(:a, :d) LIMIT 1) AS hold,
                      (SELECT json_build_object('ref', k.ref, 'yacht_id', k.yacht_id, 'arrive', k.arrive, 'depart', k.depart)
                         FROM bookings k WHERE k.berth_id = b.id AND k.status NOT IN ('cancelled','refunded')
                          AND daterange(k.arrive, k.depart) && daterange(:a, :d) LIMIT 1) AS booking
               FROM berths b WHERE b.marina_id = :m ORDER BY b.max_loa_m, b.code"""
        ),
        {"m": marina_id, "a": arrive, "d": depart},
    ).mappings().all()
    if not rows and not db.execute(text("SELECT 1 FROM marinas WHERE id=:m"), {"m": marina_id}).first():
        raise HTTPException(404, "Marina not found")
    nights = (depart - arrive).days
    out = []
    for r in rows:
        f = fit(y, r)
        hold, booking = r["hold"], r["booking"]
        if r["status"] == "maintenance":
            state = "maintenance"
        elif booking:
            state = "booked_by_you" if booking["yacht_id"] == yacht_id else "booked"
        elif hold:
            state = "held_by_you" if hold["yacht_id"] == yacht_id else "held"
        elif not f["ok"]:
            state = "too_small"
        else:
            state = "available"
        out.append({
            "id": r["id"], "code": r["code"], "max_loa_m": float(r["max_loa_m"]), "max_beam_m": float(r["max_beam_m"]),
            "max_draft_m": float(r["max_draft_m"]) if r["max_draft_m"] is not None else None,
            "rate_usd_day": float(r["rate_usd_day"]), "stay_total_usd": float(r["rate_usd_day"]) * nights,
            "services": r["services"], "state": state, "fit": f,
            # other yachts are shown by size only, never by name
            "held_until": hold["expires_at"] if hold else None,
            "hold_id": hold["id"] if hold and hold["yacht_id"] == yacht_id else None,
            "held_by": (f"another yacht ({float(hold['loa_m']):g} m)" if hold and hold["yacht_id"] != yacht_id else None),
        })
    free = [b for b in out if b["state"] == "available"]
    if free:
        best = min(free, key=lambda b: (b["fit"]["spare_loa_m"], b["rate_usd_day"]))
        best["best_fit"] = True
    return {"yacht": {"id": y["id"], "name": y["name"], "loa_m": float(y["loa_m"]), "beam_m": float(y["beam_m"]),
                      "draft_m": float(y["draft_m"]) if y["draft_m"] is not None else None},
            "nights": nights, "hold_minutes": get_settings().berth_hold_minutes, "berths": out,
            "server_time": datetime.now(timezone.utc)}


# ---------------------------------------------------------------- holds


class HoldIn(BaseModel):
    yacht_id: str
    arrive: date
    depart: date


@router.post("/berths/{berth_id}/hold", status_code=201)
def hold(berth_id: int, body: HoldIn, db: Session = Depends(get_db), user: User = Depends(require_active)):
    _dates(body.arrive, body.depart)
    _require_yacht_role(db, user, body.yacht_id)
    y = _yacht(db, body.yacht_id)
    # Lock the berth row: concurrent holds on the same berth queue up here, one at a time.
    b = db.execute(text("SELECT * FROM berths WHERE id=:i FOR UPDATE"), {"i": berth_id}).mappings().first()
    if b is None:
        raise HTTPException(404, "Berth not found")
    if b["status"] == "maintenance":
        raise HTTPException(409, f"Berth {b['code']} is closed for maintenance")
    f = fit(y, b)
    if not f["ok"]:
        raise HTTPException(422, f"{y['name']} does not fit berth {b['code']}: " + "; ".join(f["reasons"]))
    expire_holds(db)
    taken = db.execute(
        text(
            """SELECT 'booking' AS kind, NULL::timestamptz AS until, k.yacht_id FROM bookings k
                WHERE k.berth_id=:b AND k.status NOT IN ('cancelled','refunded') AND daterange(k.arrive,k.depart) && daterange(:a,:d)
               UNION ALL
               SELECT 'hold', h.expires_at, h.yacht_id FROM berth_holds h
                WHERE h.berth_id=:b AND h.status='active' AND daterange(h.arrive,h.depart) && daterange(:a,:d)"""
        ),
        {"b": berth_id, "a": body.arrive, "d": body.depart},
    ).first()
    if taken is not None:
        db.rollback()
        if taken.yacht_id == body.yacht_id:
            raise HTTPException(409, f"{y['name']} already holds or has booked berth {b['code']} for these dates")
        if taken.kind == "booking":
            raise HTTPException(409, f"Berth {b['code']} was just booked by another yacht for these dates")
        raise HTTPException(409, f"Another yacht is holding berth {b['code']} until {taken.until:%H:%M} UTC. Pick another berth or try again then.")
    # One active hold per yacht per marina at a time: picking a new berth releases the old hold.
    db.execute(
        text("""UPDATE berth_holds h SET status='released' FROM berths x
                WHERE h.berth_id = x.id AND x.marina_id = :m AND h.yacht_id = :y AND h.status='active'"""),
        {"m": b["marina_id"], "y": body.yacht_id},
    )
    expires = datetime.now(timezone.utc) + timedelta(minutes=get_settings().berth_hold_minutes)
    try:
        hid = db.execute(
            text("""INSERT INTO berth_holds (berth_id, yacht_id, user_id, arrive, depart, expires_at)
                    VALUES (:b, :y, :u, :a, :d, :e) RETURNING id"""),
            {"b": berth_id, "y": body.yacht_id, "u": user.id, "a": body.arrive, "d": body.depart, "e": expires},
        ).scalar_one()
        record_event(db, body.yacht_id, "BERTH_HOLD", marina_id=b["marina_id"], berth_code=b["code"],
                     payload={"hold": hid, "arrive": str(body.arrive), "depart": str(body.depart)})
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Another yacht took berth {b['code']} a moment ago. Pick another berth.")
    return {"hold_id": hid, "berth": b["code"], "expires_at": expires, "fit": f,
            "stay_total_usd": float(b["rate_usd_day"]) * (body.depart - body.arrive).days}


@router.delete("/berths/holds/{hold_id}")
def release_hold(hold_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)):
    h = db.execute(text("SELECT * FROM berth_holds WHERE id=:i"), {"i": hold_id}).mappings().first()
    if h is None or (h["user_id"] != user.id and user.role != "admin"):
        raise HTTPException(404, "Hold not found")
    if h["status"] == "active":
        db.execute(text("UPDATE berth_holds SET status='released' WHERE id=:i"), {"i": hold_id})
        db.commit()
    return {"released": True}


class ConfirmIn(BaseModel):
    ref: str = Field(pattern=r"^BK-[0-9A-Z]{4,12}$")


@router.post("/berths/holds/{hold_id}/confirm", status_code=201)
def confirm_hold(hold_id: int, body: ConfirmIn, db: Session = Depends(get_db), user: User = Depends(require_active)):
    """Turn a hold into an escrowed booking. Payment waits in escrow until arrival is proven."""
    h = db.execute(text("SELECT * FROM berth_holds WHERE id=:i FOR UPDATE"), {"i": hold_id}).mappings().first()
    if h is None or (h["user_id"] != user.id and user.role != "admin"):
        raise HTTPException(404, "Hold not found")
    if h["status"] != "active":
        raise HTTPException(409, f"This hold has {h['status']}. Search again to pick a berth.")
    if h["expires_at"] < datetime.now(timezone.utc):
        db.execute(text("UPDATE berth_holds SET status='expired' WHERE id=:i"), {"i": hold_id})
        db.commit()
        raise HTTPException(409, "This hold ran out before it was confirmed. Search again to pick a berth.")
    b = db.execute(text("SELECT * FROM berths WHERE id=:i"), {"i": h["berth_id"]}).mappings().first()
    amount = float(b["rate_usd_day"]) * (h["depart"] - h["arrive"]).days
    try:
        # Release the hold first so the booking can take its place under the same no-overlap rule.
        db.execute(text("UPDATE berth_holds SET status='booked', booking_ref=NULL WHERE id=:i"), {"i": hold_id})
        db.execute(
            text("""INSERT INTO bookings (ref,kind,yacht_id,marina_id,berth_id,arrive,depart,amount_usd)
                    VALUES (:r,'berth',:y,:m,:b,:a,:d,:amt)"""),
            dict(r=body.ref, y=h["yacht_id"], m=b["marina_id"], b=b["id"], a=h["arrive"], d=h["depart"], amt=amount),
        )
        db.execute(text("UPDATE berth_holds SET booking_ref=:r WHERE id=:i"), {"r": body.ref, "i": hold_id})
        record_event(db, h["yacht_id"], "BERTH_RESERVE", marina_id=b["marina_id"], berth_code=b["code"], document_hash=body.ref)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        if "bookings_pkey" in str(e.orig):
            raise HTTPException(409, f"Booking {body.ref} already exists")
        raise HTTPException(409, f"Berth {b['code']} is already booked for part of these dates")
    return {"ref": body.ref, "berth": b["code"], "amount_usd": amount, "status": "escrowed"}


# ---------------------------------------------------------------- admin board


@router.get("/admin/berths/board")
def berth_board(marina_id: str, day: date | None = None, db: Session = Depends(get_db), who=Depends(require_admin)):
    """One marina at a glance: every berth, who is in it or holding it, and anything that needs a look."""
    day = day or date.today()
    expire_holds(db)
    db.commit()
    rows = db.execute(
        text(
            """SELECT b.id, b.code, b.max_loa_m, b.max_beam_m, b.max_draft_m, b.rate_usd_day, b.status,
                      k.ref, k.status AS booking_status, k.arrive, k.depart, k.yacht_id AS b_yacht,
                      by_.name AS b_name, by_.loa_m AS b_loa, by_.beam_m AS b_beam, by_.draft_m AS b_draft,
                      h.id AS hold_id, h.expires_at, h.yacht_id AS h_yacht, hy.name AS h_name, hy.loa_m AS h_loa
               FROM berths b
               LEFT JOIN LATERAL (SELECT * FROM bookings k WHERE k.berth_id=b.id AND k.status NOT IN ('cancelled','refunded')
                                   AND :day >= k.arrive AND :day < k.depart ORDER BY k.arrive LIMIT 1) k ON TRUE
               LEFT JOIN yachts by_ ON by_.id = k.yacht_id
               LEFT JOIN LATERAL (SELECT * FROM berth_holds h WHERE h.berth_id=b.id AND h.status='active'
                                   ORDER BY h.created_at LIMIT 1) h ON TRUE
               LEFT JOIN yachts hy ON hy.id = h.yacht_id
               WHERE b.marina_id = :m ORDER BY b.code"""
        ),
        {"m": marina_id, "day": day},
    ).mappings().all()
    flags = db.execute(
        text("""SELECT subject, outcome, summary, at FROM autopilot_log
                WHERE job IN ('berth_fit','arrivals','holds') AND NOT resolved AND outcome='flagged'
                  AND detail->>'marina_id' = :m ORDER BY at DESC LIMIT 50"""),
        {"m": marina_id},
    ).mappings().all()
    board = []
    for r in rows:
        if r["status"] == "maintenance":
            state = "maintenance"
        elif r["ref"]:
            state = "occupied" if r["booking_status"] in ("arrived", "released") else "booked"
        elif r["hold_id"]:
            state = "held"
        else:
            state = "free"
        issues = []
        if r["ref"]:
            f = fit({"loa_m": r["b_loa"], "beam_m": r["b_beam"], "draft_m": r["b_draft"]}, r)
            if not f["ok"]:
                issues.append("Booked yacht does not fit: " + "; ".join(f["reasons"]))
            elif f["snug"]:
                issues.append(f"Snug fit: {f['spare_loa_m']:g} m spare length")
        board.append({
            "id": r["id"], "code": r["code"], "max_loa_m": float(r["max_loa_m"]), "max_beam_m": float(r["max_beam_m"]),
            "max_draft_m": float(r["max_draft_m"]) if r["max_draft_m"] is not None else None,
            "rate_usd_day": float(r["rate_usd_day"]), "state": state,
            "booking": {"ref": r["ref"], "status": r["booking_status"], "yacht_id": r["b_yacht"], "yacht": r["b_name"],
                        "loa_m": float(r["b_loa"]), "arrive": r["arrive"], "depart": r["depart"]} if r["ref"] else None,
            "hold": {"id": r["hold_id"], "yacht_id": r["h_yacht"], "yacht": r["h_name"], "loa_m": float(r["h_loa"]),
                     "expires_at": r["expires_at"]} if r["hold_id"] else None,
            "issues": issues,
            "use_pct": round(100 * float(r["b_loa"]) / float(r["max_loa_m"])) if r["ref"] else None,
        })
    counts = {s: sum(1 for b in board if b["state"] == s) for s in ("free", "held", "booked", "occupied", "maintenance")}
    return {"marina_id": marina_id, "day": day, "counts": counts, "berths": board, "flags": [dict(f) for f in flags]}
