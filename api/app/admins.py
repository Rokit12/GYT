"""Admins and their rights.

  * The PRIMARY admin (the first admin, from ADMIN_EMAIL) holds every right. The database refuses to
    delete, suspend or demote it, and there is only ever one.
  * Only the primary admin adds secondary admins and chooses each one's rights. A new admin can be an
    existing account (promoted) or a new one, created with a one-time temporary password.
  * Every admin endpoint checks its right against the database on each request, so a changed right
    takes effect at once, without signing out.
"""
from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from .admin import audit
from .auth import RIGHTS, User, admin_access, current_user, hash_password, require_admin, require_primary
from .db import get_db

router = APIRouter(prefix="/admin", tags=["admins"])


def _rights(v: list[str]) -> list[str]:
    bad = [r for r in v if r not in RIGHTS]
    if bad:
        raise ValueError(f"Unknown right: {', '.join(bad)}")
    return sorted(set(v), key=list(RIGHTS).index)


@router.get("/rights")
def rights(db: Session = Depends(get_db), user: User | None = Depends(current_user), _=Depends(require_admin)):
    """Every right an admin can hold, and the caller's own (the service token counts as primary)."""
    me = admin_access(user, "", db) if user else None
    primary = me.is_primary if me else True
    return {"rights": [{"key": k, "label": v} for k, v in RIGHTS.items()],
            "me": {"is_primary": primary, "rights": list(RIGHTS) if primary else [k for k in RIGHTS if k in me.rights]}}


ADMIN_COLS = "id, email, name, status, is_primary, admin_rights, created_at, last_login_at"


def _row(r) -> dict:
    d = dict(r)
    d["rights"] = list(RIGHTS) if d["is_primary"] else [x for x in (d.pop("admin_rights") or []) if x in RIGHTS]
    d.pop("admin_rights", None)
    return d


@router.get("/admins")
def list_admins(db: Session = Depends(get_db), who=Depends(require_primary)):
    rows = db.execute(text(f"SELECT {ADMIN_COLS} FROM users WHERE role='admin' ORDER BY is_primary DESC, id")).mappings().all()
    return [_row(r) for r in rows]


class AdminIn(BaseModel):
    email: EmailStr
    name: str | None = Field(default=None, min_length=2, max_length=80)
    rights: list[str] = Field(default_factory=list)
    _v = field_validator("rights")(classmethod(lambda cls, v: _rights(v)))


@router.post("/admins", status_code=201)
def add_admin(b: AdminIn, db: Session = Depends(get_db), who=Depends(require_primary)):
    """Make an existing account a secondary admin, or create one with a temporary password shown once."""
    email = str(b.email).lower()
    cur = db.execute(text("SELECT id, role, is_primary FROM users WHERE email=:e"), {"e": email}).mappings().first()
    temp = None
    if cur:
        if cur["role"] == "admin":
            raise HTTPException(409, f"{email} is already an admin. Change their rights instead.")
        db.execute(text("UPDATE users SET role='admin', status='active', admin_rights=CAST(:r AS text[]) WHERE id=:i"),
                   {"r": b.rights, "i": cur["id"]})
        uid = cur["id"]
    else:
        if not b.name:
            raise HTTPException(422, "Give the new admin's full name")
        temp = secrets.token_urlsafe(9)
        uid = db.execute(text("""INSERT INTO users (email, name, password_hash, role, status, admin_rights)
                                 VALUES (:e, :n, :h, 'admin', 'active', CAST(:r AS text[])) RETURNING id"""),
                         {"e": email, "n": b.name, "h": hash_password(temp), "r": b.rights}).scalar_one()
    audit(db, who, "create", "admin", uid, {"email": email, "rights": b.rights, "new_account": temp is not None})
    db.commit()
    out = _row(db.execute(text(f"SELECT {ADMIN_COLS} FROM users WHERE id=:i"), {"i": uid}).mappings().first())
    if temp:
        out["temporary_password"] = temp   # shown once; never stored in plain text
    return out


class AdminPatch(BaseModel):
    rights: list[str] | None = None
    status: str | None = Field(default=None, pattern="^(active|suspended)$")
    _v = field_validator("rights")(classmethod(lambda cls, v: _rights(v) if v is not None else v))


def _secondary(db, admin_id: int):
    cur = db.execute(text("SELECT id, role, is_primary, email FROM users WHERE id=:i"), {"i": admin_id}).mappings().first()
    if cur is None or cur["role"] != "admin":
        raise HTTPException(404, "Admin not found")
    if cur["is_primary"]:
        raise HTTPException(409, "The primary admin keeps every right and cannot be suspended, demoted or deleted")
    return cur


@router.patch("/admins/{admin_id}")
def update_admin(admin_id: int, b: AdminPatch, db: Session = Depends(get_db), who=Depends(require_primary)):
    cur = _secondary(db, admin_id)
    ch = b.model_dump(exclude_unset=True)
    if not ch:
        raise HTTPException(422, "Nothing to update")
    if "rights" in ch:
        db.execute(text("UPDATE users SET admin_rights=CAST(:r AS text[]) WHERE id=:i"), {"r": ch["rights"], "i": admin_id})
    if "status" in ch:
        db.execute(text("UPDATE users SET status=:s WHERE id=:i"), {"s": ch["status"], "i": admin_id})
    audit(db, who, "update", "admin", admin_id, {"email": cur["email"], **ch})
    db.commit()
    return _row(db.execute(text(f"SELECT {ADMIN_COLS} FROM users WHERE id=:i"), {"i": admin_id}).mappings().first())


@router.delete("/admins/{admin_id}", status_code=204)
def remove_admin(admin_id: int, db: Session = Depends(get_db), who=Depends(require_primary)):
    """Take away admin access. The person keeps an ordinary account (delete it from Users if needed)."""
    cur = _secondary(db, admin_id)
    db.execute(text("UPDATE users SET role='client', admin_rights=NULL WHERE id=:i"), {"i": admin_id})
    audit(db, who, "remove", "admin", admin_id, {"email": cur["email"]})
    db.commit()
