"""Yacht photos uploaded by owners (and admins).

Upload is a plain POST of the image bytes (Content-Type image/jpeg|png|webp), no multipart needed.
The browser resizes before upload, so files are small. We check the real file type from its first
bytes, not the declared header, store it under MEDIA_DIR/photos, and record a PHOTO_ADDED event
whose document hash is the file's SHA-256.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .auth import User, current_user, require_user
from .config import get_settings
from .db import get_db
from .events import record_event

router = APIRouter()
MAX_BYTES = 8 * 1024 * 1024
MAX_PER_YACHT = 12
EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def sniff(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def photo_dir() -> Path:
    d = Path(get_settings().media_dir) / "photos"
    d.mkdir(parents=True, exist_ok=True)
    return d


def can_manage(db: Session, user: User | None, yacht_id: str) -> bool:
    if user is None:
        return False
    if user.role == "admin":
        return True
    return db.execute(text("SELECT 1 FROM yachts WHERE id=:y AND owner_user_id=:u"), {"y": yacht_id, "u": user.id}).first() is not None


def _require_manage(db: Session, user: User, yacht_id: str):
    if not db.execute(text("SELECT 1 FROM yachts WHERE id=:y"), {"y": yacht_id}).first():
        raise HTTPException(404, "Yacht not found")
    if not can_manage(db, user, yacht_id):
        raise HTTPException(403, "Only this yacht's owner or an admin can manage its photos")


def _row(r) -> dict:
    return {"id": r["id"], "url": f"/photos/{r['id']}", "caption": r["caption"], "is_cover": r["is_cover"], "sha256": r["sha256"],
            "bytes": r["bytes"], "content_type": r["content_type"], "created_at": r["created_at"], "status": r["status"]}


@router.get("/yachts/{yacht_id}/photos")
def list_photos(yacht_id: str, db: Session = Depends(get_db), user: User | None = Depends(current_user)):
    manage = can_manage(db, user, yacht_id)
    rows = db.execute(text(f"""SELECT * FROM yacht_photos WHERE yacht_id=:y {'' if manage else "AND status='published'"}
                              ORDER BY is_cover DESC, id"""), {"y": yacht_id}).mappings()
    return {"can_manage": manage, "photos": [_row(r) for r in rows]}


@router.post("/yachts/{yacht_id}/photos", status_code=201)
async def upload_photo(yacht_id: str, request: Request, caption: str = Query("", max_length=140),
                       db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_manage(db, user, yacht_id)
    data = await request.body()
    if not data:
        raise HTTPException(422, "Send the image file as the request body")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Photos can be up to 8 MB")
    ctype = sniff(data)
    if ctype is None:
        raise HTTPException(415, "Use a JPEG, PNG or WebP image")
    n = db.execute(text("SELECT count(*) FROM yacht_photos WHERE yacht_id=:y"), {"y": yacht_id}).scalar()
    if n >= MAX_PER_YACHT:
        raise HTTPException(409, f"A yacht can have up to {MAX_PER_YACHT} photos. Delete one first.")
    digest = hashlib.sha256(data).hexdigest()
    if db.execute(text("SELECT 1 FROM yacht_photos WHERE yacht_id=:y AND sha256=:h"), {"y": yacht_id, "h": digest}).first():
        raise HTTPException(409, "This photo is already on the yacht")
    name = f"{yacht_id}-{digest[:20]}.{EXT[ctype]}"
    (photo_dir() / name).write_bytes(data)
    r = db.execute(text("""INSERT INTO yacht_photos (yacht_id,user_id,stored_name,content_type,bytes,sha256,caption,is_cover)
                           VALUES (:y,:u,:n,:c,:b,:h,:cap,:cover) RETURNING *"""),
                   {"y": yacht_id, "u": user.id, "n": name, "c": ctype, "b": len(data), "h": digest,
                    "cap": caption.strip(), "cover": n == 0}).mappings().first()
    record_event(db, yacht_id, "PHOTO_ADDED", document_hash=digest, payload={"photo_id": r["id"], "bytes": len(data)})
    db.commit()
    return _row(r)


class PhotoPatch(BaseModel):
    caption: str | None = Field(default=None, max_length=140)
    is_cover: bool | None = None
    status: str | None = Field(default=None, pattern="^(published|hidden)$")


@router.patch("/yachts/{yacht_id}/photos/{photo_id}")
def update_photo(yacht_id: str, photo_id: int, body: PhotoPatch, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_manage(db, user, yacht_id)
    if not db.execute(text("SELECT 1 FROM yacht_photos WHERE id=:p AND yacht_id=:y"), {"p": photo_id, "y": yacht_id}).first():
        raise HTTPException(404, "Photo not found")
    if body.is_cover:
        db.execute(text("UPDATE yacht_photos SET is_cover = (id = :p) WHERE yacht_id=:y"), {"p": photo_id, "y": yacht_id})
    if body.caption is not None:
        db.execute(text("UPDATE yacht_photos SET caption=:c WHERE id=:p"), {"c": body.caption.strip(), "p": photo_id})
    if body.status:
        db.execute(text("UPDATE yacht_photos SET status=:s WHERE id=:p"), {"s": body.status, "p": photo_id})
    db.commit()
    return _row(db.execute(text("SELECT * FROM yacht_photos WHERE id=:p"), {"p": photo_id}).mappings().first())


@router.delete("/yachts/{yacht_id}/photos/{photo_id}", status_code=204)
def delete_photo(yacht_id: str, photo_id: int, db: Session = Depends(get_db), user: User = Depends(require_user)):
    _require_manage(db, user, yacht_id)
    r = db.execute(text("DELETE FROM yacht_photos WHERE id=:p AND yacht_id=:y RETURNING stored_name, is_cover"),
                   {"p": photo_id, "y": yacht_id}).first()
    if r is None:
        raise HTTPException(404, "Photo not found")
    if r.is_cover:  # promote the next photo
        db.execute(text("""UPDATE yacht_photos SET is_cover=TRUE WHERE id =
                           (SELECT id FROM yacht_photos WHERE yacht_id=:y ORDER BY id LIMIT 1)"""), {"y": yacht_id})
    db.commit()
    (photo_dir() / r.stored_name).unlink(missing_ok=True)  # the PHOTO_ADDED record stays: history is append-only


@router.get("/photos/{photo_id}")
def photo_file(photo_id: int, db: Session = Depends(get_db), user: User | None = Depends(current_user)):
    r = db.execute(text("SELECT yacht_id, stored_name, content_type, status FROM yacht_photos WHERE id=:p"), {"p": photo_id}).first()
    if r is None or (r.status != "published" and not can_manage(db, user, r.yacht_id)):
        raise HTTPException(404, "Photo not found")
    f = photo_dir() / r.stored_name
    if not f.exists():
        raise HTTPException(404, "Photo file missing")
    return FileResponse(f, media_type=r.content_type, headers={"Cache-Control": "public, max-age=86400"})
