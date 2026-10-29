-- Accounts for the web app. Passwords are stored as scrypt hashes, never in plain text.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         CITEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
    investor_id   TEXT REFERENCES investors(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
