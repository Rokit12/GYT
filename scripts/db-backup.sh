#!/usr/bin/env bash
# Back up the database at DATABASE_URL to backups/gyt-YYYYmmdd-HHMM.dump (custom format, compressed).
# Uses the postgres:16 image, so nothing needs installing locally. Works with any host, including
# Supabase and Neon. Paid hosts also keep their own automatic backups; this is your independent copy.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)}"
URL="${URL/postgresql+psycopg:\/\//postgresql://}"
mkdir -p backups
OUT="backups/gyt-$(date +%Y%m%d-%H%M).dump"
docker run --rm -v "$PWD/backups:/backups" postgres:16 pg_dump --format=custom --no-owner --no-privileges -d "$URL" -f "/$OUT"
echo "Backup written to $OUT"
