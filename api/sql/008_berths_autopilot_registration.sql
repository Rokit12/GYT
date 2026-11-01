-- Berth finding with live holds, size fit including draft, the autopilot log, and owner-only sign-up.

-- Size fit: depth at the berth and the yacht's draft (both optional; checked when known).
ALTER TABLE berths ADD COLUMN IF NOT EXISTS max_draft_m NUMERIC(4,2);
ALTER TABLE yachts ADD COLUMN IF NOT EXISTS draft_m NUMERIC(4,2);

-- A hold is a short reservation while a yacht's owner confirms and pays. While it is active, every
-- other yacht sees the berth as taken for those dates. The database itself refuses two active
-- holds on the same berth for overlapping dates; holds are expired by the API and the autopilot.
CREATE TABLE IF NOT EXISTS berth_holds (
    id          BIGSERIAL PRIMARY KEY,
    berth_id    INTEGER NOT NULL REFERENCES berths(id),
    yacht_id    TEXT NOT NULL REFERENCES yachts(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    arrive      DATE NOT NULL,
    depart      DATE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','booked','released','expired')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    booking_ref TEXT REFERENCES bookings(ref),
    CHECK (depart > arrive),
    EXCLUDE USING GIST (berth_id WITH =, daterange(arrive, depart) WITH &&) WHERE (status = 'active')
);
CREATE INDEX IF NOT EXISTS berth_holds_active_idx ON berth_holds (berth_id) WHERE status = 'active';

-- Every automated check or action, so admins can see what the autopilot did and why.
CREATE TABLE IF NOT EXISTS autopilot_log (
    id        BIGSERIAL PRIMARY KEY,
    at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    job       TEXT NOT NULL,                 -- holds | berth_fit | arrivals | registrations | brief
    subject   TEXT NOT NULL DEFAULT '',      -- booking ref, user id, berth code...
    outcome   TEXT NOT NULL,                 -- done | flagged | recommend_approve | needs_review | info
    summary   TEXT NOT NULL,
    detail    JSONB NOT NULL DEFAULT '{}'::jsonb,
    used_ai   BOOLEAN NOT NULL DEFAULT FALSE,
    resolved  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS autopilot_log_at_idx ON autopilot_log (at DESC);

-- Sign-up is for yacht owners (with proof) and people an owner or admin invites.
CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,                -- GYT-XXXX-XXXX
    created_by  INTEGER NOT NULL REFERENCES users(id),
    yacht_id    TEXT REFERENCES yachts(id),      -- crew/captain invites are for one yacht
    role        TEXT NOT NULL CHECK (role IN ('crew','captain','investor','marina','client')),
    email       CITEXT,                          -- optional: only this email may use it
    note        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_by     INTEGER REFERENCES users(id),
    used_at     TIMESTAMPTZ
);

-- What an owner told us about their yacht at sign-up, and the registry document they gave.
CREATE TABLE IF NOT EXISTS owner_claims (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id),
    vessel_name     TEXT NOT NULL,
    flag            TEXT NOT NULL,
    mmsi            TEXT,
    imo             TEXT,
    loa_m           NUMERIC(6,2) NOT NULL,
    registry_number TEXT NOT NULL DEFAULT '',
    doc_sha256      TEXT,
    doc_mime        TEXT,
    doc_bytes       BYTEA,
    screening       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- latest autopilot result
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_via TEXT NOT NULL DEFAULT 'open';  -- owner | invite | open | admin
