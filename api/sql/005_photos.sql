-- Owner-uploaded yacht photos. Files live on disk (MEDIA_DIR); each file's SHA-256 is also
-- recorded as a PHOTO_ADDED event, so the photo's existence and date are anchored like any record.
ALTER TABLE yachts ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS yacht_photos (
    id           SERIAL PRIMARY KEY,
    yacht_id     TEXT NOT NULL REFERENCES yachts(id),
    user_id      INTEGER REFERENCES users(id),
    stored_name  TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    caption      TEXT NOT NULL DEFAULT '',
    is_cover     BOOLEAN NOT NULL DEFAULT FALSE,
    status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (yacht_id, sha256)
);
CREATE INDEX IF NOT EXISTS yacht_photos_yacht_idx ON yacht_photos (yacht_id, is_cover DESC, id);
