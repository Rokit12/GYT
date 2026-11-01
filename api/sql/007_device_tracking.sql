-- Software tracking: a signed-in owner or crew member shares a phone's or laptop's location
-- for a yacht, with no tracking hardware installed. These fixes are stored as source 'device'.

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_source_check;
ALTER TABLE positions ADD CONSTRAINT positions_source_check CHECK (source IN ('ais','gps','sar','device'));

-- Accuracy reported by the device (metres, the radius the device is fairly sure of) and which sharing session sent the fix.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS accuracy_m REAL;

-- One row per "share location" session: who shared, from what, and when it ran.
CREATE TABLE IF NOT EXISTS device_sessions (
    id            UUID PRIMARY KEY,
    yacht_id      TEXT NOT NULL REFERENCES yachts(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    label         TEXT NOT NULL DEFAULT '',             -- "Captain's iPhone"
    user_agent    TEXT NOT NULL DEFAULT '',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ,
    fixes         INTEGER NOT NULL DEFAULT 0,
    rejected      INTEGER NOT NULL DEFAULT 0
);
-- Crew: people the owner allows to share location for the yacht (a captain, a skipper).
CREATE TABLE IF NOT EXISTS yacht_crew (
    yacht_id   TEXT NOT NULL REFERENCES yachts(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    role       TEXT NOT NULL DEFAULT 'crew',
    added_by   INTEGER REFERENCES users(id),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (yacht_id, user_id)
);

CREATE INDEX IF NOT EXISTS device_sessions_yacht_idx ON device_sessions (yacht_id, started_at DESC);
CREATE INDEX IF NOT EXISTS positions_device_idx ON positions (yacht_id, observed_at DESC) WHERE source = 'device';
