"""Accounts, sessions and access control.

Passwords: scrypt (stdlib) with a per-user salt. Sessions: short-lived HS256 JWTs. Admin routes
accept either a signed-in admin user (Bearer token) or the service token (X-Admin-Token) used by
simulators, schedulers and CI. Leave ADMIN_TOKEN empty to disable the service token entirely.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import get_settings
from .vessel import VesselClaim
from .db import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------------------------------------------------------- passwords

_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


def password_problems(pw: str) -> list[str]:
    out = []
    if len(pw) < 8:
        out.append("at least 8 characters")
    if not any(c.isdigit() for c in pw):
        out.append("a number")
    if not any(c.isalpha() for c in pw):
        out.append("a letter")
    return out


# ---------------------------------------------------------------- tokens


@dataclass
class User:
    id: int
    email: str
    name: str
    role: str
    investor_id: str | None
    status: str = "active"


def _secret() -> str:
    s = get_settings().jwt_secret
    if not s:
        raise HTTPException(500, "JWT_SECRET is not configured")
    return s


def issue_token(u: User) -> str:
    now = int(time.time())
    claims = {"sub": str(u.id), "email": u.email, "name": u.name, "role": u.role, "inv": u.investor_id, "st": u.status,
              "iat": now, "exp": now + get_settings().jwt_ttl_minutes * 60}
    return jwt.encode(claims, _secret(), algorithm="HS256")


def _decode(token: str) -> User:
    try:
        c = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Your session has expired. Sign in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid session. Sign in again.")
    return User(int(c["sub"]), c["email"], c["name"], c["role"], c.get("inv"), c.get("st", "active"))


def current_user(authorization: str = Header(default="")) -> User | None:
    if authorization.lower().startswith("bearer "):
        return _decode(authorization[7:].strip())
    return None


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(401, "Sign in to continue")
    return user


def require_active(user: User = Depends(require_user)) -> User:
    if user.status != "active":
        raise HTTPException(403, "Your account is waiting for approval. You can browse, but bookings open once an admin approves it.")
    return user


# Admin rights. The primary admin has all of them; each secondary admin has the ones the primary chose.
RIGHTS: dict[str, str] = {
    "autopilot": "Autopilot (AI)",
    "monitoring": "Yacht monitoring and tracking",
    "registry": "Yachts, minting and hashes",
    "users": "Users and approvals",
    "investors": "Investors and KYC",
    "banking": "Banking details",
    "berths": "Berths, berth plans and marinas",
    "bookings": "Bookings and escrow",
    "audit": "Audit log",
    "docs": "Internal documentation",
}


@dataclass
class AdminAccess:
    user: User | None          # None = the trusted service caller (ADMIN_TOKEN)
    is_primary: bool
    rights: frozenset

    def has(self, right: str) -> bool:
        return self.is_primary or right in self.rights


def admin_access(user: User | None, x_admin_token: str, db) -> AdminAccess:
    """Who is calling, checked fresh against the database so a changed right applies at once."""
    service = get_settings().admin_token
    if service and x_admin_token and hmac.compare_digest(x_admin_token, service):
        return AdminAccess(None, True, frozenset(RIGHTS))  # trusted service caller
    if user is None:
        raise HTTPException(401, "Sign in as an administrator")
    r = db.execute(text("SELECT role, status, is_primary, admin_rights FROM users WHERE id=:i"), {"i": user.id}).first()
    if r is None or r.role != "admin" or r.status != "active":
        raise HTTPException(403, "Administrator access required")
    return AdminAccess(user, bool(r.is_primary), frozenset(r.admin_rights or []))


def require_admin(user: User | None = Depends(current_user), x_admin_token: str = Header(default=""), db: Session = Depends(get_db)) -> User | None:
    """Any active admin, whatever their rights."""
    return admin_access(user, x_admin_token, db).user


def require_right(*needed: str):
    """An admin holding every one of these rights (the primary admin holds them all)."""
    for n in needed:
        assert n in RIGHTS, n

    def dep(user: User | None = Depends(current_user), x_admin_token: str = Header(default=""), db: Session = Depends(get_db)) -> User | None:
        a = admin_access(user, x_admin_token, db)
        missing = [n for n in needed if not a.has(n)]
        if missing:
            raise HTTPException(403, f"You don't have the {' and '.join(RIGHTS[m] for m in missing)} right. Ask the primary admin to add it.")
        return a.user
    return dep


def require_primary(user: User | None = Depends(current_user), x_admin_token: str = Header(default=""), db: Session = Depends(get_db)) -> User | None:
    a = admin_access(user, x_admin_token, db)
    if not a.is_primary:
        raise HTTPException(403, "Only the primary admin can do this")
    return a.user


# ---------------------------------------------------------------- rate limiting

_attempts: dict[str, deque] = defaultdict(deque)
WINDOW_S, MAX_FAILS = 15 * 60, 5


def _limited(key: str) -> bool:
    q = _attempts[key]
    now = time.time()
    while q and now - q[0] > WINDOW_S:
        q.popleft()
    return len(q) >= MAX_FAILS


def _fail(key: str) -> None:
    _attempts[key].append(time.time())


# ---------------------------------------------------------------- routes


class SignUpIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    # Optional, from the sign-up wizard
    phone: str | None = Field(default=None, max_length=32)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    interests: list[str] = Field(default_factory=list, max_length=5)
    follow: list[str] = Field(default_factory=list, max_length=20)
    # How they are joining (required unless REGISTRATION_MODE=open): see registration.py
    join_as: str | None = Field(default=None, pattern="^(owner|invite)$")
    vessel: VesselClaim | None = None
    invite_code: str | None = Field(default=None, max_length=20)


class SignInIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


def _session(u: User) -> dict:
    return {"token": issue_token(u), "user": u.__dict__}


@router.post("/signup", status_code=201)
def signup(body: SignUpIn, db: Session = Depends(get_db)):
    from .registration import after_signup, check_claim_format, use_invite

    probs = password_problems(body.password)
    if probs:
        raise HTTPException(422, "Password needs " + ", ".join(probs))
    mode = get_settings().registration_mode
    join_as, invite = body.join_as, None
    if mode != "open" and join_as is None:
        raise HTTPException(422, "GYT accounts are for yacht owners and people they invite. "
                                 "Add your yacht's details, or enter the invite code you were given.")
    if join_as == "owner":
        if body.vessel is None:
            raise HTTPException(422, "Tell us about your yacht: name, flag, length, MMSI or IMO, and registry number")
        check_claim_format(body.vessel)
    elif join_as == "invite":
        if not body.invite_code:
            raise HTTPException(422, "Enter your invite code")
        invite = use_invite(db, body.invite_code, body.email)
    status = "active" if invite else "pending"
    try:
        from .account import INTERESTS, follow_yachts
        uid = db.execute(
            text("""INSERT INTO users (email,name,password_hash,role,status,phone,country,interests,joined_via)
                    VALUES (:e,:n,:h,'client',:st,:p,:c,:i,:j) RETURNING id"""),
            {"e": body.email.lower(), "n": body.name.strip(), "h": hash_password(body.password), "st": status,
             "p": (body.phone or "").strip() or None, "c": body.country.upper() if body.country else None,
             "i": sorted(set(body.interests) & INTERESTS), "j": join_as or "open"},
        ).scalar_one()
        if body.follow:
            follow_yachts(db, uid, body.follow)
        after_signup(db, uid, body.email, join_as or "open", body.vessel, invite)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    return _session(User(uid, body.email.lower(), body.name.strip(), "client", None, status))


@router.post("/login")
def login(body: SignInIn, request: Request, db: Session = Depends(get_db)):
    key = f"{body.email.lower()}|{request.client.host if request.client else '-'}"
    if _limited(key):
        raise HTTPException(429, "Too many failed attempts. Wait 15 minutes and try again.")
    r = db.execute(
        text("SELECT id,email,name,role,investor_id,status,password_hash FROM users WHERE email=:e"), {"e": body.email.lower()}
    ).first()
    if r is None or not verify_password(body.password, r.password_hash):
        _fail(key)
        raise HTTPException(401, "Email or password is incorrect")
    if r.status == "suspended":
        raise HTTPException(403, "This account is suspended. Contact support.")
    _attempts.pop(key, None)
    db.execute(text("UPDATE users SET last_login_at=now() WHERE id=:i"), {"i": r.id})
    db.commit()
    return _session(User(r.id, r.email, r.name, r.role, r.investor_id, r.status))


@router.get("/me")
def me(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Fresh from the database, so approvals take effect without signing out."""
    r = db.execute(text("SELECT id,email,name,role,investor_id,status,is_primary,admin_rights FROM users WHERE id=:i"), {"i": user.id}).first()
    if r is None:
        raise HTTPException(401, "Account no longer exists")
    fresh = User(r.id, r.email, r.name, r.role, r.investor_id, r.status)
    admin = r.role == "admin" and r.status == "active"
    return {**fresh.__dict__, "token": issue_token(fresh), "is_primary": bool(r.is_primary) and admin,
            "rights": (list(RIGHTS) if r.is_primary else [x for x in (r.admin_rights or []) if x in RIGHTS]) if admin else []}


def ensure_admin(db: Session, email: str, password: str, name: str = "GYT Admin") -> None:
    """Create the first admin if it does not exist. The password is hashed before storage."""
    exists = db.execute(text("SELECT 1 FROM users WHERE email=:e"), {"e": email.lower()}).first()
    if not exists:
        # the first admin is the primary admin: every right, and it can never be deleted or demoted
        db.execute(
            text("""INSERT INTO users (email,name,password_hash,role,status,is_primary)
                    VALUES (:e,:n,:h,'admin','active', NOT EXISTS (SELECT 1 FROM users WHERE is_primary))"""),
            {"e": email.lower(), "n": name, "h": hash_password(password)},
        )


def new_secret() -> str:
    return secrets.token_urlsafe(48)

