#!/usr/bin/env bash
# Restore a backup made by db-backup.sh into the database at DATABASE_URL (e.g. moving hosts).
#   scripts/db-restore.sh backups/gyt-20261029-0900.dump
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?usage: scripts/db-restore.sh backups/<file>.dump}"
URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)}"
URL="${URL/postgresql+psycopg:\/\//postgresql://}"
read -r -p "Restore $FILE into ${URL##*@}? Existing GYT tables there will be replaced. Type yes: " ok
[ "$ok" = "yes" ] || { echo "Cancelled."; exit 1; }
docker run --rm -v "$PWD/$(dirname "$FILE"):/in" postgres:16 sh -c \
  "psql -d '$URL' -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS btree_gist;' && \
   pg_restore --clean --if-exists --no-owner --no-privileges -d '$URL' /in/$(basename "$FILE")"
echo "Restored. Run: python -m app.migrate status"
