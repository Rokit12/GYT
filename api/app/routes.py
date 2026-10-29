from __future__ import annotations

import re

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import fusion, policy, proof, signing
from .chain import ChainClient
from .config import get_settings
from .db import get_db
from .events import anchor_pending, proof_for_event, record_event
from .auth import User, require_active, require_admin, require_user
from .integrations import KycProvider
from .schemas import (
    AisIn, BerthBookingIn, CreditStayIn, GpsFix, ModeIn, SarIn, TrackerCreate, TransferCheckIn, YachtCreate,
)

router = APIRouter()
s = get_settings()


def _own_wallet(user: User, investor_id: str) -> None:
    if user.role != "admin" and user.investor_id != investor_id:
        raise HTTPException(403, "You can only manage your own holdings")


def row_or_404(row, what: str):
    if row is None:
        raise HTTPException(404, f"{what} not found")
    return row


# ------------------------------------------------------------------ yachts


@router.get("/yachts")
def list_yachts(db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """SELECT y.*, m.name AS marina_name, (SELECT id FROM yacht_photos ph WHERE ph.yacht_id = y.id AND ph.status='published' ORDER BY ph.is_cover DESC, ph.id LIMIT 1) AS cover_photo_id,
                      (SELECT json_build_object('lat', ST_Y(p.location::geometry), 'lon', ST_X(p.location::geometry),
                                                'source', p.source, 'observed_at', p.observed_at)
                       FROM positions p WHERE p.yacht_id = y.id ORDER BY p.observed_at DESC LIMIT 1) AS last_position
               FROM yachts y LEFT JOIN marinas m ON m.id = y.home_marina_id
               WHERE y.twin_status = 'minted' AND y.retired_at IS NULL ORDER BY y.id"""
        )
    ).mappings().all()
    return [dict(r) for r in rows]


@router.get("/yachts/{yacht_id}")
def passport(yacht_id: str, db: Session = Depends(get_db)):
    y = row_or_404(
        db.execute(
            text("SELECT y.*, m.name AS marina_name, (SELECT id FROM yacht_photos ph WHERE ph.yacht_id = y.id AND ph.status='published' ORDER BY ph.is_cover DESC, ph.id LIMIT 1) AS cover_photo_id FROM yachts y LEFT JOIN marinas m ON m.id=y.home_marina_id WHERE y.id=:i"),
            {"i": yacht_id},
        ).mappings().first(),
        "Yacht",
    )
    gaps = db.execute(
        text("SELECT count(*) FROM events WHERE yacht_id=:i AND event_type='AIS_GAP' AND observed_at > now() - interval '90 days'"),
        {"i": yacht_id},
    ).scalar()
    logs = db.execute(
        text("SELECT count(*) FROM events WHERE yacht_id=:i AND event_type='MAINTENANCE_LOG' AND observed_at > now() - interval '12 months'"),
        {"i": yacht_id},
    ).scalar()
    score, factors = policy.condition_score(
        y["inspection_status"], y["insurance_verified"], gaps, y["year_built"], logs, datetime.now(timezone.utc).year
    )
    last = db.execute(
        text(
            """SELECT id, event_type, leaf, anchor_id,
                      (SELECT count(*) FROM events p WHERE p.yacht_id=:i AND p.anchor_id IS NULL) AS pending
               FROM events WHERE yacht_id=:i ORDER BY (anchor_id IS NULL), id DESC LIMIT 1"""
        ),
        {"i": yacht_id},
    ).mappings().first()
    docs = db.execute(text("SELECT kind, filename, sha256, created_at FROM documents WHERE yacht_id=:i"), {"i": yacht_id}).mappings().all()
    val = float(y["valuation_usd"] or 0)
    return {
        **dict(y),
        "condition": {
            "score": score,
            "factors": [{"label": l, "points": p} for l, p in factors],
            "valuation_band_usd": [round(val * (0.88 + score / 1000)), round(val * (0.96 + score / 1000))],
        },
        "documents": [dict(d) for d in docs],
        "latest_event": dict(last) if last else None,
    }


@router.post("/yachts", status_code=201)
def onboard_yacht(body: YachtCreate, db: Session = Depends(get_db), user: User = Depends(require_active)):
    """Owners submit a yacht; it waits as 'pending' until an admin verifies and mints the twin."""
    row_or_404(db.execute(text("SELECT 1 FROM marinas WHERE id=:m"), {"m": body.home_marina_id}).first(), "Marina")
    n = db.execute(text("SELECT count(*) FROM yachts")).scalar() + 1
    yacht_id = f"YACHT-{n:06d}"
    docs_root = proof.merkle_root([bytes.fromhex(d.sha256) for d in body.documents]).hex() if body.documents else None
    try:
        db.execute(
            text(
                """INSERT INTO yachts (id,name,mmsi,imo,flag,registry_ref,loa_m,beam_m,year_built,builder,home_marina_id,
                                       berth_code,valuation_usd,charter_week_usd,units_total,tokenized,docs_root,owner_user_id)
                   VALUES (:id,:name,:mmsi,:imo,:flag,:reg,:loa,:beam,:yb,:builder,:home,:berth,:val,:cw,:units,:tok,:root,:owner)"""
            ),
            dict(
                id=yacht_id, name=body.name, mmsi=body.mmsi, imo=body.imo, flag=body.flag, reg=body.registry_ref,
                loa=body.loa_m, beam=body.beam_m, yb=body.year_built, builder=body.builder, home=body.home_marina_id,
                berth=body.berth_code, val=body.valuation_usd, cw=body.charter_week_usd, units=body.units_total,
                tok=body.units_total > 0, root=docs_root, owner=user.id,
            ),
        )
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A yacht with this MMSI is already registered")
    for d in body.documents:
        db.execute(
            text("INSERT INTO documents (yacht_id,kind,filename,sha256) VALUES (:y,:k,:f,:h)"),
            dict(y=yacht_id, k=d.kind, f=d.filename, h=d.sha256),
        )
    ev = record_event(db, yacht_id, "ONBOARDING_SUBMITTED", marina_id=body.home_marina_id, document_hash=docs_root or "",
                      payload={"submitted_by": user.email})
    db.commit()
    return {"id": yacht_id, "docs_root": docs_root, "genesis_event_id": ev, "twin_status": "pending"}


@router.get("/yachts/{yacht_id}/track")
def track(yacht_id: str, hours: int = Query(24, ge=1, le=24 * 30), source: str = "gps", db: Session = Depends(get_db)):
    geo = db.execute(
        text(
            """SELECT ST_AsGeoJSON(ST_MakeLine(location::geometry ORDER BY observed_at))::json AS line, count(*) AS n
               FROM positions WHERE yacht_id=:i AND source=:s AND observed_at > now() - make_interval(hours => :h)"""
        ),
        {"i": yacht_id, "s": source, "h": hours},
    ).mappings().first()
    return {"type": "Feature", "geometry": geo["line"], "properties": {"yacht_id": yacht_id, "points": geo["n"], "source": source}}


@router.get("/yachts-near")
def yachts_near(lat: float, lon: float, km: float = Query(25, gt=0, le=500), db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """SELECT DISTINCT ON (p.yacht_id) p.yacht_id, y.name, p.source, p.observed_at,
                      ST_Distance(p.location, ST_MakePoint(:lon,:lat)::geography) AS distance_m
               FROM positions p JOIN yachts y ON y.id=p.yacht_id
               WHERE ST_DWithin(p.location, ST_MakePoint(:lon,:lat)::geography, :r)
                 AND p.observed_at > now() - interval '6 hours'
               ORDER BY p.yacht_id, p.observed_at DESC"""
        ),
        {"lat": lat, "lon": lon, "r": km * 1000},
    ).mappings().all()
    return sorted((dict(r) for r in rows), key=lambda r: r["distance_m"])


@router.get("/track/{yacht_id}")
def track_and_hashes(yacht_id: str, hours: int = Query(48, ge=1, le=24 * 30), db: Session = Depends(get_db),
                     user: User = Depends(require_user)):
    """Client tracking view: verified positions plus every event hash and its anchor status."""
    y = row_or_404(db.execute(text("SELECT id, name, mmsi, twin_status, twin_tx, twin_token_id FROM yachts WHERE id=:i AND retired_at IS NULL"),
                              {"i": yacht_id}).mappings().first(), "Yacht")
    pts = db.execute(
        text("""SELECT source, observed_at, ST_Y(location::geometry) lat, ST_X(location::geometry) lon, verified
                FROM positions WHERE yacht_id=:i AND observed_at > now() - make_interval(hours => :h)
                ORDER BY observed_at"""),
        {"i": yacht_id, "h": hours},
    ).mappings().all()
    evs = db.execute(
        text("""SELECT e.id, e.event_type, e.observed_at, e.leaf, e.anchor_id, a.root, a.chain_tx
                FROM events e LEFT JOIN anchors a ON a.id=e.anchor_id WHERE e.yacht_id=:i ORDER BY e.id DESC LIMIT 50"""),
        {"i": yacht_id},
    ).mappings().all()
    return {"yacht": dict(y), "positions": [dict(p) for p in pts], "events": [dict(e) for e in evs]}


@router.get("/verify/{leaf_hex}")
def verify_hash(leaf_hex: str, db: Session = Depends(get_db)):
    """Public: paste any event hash and get its Merkle proof and on-chain anchor."""
    if not re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", leaf_hex):
        raise HTTPException(422, "A hash is 64 hexadecimal characters")
    h = leaf_hex.lower().removeprefix("0x")
    ev = db.execute(text("SELECT id FROM events WHERE leaf=:l"), {"l": h}).first()
    if ev is None:
        raise HTTPException(404, "No GYT record has this hash")
    return proof_for_event(db, ev.id)


# ------------------------------------------------------------------ marinas & berths


@router.get("/marinas")
def marinas(db: Session = Depends(get_db)):
    return [
        dict(r)
        for r in db.execute(
            text("SELECT id,name,region,ST_Y(location::geometry) lat,ST_X(location::geometry) lon,arrival_radius_m FROM marinas ORDER BY id")
        ).mappings()
    ]


@router.get("/marinas/{marina_id}/dashboard")
def marina_dashboard(marina_id: str, db: Session = Depends(get_db)):
    row_or_404(db.execute(text("SELECT 1 FROM marinas WHERE id=:m"), {"m": marina_id}).first(), "Marina")
    berths = db.execute(text("SELECT * FROM berths WHERE marina_id=:m ORDER BY code"), {"m": marina_id}).mappings().all()
    usable = [b for b in berths if b["status"] != "maintenance"]
    occupied = [b for b in berths if b["status"] == "occupied"]
    arrivals = db.execute(
        text(
            """SELECT b.ref, b.kind, b.yacht_id, y.name AS yacht, b.arrive, b.depart, b.amount_usd, b.status, br.code AS berth
               FROM bookings b JOIN yachts y ON y.id=b.yacht_id LEFT JOIN berths br ON br.id=b.berth_id
               WHERE b.marina_id=:m AND b.arrive BETWEEN current_date - 1 AND current_date + 7 ORDER BY b.arrive"""
        ),
        {"m": marina_id},
    ).mappings().all()
    held = db.execute(
        text("SELECT coalesce(sum(amount_usd),0) FROM bookings WHERE marina_id=:m AND kind='berth' AND status IN ('escrowed','arrived')"),
        {"m": marina_id},
    ).scalar()
    return {
        "berths": [dict(b) for b in berths],
        "occupancy": round(len(occupied) / len(usable), 3) if usable else 0,
        "arrivals": [dict(a) for a in arrivals],
        "escrow_held_usd": float(held),
    }


@router.get("/berths/search")
def search_berths(
    loa_m: float, beam_m: float, arrive: str, depart: str, region: str | None = None, db: Session = Depends(get_db)
):
    rows = db.execute(
        text(
            """SELECT b.*, m.name AS marina_name, m.region,
                      b.rate_usd_day * (CAST(:dep AS date) - CAST(:arr AS date)) AS stay_total_usd
               FROM berths b JOIN marinas m ON m.id=b.marina_id
               WHERE b.max_loa_m >= :loa AND b.max_beam_m >= :beam AND b.status <> 'maintenance'
                 AND (CAST(:region AS text) IS NULL OR m.region = :region)
                 AND NOT EXISTS (
                     SELECT 1 FROM bookings k WHERE k.berth_id=b.id AND k.status NOT IN ('cancelled','refunded')
                       AND daterange(k.arrive,k.depart) && daterange(CAST(:arr AS date), CAST(:dep AS date)))
               ORDER BY b.rate_usd_day"""
        ),
        dict(loa=loa_m, beam=beam_m, arr=arrive, dep=depart, region=region),
    ).mappings().all()
    return [dict(r) for r in rows]


@router.patch("/berths/{berth_id}", dependencies=[Depends(require_admin)])
def set_berth_status(berth_id: int, status: str = Query(pattern="^(available|reserved|occupied|maintenance)$"), db: Session = Depends(get_db)):
    n = db.execute(text("UPDATE berths SET status=:s WHERE id=:i"), {"s": status, "i": berth_id}).rowcount
    if not n:
        raise HTTPException(404, "Berth not found")
    db.commit()
    return {"id": berth_id, "status": status}


# ------------------------------------------------------------------ tracking


@router.post("/trackers", status_code=201, dependencies=[Depends(require_admin)])
def register_tracker(body: TrackerCreate, db: Session = Depends(get_db)):
    row_or_404(db.execute(text("SELECT 1 FROM yachts WHERE id=:y"), {"y": body.yacht_id}).first(), "Yacht")
    db.execute(
        text("""INSERT INTO trackers (id,yacht_id,public_key) VALUES (:i,:y,:k)
                ON CONFLICT (id) DO UPDATE SET public_key=EXCLUDED.public_key, yacht_id=EXCLUDED.yacht_id, active=TRUE"""),
        {"i": body.tracker_id, "y": body.yacht_id, "k": body.public_key},
    )
    db.commit()
    return {"tracker_id": body.tracker_id}


def _insert_position(db, yacht_id, source, lat, lon, ts, verified, sog=None, cog=None, length=None, raw=None):
    db.execute(
        text(
            """INSERT INTO positions (yacht_id,source,observed_at,location,sog_kn,cog_deg,est_length_m,verified,raw)
               VALUES (:y,:s,:t,ST_MakePoint(:lon,:lat)::geography,:sog,:cog,:len,:v,CAST(:raw AS JSONB))"""
        ),
        dict(y=yacht_id, s=source, t=ts, lat=lat, lon=lon, sog=sog, cog=cog, len=length, v=verified, raw=raw),
    )


@router.post("/tracking/gps", status_code=202)
def ingest_gps(fix: GpsFix, db: Session = Depends(get_db)):
    t = db.execute(
        text("SELECT public_key, yacht_id FROM trackers WHERE id=:i AND active"), {"i": fix.tracker_id}
    ).first()
    if t is None or t.yacht_id != fix.yacht_id:
        raise HTTPException(403, "Unknown tracker or tracker not registered to this yacht")
    msg = signing.gps_message(fix.tracker_id, fix.yacht_id, fix.lat, fix.lon, fix.observed_at)
    if not signing.verify(t.public_key, msg, fix.signature):
        raise HTTPException(422, "Signature does not match this tracker's key")
    _insert_position(db, fix.yacht_id, "gps", fix.lat, fix.lon, fix.observed_at, True, fix.sog_kn, fix.cog_deg)
    db.commit()
    return {"accepted": True}


@router.post("/tracking/ais", status_code=202, dependencies=[Depends(require_admin)])
def ingest_ais(records: list[AisIn], db: Session = Depends(get_db)):
    ids = dict(db.execute(text("SELECT mmsi, id FROM yachts WHERE mmsi IS NOT NULL")).all())
    n = 0
    for r in records:
        if r.mmsi in ids:
            _insert_position(db, ids[r.mmsi], "ais", r.lat, r.lon, r.observed_at, False, r.sog_kn, r.cog_deg)
            n += 1
    db.commit()
    return {"accepted": n, "ignored": len(records) - n}


@router.post("/tracking/sar", status_code=202, dependencies=[Depends(require_admin)])
def ingest_sar(d: SarIn, db: Session = Depends(get_db)):
    _insert_position(db, d.yacht_id, "sar", d.lat, d.lon, d.observed_at, True, length=d.est_length_m,
                     raw=f'{{"provider":"{d.provider}"}}')
    db.commit()
    return {"accepted": True}


# ------------------------------------------------------------------ bookings & escrow


@router.post("/bookings/berth", status_code=201)
def book_berth(body: BerthBookingIn, db: Session = Depends(get_db), user: User = Depends(require_active)):
    b = row_or_404(db.execute(text("SELECT * FROM berths WHERE id=:i"), {"i": body.berth_id}).mappings().first(), "Berth")
    y = row_or_404(db.execute(text("SELECT loa_m, beam_m FROM yachts WHERE id=:i"), {"i": body.yacht_id}).first(), "Yacht")
    if y.loa_m > b["max_loa_m"] or y.beam_m > b["max_beam_m"]:
        raise HTTPException(422, f"Yacht ({y.loa_m} m × {y.beam_m} m) does not fit berth {b['code']}")
    amount = float(b["rate_usd_day"]) * (body.depart - body.arrive).days
    try:
        db.execute(
            text(
                """INSERT INTO bookings (ref,kind,yacht_id,marina_id,berth_id,arrive,depart,amount_usd)
                   VALUES (:r,'berth',:y,:m,:b,:a,:d,:amt)"""
            ),
            dict(r=body.ref, y=body.yacht_id, m=b["marina_id"], b=body.berth_id, a=body.arrive, d=body.depart, amt=amount),
        )
        record_event(db, body.yacht_id, "BERTH_RESERVE", marina_id=b["marina_id"], berth_code=b["code"], document_hash=body.ref)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        if "bookings_pkey" in str(e.orig):
            raise HTTPException(409, f"Booking {body.ref} already exists")
        raise HTTPException(409, f"Berth {b['code']} is already booked for part of these dates")
    return {"ref": body.ref, "amount_usd": amount, "status": "escrowed"}


@router.get("/bookings", dependencies=[Depends(require_admin)])
def list_bookings(limit: int = Query(50, le=500), db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """SELECT b.ref, b.kind, b.yacht_id, y.name AS yacht, m.name AS marina, br.code AS berth, b.arrive, b.depart,
                      b.amount_usd, b.status, b.arrival_event_id
               FROM bookings b JOIN yachts y ON y.id=b.yacht_id JOIN marinas m ON m.id=b.marina_id
               LEFT JOIN berths br ON br.id=b.berth_id ORDER BY b.created_at DESC LIMIT :n"""
        ),
        {"n": limit},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.get("/investors", dependencies=[Depends(require_admin)])
def list_investors(db: Session = Depends(get_db)):
    return [dict(r) for r in db.execute(text("SELECT * FROM investors ORDER BY id")).mappings()]


@router.post("/bookings/{ref}/arrival", dependencies=[Depends(require_admin)])
def prove_arrival(ref: str, db: Session = Depends(get_db)):
    bk = row_or_404(
        db.execute(
            text(
                """SELECT b.*, y.loa_m, y.twin_token_id, ST_Y(m.location::geometry) mlat, ST_X(m.location::geometry) mlon,
                          m.arrival_radius_m
                   FROM bookings b JOIN yachts y ON y.id=b.yacht_id JOIN marinas m ON m.id=b.marina_id WHERE b.ref=:r"""
            ),
            {"r": ref},
        ).mappings().first(),
        "Booking",
    )
    if bk["status"] != "escrowed":
        raise HTTPException(409, f"Booking is {bk['status']}, not awaiting arrival")
    window = datetime.now(timezone.utc) - timedelta(minutes=s.fusion_window_minutes)

    def latest(src):
        r = db.execute(
            text(
                """SELECT ST_Y(location::geometry) lat, ST_X(location::geometry) lon, observed_at, verified, est_length_m
                   FROM positions WHERE yacht_id=:y AND source=:s AND observed_at >= :w ORDER BY observed_at DESC LIMIT 1"""
            ),
            {"y": bk["yacht_id"], "s": src, "w": window},
        ).first()
        return fusion.Obs(src, r.lat, r.lon, r.observed_at, r.verified, r.est_length_m) if r else None

    res = fusion.fuse_arrival(
        bk["mlat"], bk["mlon"], bk["arrival_radius_m"], float(bk["loa_m"]),
        gps=latest("gps"), ais=latest("ais"), sar=latest("sar"), max_spread_m=s.fusion_max_spread_m,
    )
    out = res.as_dict()
    if not res.arrived:
        return out
    leaf = proof.arrival_leaf(
        proof.to_bytes32(ref), int(bk["twin_token_id"] or 0), proof.to_bytes32(bk["marina_id"]), bytes.fromhex(res.digest)
    )
    gps = next(x for x in res.signals if x.source == "gps")
    ev = record_event(
        db, bk["yacht_id"], "ARRIVAL_PROOF", marina_id=bk["marina_id"], payload={"booking": ref, **out}, leaf=leaf,
    )
    db.execute(
        text("UPDATE bookings SET status='arrived', arrival_event_id=:e, fusion_digest=:d WHERE ref=:r"),
        {"e": ev, "d": res.digest, "r": ref},
    )
    db.commit()
    out.update(arrival_event_id=ev, leaf=leaf.hex(), gps_distance_m=gps.distance_to_target_m)
    return out


@router.post("/bookings/{ref}/release", dependencies=[Depends(require_admin)])
def release(ref: str, db: Session = Depends(get_db)):
    """After the arrival leaf is anchored, the oracle calls ArrivalEscrow.release with this proof."""
    bk = row_or_404(db.execute(text("SELECT * FROM bookings WHERE ref=:r"), {"r": ref}).mappings().first(), "Booking")
    if bk["status"] != "arrived":
        raise HTTPException(409, "Arrival not proven yet")
    p = proof_for_event(db, bk["arrival_event_id"])
    if not p["anchored"]:
        raise HTTPException(409, "Arrival proof is waiting for the next anchor")
    db.execute(text("UPDATE bookings SET status='released' WHERE ref=:r"), {"r": ref})
    record_event(db, bk["yacht_id"], "ESCROW_RELEASE", marina_id=bk["marina_id"], document_hash=ref)
    db.commit()
    return {
        "ref": ref,
        "status": "released",
        "escrow_call": {
            "function": "release(bytes32,bytes32,bytes32[],uint256,uint256)",
            "ref": "0x" + proof.to_bytes32(ref).hex(),
            "fusionDigest": "0x" + bk["fusion_digest"],
            "proof": ["0x" + x for x in p["proof"]],
            "leafIndex": p["leaf_index"],
            "anchorIndex": p["chain_index"],
        },
    }


# ------------------------------------------------------------------ proofs


@router.post("/anchors", dependencies=[Depends(require_admin)])
def anchor_now(db: Session = Depends(get_db)):
    return anchor_pending(db, ChainClient()) or {"anchored": 0}


@router.get("/anchors")
def anchors(limit: int = Query(20, le=200), db: Session = Depends(get_db)):
    return [dict(r) for r in db.execute(text("SELECT * FROM anchors ORDER BY id DESC LIMIT :n"), {"n": limit}).mappings()]


@router.get("/proofs/recent")
def recent_proofs(limit: int = Query(12, ge=1, le=50), db: Session = Depends(get_db)):
    """Public: the newest anchored record hashes, for the home page ticker."""
    rows = db.execute(
        text("""SELECT e.leaf, e.event_type, e.yacht_id, e.observed_at, a.id AS anchor_id, a.chain_tx
                FROM events e JOIN anchors a ON a.id = e.anchor_id ORDER BY e.id DESC LIMIT :n"""),
        {"n": limit},
    ).mappings().all()
    return [dict(r) for r in rows]


@router.get("/proofs/{event_id}")
def get_proof(event_id: int, db: Session = Depends(get_db)):
    return row_or_404(proof_for_event(db, event_id), "Event")


# ------------------------------------------------------------------ compliance & investors


@router.post("/investors/{investor_id}/screen", dependencies=[Depends(require_admin)])
def screen(investor_id: str, db: Session = Depends(get_db)):
    inv = row_or_404(db.execute(text("SELECT * FROM investors WHERE id=:i"), {"i": investor_id}).first(), "Investor")
    r = KycProvider().screen(inv.id, inv.name, inv.country_code)
    db.execute(text("UPDATE investors SET screening=:s WHERE id=:i"), {"s": r.status, "i": investor_id})
    db.commit()
    return {"investor_id": investor_id, "screening": r.status, "reference": r.reference}


@router.post("/investors/{investor_id}/kyc", dependencies=[Depends(require_admin)])
def set_kyc(investor_id: str, status: str = Query(pattern="^(approved|rejected)$"), db: Session = Depends(get_db)):
    inv = row_or_404(db.execute(text("SELECT screening FROM investors WHERE id=:i"), {"i": investor_id}).first(), "Investor")
    if status == "approved" and inv.screening != "clear":
        raise HTTPException(409, f"Cannot approve: screening is {inv.screening.replace('_', ' ')}")
    db.execute(
        text("UPDATE investors SET kyc_status=:s, kyc_expires=current_date + 365 WHERE id=:i"), {"s": status, "i": investor_id}
    )
    db.commit()
    return {"investor_id": investor_id, "kyc_status": status}


@router.post("/compliance/check-transfer")
def check_transfer(body: TransferCheckIn, db: Session = Depends(get_db)):
    inv = row_or_404(db.execute(text("SELECT * FROM investors WHERE id=:i"), {"i": body.investor_id}).first(), "Investor")
    y = row_or_404(db.execute(text("SELECT units_total FROM yachts WHERE id=:i"), {"i": body.yacht_id}).first(), "Yacht")
    cfg = db.execute(text("SELECT * FROM compliance_config WHERE yacht_id=:i"), {"i": body.yacht_id}).first()
    bal = db.execute(
        text("SELECT coalesce(units,0) FROM holdings WHERE investor_id=:i AND yacht_id=:y"), {"i": inv.id, "y": body.yacht_id}
    ).scalar() or 0
    checks = policy.transfer_checks(
        policy.InvestorView(inv.kyc_status, inv.screening, inv.country_code, inv.professional, inv.kyc_expires),
        body.units, bal, y.units_total,
        list(cfg.allowed_countries) if cfg else [], cfg.professional_max_bps if cfg else 2500,
        cfg.retail_max_bps if cfg else 200, cfg.lockup_until if cfg else None,
    )
    return {"allowed": all(c.ok for c in checks), "checks": [c.__dict__ for c in checks]}


def _holdings(db, investor_id):
    return [
        policy.HoldingView(r.yacht_id, r.units, r.units_total, float(r.valuation_usd), r.mode)
        for r in db.execute(
            text(
                """SELECT h.yacht_id, h.units, h.mode, y.units_total, y.valuation_usd
                   FROM holdings h JOIN yachts y ON y.id=h.yacht_id WHERE h.investor_id=:i"""
            ),
            {"i": investor_id},
        )
    ]


def _spent(db, investor_id, year):
    return float(
        db.execute(
            text("SELECT coalesce(sum(amount_usd),0) FROM credit_spend WHERE investor_id=:i AND year=:y"),
            {"i": investor_id, "y": year},
        ).scalar()
    )


@router.get("/investors/{investor_id}/earn")
def earn_summary(investor_id: str, db: Session = Depends(get_db)):
    row_or_404(db.execute(text("SELECT 1 FROM investors WHERE id=:i"), {"i": investor_id}).first(), "Investor")
    hs = _holdings(db, investor_id)
    year = datetime.now(timezone.utc).year
    summary = policy.credit_summary(
        hs, _spent(db, investor_id, year), s.credit_rate, s.holder_discount, s.earn_share, s.earn_occupancy
    )
    return {
        **summary,
        "year": year,
        "holdings": [
            {**h.__dict__, "stake_usd": round(policy.stake_usd(h), 2), "credits_usd": round(policy.stake_usd(h) * s.credit_rate, 2)}
            for h in hs
        ],
    }


@router.put("/investors/{investor_id}/holdings/{yacht_id}/mode")
def set_mode(investor_id: str, yacht_id: str, body: ModeIn, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _own_wallet(user, investor_id)
    if body.mode == "earn":
        hs = _holdings(db, investor_id)
        year = datetime.now(timezone.utc).year
        use_after = sum(policy.stake_usd(h) * s.credit_rate for h in hs if h.mode == "use" and h.yacht_id != yacht_id)
        if use_after < _spent(db, investor_id, year):
            raise HTTPException(409, "Credits from this holding are already spent this year. Cancel a stay first.")
    n = db.execute(
        text("UPDATE holdings SET mode=:m WHERE investor_id=:i AND yacht_id=:y"), {"m": body.mode, "i": investor_id, "y": yacht_id}
    ).rowcount
    if not n:
        raise HTTPException(404, "Holding not found")
    db.commit()
    return {"yacht_id": yacht_id, "mode": body.mode}


@router.post("/investors/{investor_id}/stays", status_code=201)
def book_credit_stay(investor_id: str, body: CreditStayIn, db: Session = Depends(get_db), user: User = Depends(require_active)):
    _own_wallet(user, investor_id)
    y = row_or_404(
        db.execute(
            text("SELECT id, charter_week_usd, home_marina_id, insurance_verified FROM yachts WHERE id=:i"), {"i": body.yacht_id}
        ).first(),
        "Yacht",
    )
    if not y.insurance_verified:
        raise HTTPException(422, "This yacht's insurance is not verified, so it cannot take guests")
    cost = policy.stay_cost(float(y.charter_week_usd), body.nights, s.holder_discount)
    year = datetime.now(timezone.utc).year
    summ = policy.credit_summary(
        _holdings(db, investor_id), _spent(db, investor_id, year), s.credit_rate, s.holder_discount, s.earn_share, s.earn_occupancy
    )
    if cost > summ["use_credits_left_usd"]:
        raise HTTPException(
            402, f"This stay needs ${cost:,.0f} in credits and ${summ['use_credits_left_usd']:,.0f} is left"
        )
    db.execute(
        text(
            """INSERT INTO bookings (ref,kind,yacht_id,marina_id,investor_id,arrive,depart,amount_usd)
               VALUES (:r,'credit_stay',:y,:m,:i,:a,:a + :n,:amt)"""
        ),
        dict(r=body.ref, y=y.id, m=y.home_marina_id, i=investor_id, a=body.arrive, n=body.nights, amt=cost),
    )
    db.execute(
        text("INSERT INTO credit_spend (investor_id,year,amount_usd,booking_ref) VALUES (:i,:y,:a,:r)"),
        dict(i=investor_id, y=year, a=cost, r=body.ref),
    )
    record_event(db, y.id, "CREDIT_STAY_RESERVE", marina_id=y.home_marina_id, document_hash=body.ref)
    db.commit()
    return {"ref": body.ref, "credits_usd": cost, "status": "escrowed"}


# ------------------------------------------------------------------ live maps


def _bbox(bbox: str | None):
    if not bbox:
        return None
    try:
        b = tuple(float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(422, "bbox is minLon,minLat,maxLon,maxLat")
    if len(b) != 4 or not (-180 <= b[0] <= 180 and -90 <= b[1] <= 90 and -180 <= b[2] <= 180 and -90 <= b[3] <= 90):
        raise HTTPException(422, "bbox is minLon,minLat,maxLon,maxLat")
    return b


@router.get("/live/status")
def live_status():
    from .live import live

    return live.state()


@router.get("/live/vessels")
def live_vessels(bbox: str | None = None, kind: str = Query("yachts", pattern="^(yachts|all|fleet)$")):
    """Public AIS traffic heard by the live feed (aisstream.io), as GeoJSON."""
    from .live import live

    return live.snapshot(_bbox(bbox), kind)


@router.get("/live/fleet")
def live_fleet(trail_minutes: int = Query(120, ge=0, le=24 * 60), db: Session = Depends(get_db)):
    """Latest position of every minted yacht (signed GPS first, then AIS), with a short trail."""
    rows = db.execute(
        text(
            """SELECT y.id, y.name, y.mmsi, y.loa_m, y.insurance_verified, m.name AS home,
                      p.source, p.observed_at, ST_Y(p.location::geometry) lat, ST_X(p.location::geometry) lon, p.sog_kn, p.cog_deg,
                      (SELECT ST_AsGeoJSON(ST_MakeLine(q.location::geometry ORDER BY q.observed_at))::json FROM positions q
                        WHERE q.yacht_id = y.id AND q.source = p.source
                          AND q.observed_at > p.observed_at - make_interval(mins => :tm)) AS trail
               FROM yachts y
               JOIN marinas m ON m.id = y.home_marina_id
               JOIN LATERAL (SELECT * FROM positions WHERE yacht_id = y.id AND source IN ('gps','ais')
                             ORDER BY (source = 'gps') DESC, observed_at DESC LIMIT 1) p ON TRUE
               WHERE y.twin_status = 'minted' AND y.retired_at IS NULL"""
        ),
        {"tm": trail_minutes},
    ).mappings().all()
    now = datetime.now(timezone.utc)
    feats = []
    for r in rows:
        trail = r["trail"] if r["trail"] and r["trail"].get("type") == "LineString" else None
        cog = r["cog_deg"]
        if cog is None and trail and len(trail["coordinates"]) >= 2:
            (x1, y1), (x2, y2) = trail["coordinates"][-2], trail["coordinates"][-1]
            import math

            cog = (math.degrees(math.atan2((x2 - x1) * math.cos(math.radians(y2)), y2 - y1)) + 360) % 360
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
            "properties": {
                "id": r["id"], "name": r["name"], "mmsi": r["mmsi"], "loa_m": float(r["loa_m"]), "home": r["home"],
                "source": r["source"], "observed_at": r["observed_at"].isoformat(),
                "age_s": round((now - r["observed_at"]).total_seconds()), "sog": r["sog_kn"], "cog": cog,
                "insured": r["insurance_verified"], "trail": trail["coordinates"] if trail and trail_minutes else None,
            },
        })
    return {"type": "FeatureCollection", "features": feats}
