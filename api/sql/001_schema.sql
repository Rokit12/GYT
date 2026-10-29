-- GYT core schema. PostgreSQL 16 + PostGIS 3.4.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS marinas (
    id          TEXT PRIMARY KEY,                       -- MARINA-DXB-001
    name        TEXT NOT NULL,
    region      TEXT NOT NULL,
    location    GEOGRAPHY(POINT, 4326) NOT NULL,
    arrival_radius_m INTEGER NOT NULL DEFAULT 600       -- how close counts as "arrived"
);
CREATE INDEX IF NOT EXISTS marinas_location_gix ON marinas USING GIST (location);

CREATE TABLE IF NOT EXISTS berths (
    id            SERIAL PRIMARY KEY,
    marina_id     TEXT NOT NULL REFERENCES marinas(id),
    code          TEXT NOT NULL,
    max_loa_m     NUMERIC(6,2) NOT NULL,
    max_beam_m    NUMERIC(5,2) NOT NULL,
    rate_usd_day  NUMERIC(12,2) NOT NULL,
    services      TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','occupied','maintenance')),
    UNIQUE (marina_id, code)
);

CREATE TABLE IF NOT EXISTS yachts (
    id                  TEXT PRIMARY KEY,               -- YACHT-000001
    name                TEXT NOT NULL,
    mmsi                TEXT,
    imo                 TEXT,
    flag                TEXT NOT NULL,
    registry_ref        TEXT,                           -- official number at the flag registry
    loa_m               NUMERIC(6,2) NOT NULL,
    beam_m              NUMERIC(5,2) NOT NULL,
    year_built          INTEGER,
    builder             TEXT,
    home_marina_id      TEXT REFERENCES marinas(id),
    berth_code          TEXT,
    valuation_usd       NUMERIC(16,2),
    charter_week_usd    NUMERIC(14,2),
    units_total         INTEGER NOT NULL DEFAULT 0,
    tokenized           BOOLEAN NOT NULL DEFAULT FALSE,
    insurance_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    inspection_status   TEXT NOT NULL DEFAULT 'PENDING',
    docs_root           TEXT,                           -- hex Merkle root of document hashes
    twin_token_id       INTEGER,
    units_contract      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS yachts_mmsi_uq ON yachts (mmsi) WHERE mmsi IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents (
    id          SERIAL PRIMARY KEY,
    yacht_id    TEXT NOT NULL REFERENCES yachts(id),
    kind        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    sha256      TEXT NOT NULL,                          -- hex, computed on the client before upload
    storage_key TEXT,                                   -- encrypted object in S3-compatible storage
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trackers (
    id            TEXT PRIMARY KEY,
    yacht_id      TEXT NOT NULL REFERENCES yachts(id),
    public_key    TEXT NOT NULL,                        -- ed25519, hex
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every position from every source. High volume: never goes on-chain directly.
CREATE TABLE IF NOT EXISTS positions (
    id           BIGSERIAL PRIMARY KEY,
    yacht_id     TEXT NOT NULL REFERENCES yachts(id),
    source       TEXT NOT NULL CHECK (source IN ('ais','gps','sar')),
    observed_at  TIMESTAMPTZ NOT NULL,
    location     GEOGRAPHY(POINT, 4326) NOT NULL,
    sog_kn       REAL,
    cog_deg      REAL,
    est_length_m REAL,                                  -- SAR hull length estimate
    verified     BOOLEAN NOT NULL DEFAULT FALSE,        -- signature checked (gps) or provider-trusted
    raw          JSONB,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS positions_yacht_time_idx ON positions (yacht_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS positions_location_gix ON positions USING GIST (location);

-- Hashable events. Each gets a leaf; batches of leaves are anchored as Merkle roots.
CREATE TABLE IF NOT EXISTS events (
    id            BIGSERIAL PRIMARY KEY,
    yacht_id      TEXT NOT NULL REFERENCES yachts(id),
    event_type    TEXT NOT NULL,
    marina_id     TEXT,
    berth_code    TEXT,
    observed_at   TIMESTAMPTZ NOT NULL,
    lat           DOUBLE PRECISION,
    lon           DOUBLE PRECISION,
    document_hash TEXT NOT NULL DEFAULT '',
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    leaf          TEXT NOT NULL,                        -- hex sha256
    anchor_id     INTEGER,
    leaf_index    INTEGER
);
CREATE INDEX IF NOT EXISTS events_unanchored_idx ON events (id) WHERE anchor_id IS NULL;
CREATE INDEX IF NOT EXISTS events_yacht_idx ON events (yacht_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS anchors (
    id           SERIAL PRIMARY KEY,
    root         TEXT NOT NULL UNIQUE,
    leaf_count   INTEGER NOT NULL,
    from_ts      TIMESTAMPTZ NOT NULL,
    to_ts        TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    chain_tx     TEXT,
    chain_index  INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
    ref          TEXT PRIMARY KEY,                      -- BK-4098 / CS-7199
    kind         TEXT NOT NULL CHECK (kind IN ('berth','credit_stay')),
    yacht_id     TEXT NOT NULL REFERENCES yachts(id),
    marina_id    TEXT NOT NULL REFERENCES marinas(id),
    berth_id     INTEGER REFERENCES berths(id),
    investor_id  TEXT,
    arrive       DATE NOT NULL,
    depart       DATE NOT NULL,
    amount_usd   NUMERIC(14,2) NOT NULL,
    status       TEXT NOT NULL DEFAULT 'escrowed'
                 CHECK (status IN ('escrowed','arrived','released','refunded','cancelled')),
    arrival_event_id BIGINT REFERENCES events(id),
    fusion_digest TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (depart > arrive),
    -- A berth can never be double-booked, enforced by the database itself.
    EXCLUDE USING GIST (berth_id WITH =, daterange(arrive, depart) WITH &&)
        WHERE (berth_id IS NOT NULL AND status <> 'cancelled' AND status <> 'refunded')
);

CREATE TABLE IF NOT EXISTS investors (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('individual','entity')),
    country_code  INTEGER NOT NULL,                     -- ISO 3166-1 numeric
    professional  BOOLEAN NOT NULL DEFAULT FALSE,
    wallet        TEXT,
    kyc_status    TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','approved','rejected')),
    screening     TEXT NOT NULL DEFAULT 'not_run',      -- clear | pep_review | sanctions_hit | not_run
    kyc_expires   DATE
);

CREATE TABLE IF NOT EXISTS holdings (
    investor_id TEXT NOT NULL REFERENCES investors(id),
    yacht_id    TEXT NOT NULL REFERENCES yachts(id),
    units       INTEGER NOT NULL CHECK (units >= 0),
    mode        TEXT NOT NULL DEFAULT 'use' CHECK (mode IN ('use','earn')),
    PRIMARY KEY (investor_id, yacht_id)
);

CREATE TABLE IF NOT EXISTS credit_spend (
    id          SERIAL PRIMARY KEY,
    investor_id TEXT NOT NULL REFERENCES investors(id),
    year        INTEGER NOT NULL,
    amount_usd  NUMERIC(14,2) NOT NULL,
    booking_ref TEXT REFERENCES bookings(ref)
);

CREATE TABLE IF NOT EXISTS compliance_config (
    yacht_id            TEXT PRIMARY KEY REFERENCES yachts(id),
    allowed_countries   INTEGER[] NOT NULL DEFAULT '{}',
    professional_max_bps INTEGER NOT NULL DEFAULT 2500,
    retail_max_bps      INTEGER NOT NULL DEFAULT 200,
    lockup_until        TIMESTAMPTZ
);
