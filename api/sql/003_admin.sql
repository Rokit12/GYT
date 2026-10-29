-- Admin console: account approval, banking details, minting state, chain transactions, audit log.

ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_status_ck CHECK (status IN ('pending','active','suspended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE yachts ADD COLUMN IF NOT EXISTS twin_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE yachts ADD COLUMN IF NOT EXISTS twin_tx TEXT;
ALTER TABLE yachts ADD COLUMN IF NOT EXISTS units_minted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yachts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE yachts ADD CONSTRAINT yachts_twin_status_ck CHECK (twin_status IN ('pending','verified','minted','retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE investors ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Payout / settlement accounts. The account number is encrypted (NaCl SecretBox, key from
-- BANK_DATA_KEY); only the last four digits are stored in clear for display.
CREATE TABLE IF NOT EXISTS bank_accounts (
    id             SERIAL PRIMARY KEY,
    owner_type     TEXT NOT NULL CHECK (owner_type IN ('user','marina','investor','yacht_spv','platform')),
    owner_id       TEXT NOT NULL,
    account_name   TEXT NOT NULL,
    bank_name      TEXT NOT NULL,
    country        TEXT NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'USD',
    swift_bic      TEXT,
    number_enc     TEXT NOT NULL,
    last4          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending_verification'
                   CHECK (status IN ('pending_verification','verified','disabled')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_accounts_owner_idx ON bank_accounts (owner_type, owner_id);

-- Every on-chain write the platform makes, for the hash explorer.
CREATE TABLE IF NOT EXISTS chain_txs (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,          -- anchor | twin_mint | units_mint | escrow_release
    ref         TEXT NOT NULL,          -- yacht id, booking ref, anchor id
    tx_hash     TEXT,                   -- null when recorded off-chain only
    contract    TEXT,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    actor      TEXT NOT NULL,           -- admin email or 'service'
    action     TEXT NOT NULL,           -- create | update | delete | approve | mint | ...
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
