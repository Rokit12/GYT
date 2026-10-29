"""Admin console API: everything an operator monitors, edits, approves or removes.

Every write records an audit_log row with the acting admin. Banking numbers are encrypted at
rest and never returned in full. Deletes of records that money or proofs depend on are soft
(retired / deleted_at) so history and proofs stay intact.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from nacl import secret, utils
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import policy, proof
from .auth import User, require_admin
from .chain import ChainClient
from .config import get_settings
from .db import get_db
from .events import record_event

router = APIRouter(prefix="/admin", tags=["admin"])


def actor(u: User | None) -> str:
    return u.email if u else "service"


def audit(db: Session, who: User | None, action: str, entity: str, entity_id, detail: dict | None = None):
    db.execute(
        text("INSERT INTO audit_log (actor,action,entity,entity_id,detail) VALUES (:a,:ac,:e,:i,CAST(:d AS JSONB))"),
        dict(a=actor(who), ac=action, e=entity, i=str(entity_id), d=json.dumps(detail or {}, default=str)),
    )


def rows(db: Session, sql: str, **p):
    return [dict(r) for r in db.execute(text(sql), p).mappings()]


# ---------------------------------------------------------------- overview & monitoring


@router.get("/overview")
def overview(db: Session = Depends(get_db), who=Depends(require_admin)):
    q = lambda sql: db.execute(text(sql)).scalar()  # noqa: E731
    return {
        "users_pending": q("SELECT count(*) FROM users WHERE status='pending'"),
        "users_total": q("SELECT count(*) FROM users"),
        "yachts_active": q("SELECT count(*) FROM yachts WHERE retired_at IS NULL"),
        "twins_awaiting_mint": q("SELECT count(*) FROM yachts WHERE twin_status IN ('pending','verified') AND retired_at IS NULL"),
        "kyc_pending": q("SELECT count(*) FROM investors WHERE kyc_status='pending' AND deleted_at IS NULL"),
        "bank_unverified": q("SELECT count(*) FROM bank_accounts WHERE status='pending_verification'"),
        "escrow_held_usd": float(q("SELECT coalesce(sum(amount_usd),0) FROM bookings WHERE status IN ('escrowed','arrived')")),
        "events_unanchored": q("SELECT count(*) FROM events WHERE anchor_id IS NULL"),
        "anchors": q("SELECT count(*) FROM anchors"),
    }


@router.get("/monitoring")
def monitoring(db: Session = Depends(get_db), who=Depends(require_admin)):
    """Latest fix per source for every yacht, how old it is, and what needs attention."""
    data = rows(
        db,
        """SELECT y.id, y.name, y.mmsi, y.twin_status, y.insurance_verified, y.inspection_status,
                  m.name AS home_marina,
                  (SELECT json_object_agg(src, json_build_object(
                        'lat', ST_Y(p.location::geometry), 'lon', ST_X(p.location::geometry),
                        'at', p.observed_at, 'age_min', round(extract(epoch FROM now() - p.observed_at)/60)))
                   FROM (SELECT DISTINCT ON (source) source AS src, location, observed_at FROM positions
                         WHERE yacht_id = y.id ORDER BY source, observed_at DESC) p) AS last_fix,
                  ST_Distance((SELECT location FROM positions WHERE yacht_id=y.id AND source='gps'
                               ORDER BY observed_at DESC LIMIT 1), m.location) AS gps_from_home_m
           FROM yachts y LEFT JOIN marinas m ON m.id=y.home_marina_id
           WHERE y.retired_at IS NULL ORDER BY y.id""",
    )
    for d in data:
        f = d["last_fix"] or {}
        alerts = []
        if "gps" not in f:
            alerts.append(("warn", "No signed GPS fix yet"))
        elif f["gps"]["age_min"] > 60:
            alerts.append(("warn", f"GPS silent for {int(f['gps']['age_min'])} min"))
        if "gps" in f and "ais" in f:
            from .fusion import haversine_m

            gap = haversine_m(f["gps"]["lat"], f["gps"]["lon"], f["ais"]["lat"], f["ais"]["lon"])
            if gap > get_settings().fusion_max_spread_m and abs(f["gps"]["age_min"] - f["ais"]["age_min"]) < 30:
                alerts.append(("crit", f"AIS {gap / 1000:.1f} km from signed GPS: possible spoofing"))
        if not d["insurance_verified"]:
            alerts.append(("crit", "Insurance not verified"))
        if d["inspection_status"] != "VALID":
            alerts.append(("warn", f"Inspection {d['inspection_status'].lower().replace('_', ' ')}"))
        d["alerts"] = [{"severity": s, "text": t} for s, t in alerts]
    return data


@router.get("/audit")
def audit_log(limit: int = Query(100, le=1000), db: Session = Depends(get_db), who=Depends(require_admin)):
    return rows(db, "SELECT * FROM audit_log ORDER BY id DESC LIMIT :n", n=limit)


# ---------------------------------------------------------------- users


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    role: Literal["client", "admin"] | None = None
    status: Literal["pending", "active", "suspended"] | None = None
    investor_id: str | None = None
    wallet_address: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{40}$")


@router.get("/users")
def users(status: str | None = None, db: Session = Depends(get_db), who=Depends(require_admin)):
    return rows(
        db,
        """SELECT id,email,name,role,status,investor_id,wallet_address,created_at,last_login_at FROM users
           WHERE (CAST(:s AS text) IS NULL OR status=:s) ORDER BY (status='pending') DESC, id""",
        s=status,
    )


def _admins_left(db, excluding: int) -> int:
    return db.execute(
        text("SELECT count(*) FROM users WHERE role='admin' AND status='active' AND id<>:i"), {"i": excluding}
    ).scalar()


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    cur = db.execute(text("SELECT * FROM users WHERE id=:i"), {"i": user_id}).mappings().first()
    if cur is None:
        raise HTTPException(404, "User not found")
    changes = body.model_dump(exclude_unset=True)
    demoting = changes.get("role") == "client" or changes.get("status") in ("suspended", "pending")
    if cur["role"] == "admin" and demoting and _admins_left(db, user_id) == 0:
        raise HTTPException(409, "This is the last active admin. Promote another admin first.")
    if changes.get("investor_id"):
        if not db.execute(text("SELECT 1 FROM investors WHERE id=:i"), {"i": changes["investor_id"]}).first():
            raise HTTPException(404, "Investor not found")
    if not changes:
        return dict(cur)
    sets = ", ".join(f"{k}=:{k}" for k in changes)
    db.execute(text(f"UPDATE users SET {sets} WHERE id=:id"), {**changes, "id": user_id})
    action = "approve" if changes.get("status") == "active" and cur["status"] == "pending" else "update"
    audit(db, who, action, "user", user_id, changes)
    db.commit()
    return rows(db, "SELECT id,email,name,role,status,investor_id,wallet_address FROM users WHERE id=:i", i=user_id)[0]


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, db: Session = Depends(get_db), who=Depends(require_admin)):
    cur = db.execute(text("SELECT role,email FROM users WHERE id=:i"), {"i": user_id}).first()
    if cur is None:
        raise HTTPException(404, "User not found")
    if who and who.id == user_id:
        raise HTTPException(409, "You cannot delete your own account")
    if cur.role == "admin" and _admins_left(db, user_id) == 0:
        raise HTTPException(409, "This is the last admin")
    db.execute(text("DELETE FROM users WHERE id=:i"), {"i": user_id})
    audit(db, who, "delete", "user", user_id, {"email": cur.email})
    db.commit()


# ---------------------------------------------------------------- banking


def _box() -> secret.SecretBox:
    key = get_settings().bank_data_key
    if not key or len(key) != 64:
        raise HTTPException(500, "BANK_DATA_KEY must be set to 64 hex characters")
    return secret.SecretBox(bytes.fromhex(key))


def encrypt_number(n: str) -> str:
    return _box().encrypt(n.encode(), utils.random(secret.SecretBox.NONCE_SIZE)).hex()


def decrypt_number(enc: str) -> str:
    return _box().decrypt(bytes.fromhex(enc)).decode()


class BankIn(BaseModel):
    owner_type: Literal["user", "marina", "investor", "yacht_spv", "platform"]
    owner_id: str = Field(min_length=1, max_length=40)
    account_name: str = Field(min_length=2, max_length=120)
    bank_name: str = Field(min_length=2, max_length=120)
    country: str = Field(min_length=2, max_length=60)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    swift_bic: str | None = Field(default=None, pattern=r"^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")
    account_number: str = Field(min_length=6, max_length=40, description="IBAN or local account number")


class BankPatch(BaseModel):
    account_name: str | None = Field(default=None, min_length=2, max_length=120)
    bank_name: str | None = Field(default=None, min_length=2, max_length=120)
    country: str | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    swift_bic: str | None = Field(default=None, pattern=r"^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$")
    account_number: str | None = Field(default=None, min_length=6, max_length=40)
    status: Literal["pending_verification", "verified", "disabled"] | None = None


BANK_COLS = "id,owner_type,owner_id,account_name,bank_name,country,currency,swift_bic,last4,status,created_at,updated_at"


def _clean_number(n: str) -> str:
    c = re.sub(r"[\s-]", "", n).upper()
    if not re.fullmatch(r"[A-Z0-9]{6,34}", c):
        raise HTTPException(422, "Account number may contain only letters and digits (IBAN or local format)")
    return c


@router.get("/bank-accounts")
def bank_accounts(db: Session = Depends(get_db), who=Depends(require_admin)):
    return rows(db, f"SELECT {BANK_COLS} FROM bank_accounts ORDER BY id DESC")


@router.post("/bank-accounts", status_code=201)
def add_bank(body: BankIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    num = _clean_number(body.account_number)
    bid = db.execute(
        text(
            """INSERT INTO bank_accounts (owner_type,owner_id,account_name,bank_name,country,currency,swift_bic,number_enc,last4)
               VALUES (:ot,:oi,:an,:bn,:c,:cur,:sw,:enc,:l4) RETURNING id"""
        ),
        dict(ot=body.owner_type, oi=body.owner_id, an=body.account_name, bn=body.bank_name, c=body.country,
             cur=body.currency, sw=body.swift_bic, enc=encrypt_number(num), l4=num[-4:]),
    ).scalar_one()
    audit(db, who, "create", "bank_account", bid, {"owner": f"{body.owner_type}:{body.owner_id}", "last4": num[-4:]})
    db.commit()
    return rows(db, f"SELECT {BANK_COLS} FROM bank_accounts WHERE id=:i", i=bid)[0]


@router.patch("/bank-accounts/{bank_id}")
def update_bank(bank_id: int, body: BankPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    if not db.execute(text("SELECT 1 FROM bank_accounts WHERE id=:i"), {"i": bank_id}).first():
        raise HTTPException(404, "Bank account not found")
    ch = body.model_dump(exclude_unset=True)
    logged = {k: v for k, v in ch.items() if k != "account_number"}
    if "account_number" in ch:
        num = _clean_number(ch.pop("account_number"))
        ch.update(number_enc=encrypt_number(num), last4=num[-4:], status="pending_verification")
        logged.update(last4=num[-4:], number_changed=True)
    if ch:
        sets = ", ".join(f"{k}=:{k}" for k in ch)
        db.execute(text(f"UPDATE bank_accounts SET {sets}, updated_at=now() WHERE id=:id"), {**ch, "id": bank_id})
        audit(db, who, "update", "bank_account", bank_id, logged)
        db.commit()
    return rows(db, f"SELECT {BANK_COLS} FROM bank_accounts WHERE id=:i", i=bank_id)[0]


@router.delete("/bank-accounts/{bank_id}", status_code=204)
def delete_bank(bank_id: int, db: Session = Depends(get_db), who=Depends(require_admin)):
    r = db.execute(text("DELETE FROM bank_accounts WHERE id=:i RETURNING last4"), {"i": bank_id}).first()
    if r is None:
        raise HTTPException(404, "Bank account not found")
    audit(db, who, "delete", "bank_account", bank_id, {"last4": r.last4})
    db.commit()


# ---------------------------------------------------------------- yachts & minting


class YachtPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    flag: str | None = None
    loa_m: float | None = Field(default=None, gt=2, lt=250)
    beam_m: float | None = Field(default=None, gt=1, lt=40)
    home_marina_id: str | None = None
    berth_code: str | None = None
    valuation_usd: float | None = Field(default=None, gt=0)
    charter_week_usd: float | None = Field(default=None, ge=0)
    insurance_verified: bool | None = None
    inspection_status: Literal["VALID", "PENDING", "DUE_30D", "EXPIRED"] | None = None
    units_total: int | None = Field(default=None, ge=0)
    units_contract: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{40}$")


@router.get("/yachts")
def admin_yachts(db: Session = Depends(get_db), who=Depends(require_admin)):
    return rows(
        db,
        """SELECT y.*, m.name AS marina_name,
                  (SELECT coalesce(sum(units),0) FROM holdings h WHERE h.yacht_id=y.id) AS units_held
           FROM yachts y LEFT JOIN marinas m ON m.id=y.home_marina_id ORDER BY y.retired_at NULLS FIRST, y.id""",
    )


@router.patch("/yachts/{yacht_id}")
def update_yacht(yacht_id: str, body: YachtPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    ch = body.model_dump(exclude_unset=True)
    if not ch:
        raise HTTPException(422, "Nothing to update")
    if "units_total" in ch:
        minted = db.execute(text("SELECT units_minted FROM yachts WHERE id=:i"), {"i": yacht_id}).scalar()
        if minted is not None and ch["units_total"] < minted:
            raise HTTPException(409, f"{minted} units are already minted; total cannot go below that")
        ch["tokenized"] = ch["units_total"] > 0
    sets = ", ".join(f"{k}=:{k}" for k in ch)
    n = db.execute(text(f"UPDATE yachts SET {sets} WHERE id=:id AND retired_at IS NULL"), {**ch, "id": yacht_id}).rowcount
    if not n:
        raise HTTPException(404, "Yacht not found or retired")
    audit(db, who, "update", "yacht", yacht_id, ch)
    record_event(db, yacht_id, "RECORD_UPDATE", document_hash=proof.sha256(json.dumps(ch, sort_keys=True, default=str).encode()).hex())
    db.commit()
    return rows(db, "SELECT * FROM yachts WHERE id=:i", i=yacht_id)[0]


@router.delete("/yachts/{yacht_id}", status_code=204)
def retire_yacht(yacht_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    """Soft delete: the yacht leaves listings but its history and proofs stay verifiable."""
    if db.execute(text("SELECT 1 FROM bookings WHERE yacht_id=:i AND status IN ('escrowed','arrived')"), {"i": yacht_id}).first():
        raise HTTPException(409, "This yacht has money in escrow. Settle or refund those bookings first.")
    n = db.execute(
        text("UPDATE yachts SET retired_at=now(), twin_status='retired' WHERE id=:i AND retired_at IS NULL"), {"i": yacht_id}
    ).rowcount
    if not n:
        raise HTTPException(404, "Yacht not found or already retired")
    record_event(db, yacht_id, "TWIN_RETIRE")
    audit(db, who, "delete", "yacht", yacht_id, {"soft": True})
    db.commit()


@router.post("/yachts/{yacht_id}/verify")
def verify_yacht(yacht_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    y = db.execute(text("SELECT twin_status FROM yachts WHERE id=:i"), {"i": yacht_id}).first()
    if y is None:
        raise HTTPException(404, "Yacht not found")
    if y.twin_status != "pending":
        raise HTTPException(409, f"Twin is already {y.twin_status}")
    db.execute(text("UPDATE yachts SET twin_status='verified' WHERE id=:i"), {"i": yacht_id})
    record_event(db, yacht_id, "VERIFICATION_PASSED")
    audit(db, who, "approve", "yacht", yacht_id, {"step": "verification"})
    db.commit()
    return {"id": yacht_id, "twin_status": "verified"}


@router.post("/yachts/{yacht_id}/mint-twin")
def mint_twin(yacht_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    y = db.execute(
        text("SELECT id, twin_status, flag, registry_ref, mmsi, docs_root FROM yachts WHERE id=:i"), {"i": yacht_id}
    ).first()
    if y is None:
        raise HTTPException(404, "Yacht not found")
    if y.twin_status != "verified":
        raise HTTPException(409, "Verify the yacht before minting" if y.twin_status == "pending" else f"Twin is already {y.twin_status}")
    reg_ref = proof.sha256(f"{y.flag}|{y.registry_ref or y.mmsi or ''}".encode())
    docs_root = bytes.fromhex(y.docs_root) if y.docs_root else b"\x00" * 32
    chain = ChainClient()
    receipt = chain.mint_twin(yacht_id, reg_ref, docs_root) if chain.twin_enabled else None
    token_id = receipt.index if receipt else db.execute(text("SELECT coalesce(max(twin_token_id),0)+1 FROM yachts")).scalar()
    tx = receipt.tx_hash if receipt else None
    db.execute(
        text("UPDATE yachts SET twin_status='minted', twin_token_id=:t, twin_tx=:tx WHERE id=:i"),
        {"t": token_id, "tx": tx, "i": yacht_id},
    )
    db.execute(
        text("INSERT INTO chain_txs (kind,ref,tx_hash,contract,detail) VALUES ('twin_mint',:r,:tx,:c,CAST(:d AS JSONB))"),
        dict(r=yacht_id, tx=tx, c=get_settings().yacht_twin_address, d=json.dumps({"token_id": token_id, "registry_ref": reg_ref.hex()})),
    )
    record_event(db, yacht_id, "TWIN_MINT", document_hash=reg_ref.hex())
    audit(db, who, "mint", "yacht_twin", yacht_id, {"token_id": token_id, "tx": tx})
    db.commit()
    return {"id": yacht_id, "twin_status": "minted", "token_id": token_id, "tx_hash": tx, "on_chain": tx is not None}


class ComplianceIn(BaseModel):
    allowed_countries: list[int] = Field(default_factory=list, description="ISO 3166-1 numeric codes")
    professional_max_bps: int = Field(default=2500, ge=1, le=10000)
    retail_max_bps: int = Field(default=200, ge=0, le=10000)
    lockup_until: datetime | None = None


@router.get("/yachts/{yacht_id}/compliance")
def get_compliance(yacht_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    r = rows(db, "SELECT * FROM compliance_config WHERE yacht_id=:i", i=yacht_id)
    return r[0] if r else {"yacht_id": yacht_id, "allowed_countries": [], "professional_max_bps": 2500, "retail_max_bps": 200, "lockup_until": None}


@router.put("/yachts/{yacht_id}/compliance")
def set_compliance(yacht_id: str, body: ComplianceIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    if body.retail_max_bps > body.professional_max_bps:
        raise HTTPException(422, "Retail cap cannot exceed the professional cap")
    if not db.execute(text("SELECT 1 FROM yachts WHERE id=:i"), {"i": yacht_id}).first():
        raise HTTPException(404, "Yacht not found")
    db.execute(
        text("""INSERT INTO compliance_config (yacht_id,allowed_countries,professional_max_bps,retail_max_bps,lockup_until)
                VALUES (:y,:c,:p,:r,:l) ON CONFLICT (yacht_id) DO UPDATE SET allowed_countries=EXCLUDED.allowed_countries,
                professional_max_bps=EXCLUDED.professional_max_bps, retail_max_bps=EXCLUDED.retail_max_bps,
                lockup_until=EXCLUDED.lockup_until"""),
        dict(y=yacht_id, c=sorted(set(body.allowed_countries)), p=body.professional_max_bps, r=body.retail_max_bps, l=body.lockup_until),
    )
    audit(db, who, "update", "compliance", yacht_id, body.model_dump())
    db.commit()
    return get_compliance(yacht_id, db, who)


class MintUnitsIn(BaseModel):
    investor_id: str
    units: int = Field(gt=0)


@router.post("/yachts/{yacht_id}/mint-units")
def mint_units(yacht_id: str, body: MintUnitsIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    y = db.execute(
        text("SELECT twin_status, units_total, units_minted, units_contract FROM yachts WHERE id=:i"), {"i": yacht_id}
    ).first()
    if y is None:
        raise HTTPException(404, "Yacht not found")
    if y.twin_status != "minted":
        raise HTTPException(409, "Mint the yacht twin before issuing units")
    if y.units_minted + body.units > y.units_total:
        raise HTTPException(409, f"Only {y.units_total - y.units_minted:,} units left to issue")
    inv = db.execute(text("SELECT * FROM investors WHERE id=:i AND deleted_at IS NULL"), {"i": body.investor_id}).first()
    if inv is None:
        raise HTTPException(404, "Investor not found")
    cfg = db.execute(text("SELECT * FROM compliance_config WHERE yacht_id=:i"), {"i": yacht_id}).first()
    bal = db.execute(text("SELECT coalesce(units,0) FROM holdings WHERE investor_id=:i AND yacht_id=:y"),
                     {"i": inv.id, "y": yacht_id}).scalar() or 0
    checks = policy.transfer_checks(
        policy.InvestorView(inv.kyc_status, inv.screening, inv.country_code, inv.professional, inv.kyc_expires),
        body.units, bal, max(y.units_total, 1), list(cfg.allowed_countries) if cfg else [],
        cfg.professional_max_bps if cfg else 2500, cfg.retail_max_bps if cfg else 200, None,
    )
    failed = [c for c in checks if not c.ok]
    if failed:
        raise HTTPException(422, "Blocked by compliance: " + "; ".join(f"{c.rule} ({c.detail})" for c in failed))
    db.execute(
        text("""INSERT INTO holdings (investor_id,yacht_id,units) VALUES (:i,:y,:u)
                ON CONFLICT (investor_id,yacht_id) DO UPDATE SET units = holdings.units + EXCLUDED.units"""),
        {"i": inv.id, "y": yacht_id, "u": body.units},
    )
    db.execute(text("UPDATE yachts SET units_minted = units_minted + :u WHERE id=:y"), {"u": body.units, "y": yacht_id})
    db.execute(
        text("INSERT INTO chain_txs (kind,ref,tx_hash,contract,detail) VALUES ('units_mint',:r,NULL,:c,CAST(:d AS JSONB))"),
        dict(r=yacht_id, c=y.units_contract, d=json.dumps({"investor": inv.id, "units": body.units, "wallet": inv.wallet})),
    )
    record_event(db, yacht_id, "UNITS_MINT", document_hash=proof.sha256(f"{inv.id}|{body.units}".encode()).hex())
    audit(db, who, "mint", "yacht_units", yacht_id, {"investor": inv.id, "units": body.units})
    db.commit()
    return {"yacht_id": yacht_id, "investor_id": inv.id, "units": body.units,
            "units_minted": y.units_minted + body.units, "chain": "queued for the SPV's YachtUnits contract" if y.units_contract else "ledger only (no units contract set)"}


# ---------------------------------------------------------------- marinas, berths, bookings, investors


class MarinaIn(BaseModel):
    id: str = Field(pattern=r"^MARINA-[A-Z]{3}-\d{3}$")
    name: str
    region: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    arrival_radius_m: int = Field(default=600, ge=50, le=5000)


class MarinaPatch(BaseModel):
    name: str | None = None
    region: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    arrival_radius_m: int | None = Field(default=None, ge=50, le=5000)


@router.post("/marinas", status_code=201)
def add_marina(b: MarinaIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    try:
        db.execute(text("INSERT INTO marinas (id,name,region,location,arrival_radius_m) VALUES (:i,:n,:r,ST_MakePoint(:lon,:lat)::geography,:rad)"),
                   dict(i=b.id, n=b.name, r=b.region, lat=b.lat, lon=b.lon, rad=b.arrival_radius_m))
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Marina {b.id} already exists")
    audit(db, who, "create", "marina", b.id, b.model_dump())
    db.commit()
    return {"id": b.id}


@router.patch("/marinas/{marina_id}")
def update_marina(marina_id: str, b: MarinaPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    ch = b.model_dump(exclude_unset=True)
    cur = db.execute(text("SELECT ST_Y(location::geometry) lat, ST_X(location::geometry) lon FROM marinas WHERE id=:i"), {"i": marina_id}).first()
    if cur is None:
        raise HTTPException(404, "Marina not found")
    lat, lon = ch.pop("lat", cur.lat), ch.pop("lon", cur.lon)
    sets = ", ".join([f"{k}=:{k}" for k in ch] + ["location=ST_MakePoint(:lon,:lat)::geography"])
    db.execute(text(f"UPDATE marinas SET {sets} WHERE id=:id"), {**ch, "lat": lat, "lon": lon, "id": marina_id})
    audit(db, who, "update", "marina", marina_id, {**ch, "lat": lat, "lon": lon})
    db.commit()
    return {"id": marina_id}


@router.delete("/marinas/{marina_id}", status_code=204)
def delete_marina(marina_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    if db.execute(text("SELECT 1 FROM yachts WHERE home_marina_id=:i UNION SELECT 1 FROM bookings WHERE marina_id=:i"), {"i": marina_id}).first():
        raise HTTPException(409, "Yachts or bookings still reference this marina")
    db.execute(text("DELETE FROM berths WHERE marina_id=:i"), {"i": marina_id})
    if not db.execute(text("DELETE FROM marinas WHERE id=:i"), {"i": marina_id}).rowcount:
        raise HTTPException(404, "Marina not found")
    audit(db, who, "delete", "marina", marina_id)
    db.commit()


class BerthIn(BaseModel):
    marina_id: str
    code: str = Field(min_length=1, max_length=20)
    max_loa_m: float = Field(gt=2)
    max_beam_m: float = Field(gt=1)
    rate_usd_day: float = Field(ge=0)
    services: str = ""


class BerthPatch(BaseModel):
    max_loa_m: float | None = Field(default=None, gt=2)
    max_beam_m: float | None = Field(default=None, gt=1)
    rate_usd_day: float | None = Field(default=None, ge=0)
    services: str | None = None
    status: Literal["available", "reserved", "occupied", "maintenance"] | None = None


@router.post("/berths", status_code=201)
def add_berth(b: BerthIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    try:
        bid = db.execute(text("""INSERT INTO berths (marina_id,code,max_loa_m,max_beam_m,rate_usd_day,services)
                                 VALUES (:m,:c,:l,:b,:r,:s) RETURNING id"""),
                         dict(m=b.marina_id, c=b.code, l=b.max_loa_m, b=b.max_beam_m, r=b.rate_usd_day, s=b.services)).scalar_one()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Berth {b.code} already exists at {b.marina_id}, or the marina does not exist")
    audit(db, who, "create", "berth", bid, b.model_dump())
    db.commit()
    return {"id": bid}


@router.patch("/berths/{berth_id}")
def update_berth(berth_id: int, b: BerthPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    ch = b.model_dump(exclude_unset=True)
    if not ch:
        raise HTTPException(422, "Nothing to update")
    sets = ", ".join(f"{k}=:{k}" for k in ch)
    if not db.execute(text(f"UPDATE berths SET {sets} WHERE id=:id"), {**ch, "id": berth_id}).rowcount:
        raise HTTPException(404, "Berth not found")
    audit(db, who, "update", "berth", berth_id, ch)
    db.commit()
    return {"id": berth_id, **ch}


@router.delete("/berths/{berth_id}", status_code=204)
def delete_berth(berth_id: int, db: Session = Depends(get_db), who=Depends(require_admin)):
    if db.execute(text("SELECT 1 FROM bookings WHERE berth_id=:i"), {"i": berth_id}).first():
        raise HTTPException(409, "This berth has bookings. Set it to maintenance instead.")
    if not db.execute(text("DELETE FROM berths WHERE id=:i"), {"i": berth_id}).rowcount:
        raise HTTPException(404, "Berth not found")
    audit(db, who, "delete", "berth", berth_id)
    db.commit()


@router.post("/bookings/{ref}/cancel")
def cancel_booking(ref: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    b = db.execute(text("SELECT status, kind FROM bookings WHERE ref=:r"), {"r": ref}).first()
    if b is None:
        raise HTTPException(404, "Booking not found")
    if b.status not in ("escrowed",):
        raise HTTPException(409, f"Booking is {b.status}; only bookings still in escrow can be cancelled")
    db.execute(text("UPDATE bookings SET status='refunded' WHERE ref=:r"), {"r": ref})
    db.execute(text("DELETE FROM credit_spend WHERE booking_ref=:r"), {"r": ref})
    audit(db, who, "update", "booking", ref, {"status": "refunded"})
    db.commit()
    return {"ref": ref, "status": "refunded"}


class InvestorIn(BaseModel):
    id: str = Field(pattern=r"^INV-\d{4,8}$")
    name: str
    kind: Literal["individual", "entity"]
    country_code: int = Field(ge=0, le=999)
    professional: bool = False
    wallet: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{40}$")


class InvestorPatch(BaseModel):
    name: str | None = None
    country_code: int | None = Field(default=None, ge=0, le=999)
    professional: bool | None = None
    wallet: str | None = Field(default=None, pattern=r"^0x[0-9a-fA-F]{40}$")


@router.post("/investors", status_code=201)
def add_investor(b: InvestorIn, db: Session = Depends(get_db), who=Depends(require_admin)):
    try:
        db.execute(text("INSERT INTO investors (id,name,kind,country_code,professional,wallet) VALUES (:id,:name,:kind,:country_code,:professional,:wallet)"),
                   b.model_dump())
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Investor {b.id} already exists")
    audit(db, who, "create", "investor", b.id, b.model_dump())
    db.commit()
    return {"id": b.id}


@router.patch("/investors/{investor_id}")
def update_investor(investor_id: str, b: InvestorPatch, db: Session = Depends(get_db), who=Depends(require_admin)):
    ch = b.model_dump(exclude_unset=True)
    if not ch:
        raise HTTPException(422, "Nothing to update")
    sets = ", ".join(f"{k}=:{k}" for k in ch)
    if not db.execute(text(f"UPDATE investors SET {sets} WHERE id=:id AND deleted_at IS NULL"), {**ch, "id": investor_id}).rowcount:
        raise HTTPException(404, "Investor not found")
    audit(db, who, "update", "investor", investor_id, ch)
    db.commit()
    return {"id": investor_id, **ch}


@router.delete("/investors/{investor_id}", status_code=204)
def delete_investor(investor_id: str, db: Session = Depends(get_db), who=Depends(require_admin)):
    if db.execute(text("SELECT 1 FROM holdings WHERE investor_id=:i AND units>0"), {"i": investor_id}).first():
        raise HTTPException(409, "This investor still holds units. Transfer or redeem them first.")
    if not db.execute(text("UPDATE investors SET deleted_at=now() WHERE id=:i AND deleted_at IS NULL"), {"i": investor_id}).rowcount:
        raise HTTPException(404, "Investor not found")
    audit(db, who, "delete", "investor", investor_id, {"soft": True})
    db.commit()


# ---------------------------------------------------------------- hashes & addresses


@router.get("/hashes")
def hashes(db: Session = Depends(get_db), who=Depends(require_admin)):
    s = get_settings()
    return {
        "contracts": {
            "ProofRegistry": s.proof_registry_address,
            "YachtTwin": s.yacht_twin_address,
            "ArrivalEscrow": s.arrival_escrow_address,
            "IdentityRegistry": s.identity_registry_address,
            "chain_rpc": s.chain_rpc,
        },
        "anchors": rows(db, "SELECT id, root, leaf_count, from_ts, to_ts, chain_tx, chain_index, created_at FROM anchors ORDER BY id DESC LIMIT 50"),
        "chain_txs": rows(db, "SELECT * FROM chain_txs ORDER BY id DESC LIMIT 100"),
        "events": rows(db, """SELECT id, yacht_id, event_type, observed_at, leaf, anchor_id, leaf_index
                               FROM events ORDER BY id DESC LIMIT 100"""),
        "wallets": rows(db, """SELECT 'investor' AS kind, id, name, wallet AS address FROM investors WHERE wallet IS NOT NULL
                                UNION ALL SELECT 'user', CAST(id AS text), email, wallet_address FROM users WHERE wallet_address IS NOT NULL"""),
        "twins": rows(db, "SELECT id, name, twin_status, twin_token_id, twin_tx, docs_root FROM yachts ORDER BY id"),
    }
