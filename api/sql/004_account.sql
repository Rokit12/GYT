-- Client accounts: profile, interests, notification preferences, followed yachts, valuation history.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;              -- ISO 3166-1 alpha-2
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify JSONB NOT NULL
    DEFAULT '{"arrivals": true, "ais_gaps": true, "documents": true, "bookings": true, "payouts": true, "weekly": false}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS follows (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    yacht_id   TEXT NOT NULL REFERENCES yachts(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, yacht_id)
);

-- Independent valuations. The indicative unit price is the latest valuation divided by units_total.
CREATE TABLE IF NOT EXISTS valuations (
    id        SERIAL PRIMARY KEY,
    yacht_id  TEXT NOT NULL REFERENCES yachts(id),
    valued_at DATE NOT NULL,
    value_usd NUMERIC(16,2) NOT NULL CHECK (value_usd > 0),
    source    TEXT NOT NULL DEFAULT 'Independent surveyor',
    UNIQUE (yacht_id, valued_at)
);
