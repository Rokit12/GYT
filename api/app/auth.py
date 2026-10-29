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


def require_admin(user: User | None = Depends(current_user), x_admin_token: str = Header(default="")) -> User | None:
    service = get_settings().admin_token
    if service and x_admin_token and hmac.compare_digest(x_admin_token, service):
        return None  # trusted service caller
    if user is None:
        raise HTTPException(401, "Sign in as an administrator")
    if user.role != "admin" or user.status != "active":
        raise HTTPException(403, "Administrator access required")
    return user


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


class SignInIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


def _session(u: User) -> dict:
    return {"token": issue_token(u), "user": u.__dict__}


@router.post("/signup", status_code=201)
def signup(body: SignUpIn, db: Session = Depends(get_db)):
    probs = password_problems(body.password)
    if probs:
        raise HTTPException(422, "Password needs " + ", ".join(probs))
    try:
        from .account import INTERESTS, follow_yachts
        uid = db.execute(
            text("""INSERT INTO users (email,name,password_hash,role,status,phone,country,interests)
                    VALUES (:e,:n,:h,'client','pending',:p,:c,:i) RETURNING id"""),
            {"e": body.email.lower(), "n": body.name.strip(), "h": hash_password(body.password),
             "p": (body.phone or "").strip() or None, "c": body.country.upper() if body.country else None,
             "i": sorted(set(body.interests) & INTERESTS)},
        ).scalar_one()
        if body.follow:
            follow_yachts(db, uid, body.follow)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    return _session(User(uid, body.email.lower(), body.name.strip(), "client", None, "pending"))


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
    r = db.execute(text("SELECT id,email,name,role,investor_id,status FROM users WHERE id=:i"), {"i": user.id}).first()
    if r is None:
        raise HTTPException(401, "Account no longer exists")
    fresh = User(r.id, r.email, r.name, r.role, r.investor_id, r.status)
    return {**fresh.__dict__, "token": issue_token(fresh)}


def ensure_admin(db: Session, email: str, password: str, name: str = "GYT Admin") -> None:
    """Create the first admin if it does not exist. The password is hashed before storage."""
    exists = db.execute(text("SELECT 1 FROM users WHERE email=:e"), {"e": email.lower()}).first()
    if not exists:
        db.execute(
            text("INSERT INTO users (email,name,password_hash,role,status) VALUES (:e,:n,:h,'admin','active')"),
            {"e": email.lower(), "n": name, "h": hash_password(password)},
        )


def new_secret() -> str:
    return secrets.token_urlsafe(48)
