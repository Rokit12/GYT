"""Berth plans: import a marina's berth plan image and turn it into berths and a 3D layout.

  * The admin's browser finds the berths on the image (or the optional AI reads it) and the admin
    checks them. Nothing reaches the database until the admin saves.
  * Saving adds berths that are new and updates the size and plan position of berths with the same
    code. It never deletes a berth, so bookings and holds are never orphaned.
  * The plan image and berth positions are public (a marina's layout is not secret): the berth finder
    and the board draw the 3D marina from them.
"""
from __future__ import annotations

import hashlib
import math
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import ai
from .admin import audit
from .auth import User, require_right
from .db import get_db
from .photos import sniff

router = APIRouter(tags=["berth plans"])
MAX_BYTES = 8 * 1024 * 1024
CODE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,19}$")


def _marina(db: Session, marina_id: str):
    if not db.execute(text("SELECT 1 FROM marinas WHERE id=:m"), {"m": marina_id}).first():
        raise HTTPException(404, "Marina not found")


def _image(data: bytes) -> str:
    if not data:
        raise HTTPException(422, "Send the plan image as the request body")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Plan images can be up to 8 MB")
    mime = sniff(data)
    if mime is None:
        raise HTTPException(415, "Use a PNG, JPEG or WebP image of the plan")
    return mime


@router.get("/marinas/{marina_id}/plan")
def get_plan(marina_id: str, db: Session = Depends(get_db)):
    """The marina's plan (size and whether it has an image) and every berth's position on it."""
    _marina(db, marina_id)
    p = db.execute(text("SELECT width_m, height_m, sha256, data IS NOT NULL AS has_image, updated_at FROM marina_plans WHERE marina_id=:m"),
                   {"m": marina_id}).mappings().first()
    berths = db.execute(text("""SELECT code, plan_x_m, plan_z_m, plan_rot FROM berths
                                WHERE marina_id=:m AND plan_x_m IS NOT NULL ORDER BY code"""), {"m": marina_id}).mappings().all()
    if p is None:
        return {"marina_id": marina_id, "plan": None, "berths": []}
    return {
        "marina_id": marina_id,
        "plan": {"width_m": float(p["width_m"]), "height_m": float(p["height_m"]), "updated_at": p["updated_at"],
                 "image": f"/marinas/{marina_id}/plan/image?v={p['sha256'][:12]}" if p["has_image"] else None},
        "berths": [{"code": b["code"], "x": float(b["plan_x_m"]), "z": float(b["plan_z_m"]), "rot": float(b["plan_rot"] or 0)} for b in berths],
    }


@router.get("/marinas/{marina_id}/plan/image")
def plan_image(marina_id: str, db: Session = Depends(get_db)):
    r = db.execute(text("SELECT mime, data FROM marina_plans WHERE marina_id=:m AND data IS NOT NULL"), {"m": marina_id}).first()
    if r is None:
        raise HTTPException(404, "This marina has no plan image")
    return Response(bytes(r.data), media_type=r.mime, headers={"Cache-Control": "public, max-age=86400"})


@router.put("/admin/marinas/{marina_id}/plan/image")
async def put_plan_image(marina_id: str, request: Request, db: Session = Depends(get_db), who: User | None = Depends(require_right("berths"))):
    """Store the plan image. Its real size is set when the berths are saved (PUT /admin/marinas/{id}/plan)."""
    _marina(db, marina_id)
    data = await request.body()
    mime = _image(data)
    digest = hashlib.sha256(data).hexdigest()
    db.execute(text("""INSERT INTO marina_plans (marina_id, mime, data, sha256, width_m, height_m, updated_by)
                       VALUES (:m, :t, :d, :h, 1, 1, :u)
                       ON CONFLICT (marina_id) DO UPDATE SET mime=:t, data=:d, sha256=:h, updated_at=now(), updated_by=:u"""),
               {"m": marina_id, "t": mime, "d": data, "h": digest, "u": who.id if who else None})
    audit(db, who, "upload", "berth_plan", marina_id, {"sha256": digest, "bytes": len(data), "mime": mime})
    db.commit()
    return {"marina_id": marina_id, "sha256": digest}


class PlanBerth(BaseModel):
    code: str
    max_loa_m: float = Field(gt=2, le=200)
    max_beam_m: float = Field(gt=1, le=60)
    max_draft_m: float | None = Field(default=None, gt=0, le=40)
    rate_usd_day: float = Field(default=0, ge=0, le=1_000_000)
    x: float = Field(ge=-5000, le=5000)
    z: float = Field(ge=-5000, le=5000)
    rot: float = Field(ge=-7, le=7)

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        v = v.strip().upper()
        if not CODE.match(v):
            raise ValueError("Berth codes are 1 to 20 letters, digits, dots or dashes")
        return v


class PlanIn(BaseModel):
    width_m: float = Field(gt=5, le=5000)
    height_m: float = Field(gt=5, le=5000)
    berths: list[PlanBerth] = Field(min_length=1, max_length=600)


@router.put("/admin/marinas/{marina_id}/plan")
def save_plan(marina_id: str, b: PlanIn, db: Session = Depends(get_db), who: User | None = Depends(require_right("berths"))):
    """Save the plan's size and its berths: new codes are added, existing codes updated. Nothing is deleted."""
    _marina(db, marina_id)
    codes = [x.code for x in b.berths]
    if len(set(codes)) != len(codes):
        dup = sorted({c for c in codes if codes.count(c) > 1})
        raise HTTPException(422, f"Each berth needs its own code; repeated: {', '.join(dup)}")
    db.execute(text("""INSERT INTO marina_plans (marina_id, width_m, height_m, updated_by) VALUES (:m, :w, :h, :u)
                       ON CONFLICT (marina_id) DO UPDATE SET width_m=:w, height_m=:h, updated_at=now(), updated_by=:u"""),
               {"m": marina_id, "w": b.width_m, "h": b.height_m, "u": who.id if who else None})
    existing = {r.code: r.id for r in db.execute(text("SELECT id, code FROM berths WHERE marina_id=:m FOR UPDATE"), {"m": marina_id})}
    created, updated = [], []
    for x in b.berths:
        vals = dict(m=marina_id, c=x.code, l=round(x.max_loa_m, 2), b=round(x.max_beam_m, 2), d=x.max_draft_m,
                    r=x.rate_usd_day, px=round(x.x, 2), pz=round(x.z, 2), pr=round(math.remainder(x.rot, 2 * math.pi), 4))
        if x.code in existing:
            # the plan sets size and position; the rate and services stay as the marina set them
            db.execute(text("""UPDATE berths SET max_loa_m=:l, max_beam_m=:b, max_draft_m=COALESCE(:d, max_draft_m),
                                   plan_x_m=:px, plan_z_m=:pz, plan_rot=:pr WHERE id=:id"""), {**vals, "id": existing[x.code]})
            updated.append(x.code)
        else:
            db.execute(text("""INSERT INTO berths (marina_id, code, max_loa_m, max_beam_m, max_draft_m, rate_usd_day, services,
                                                   plan_x_m, plan_z_m, plan_rot)
                               VALUES (:m, :c, :l, :b, :d, :r, '', :px, :pz, :pr)"""), vals)
            created.append(x.code)
    off_plan = sorted(set(existing) - set(codes))
    audit(db, who, "import", "berth_plan", marina_id,
          {"width_m": b.width_m, "height_m": b.height_m, "created": created, "updated": updated, "off_plan": off_plan})
    db.commit()
    msg = f"Saved {len(codes)} berths: {len(created)} new, {len(updated)} updated."
    if off_plan:
        msg += f" Not on this plan and left as they were: {', '.join(off_plan[:12])}{'…' if len(off_plan) > 12 else ''}."
    return {"marina_id": marina_id, "created": created, "updated": updated, "off_plan": off_plan, "message": msg}


@router.post("/admin/marinas/{marina_id}/plan/read")
async def read_plan(marina_id: str, request: Request, db: Session = Depends(get_db), who: User | None = Depends(require_right("berths"))):
    """Ask the AI to read a plan image: berth codes, positions and any printed sizes. Advisory only."""
    _marina(db, marina_id)
    data = await request.body()
    mime = _image(data)
    return ai.read_berth_plan(data, mime)
