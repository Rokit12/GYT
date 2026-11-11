"""Production start-up step: bring the database schema up to date and make sure the primary admin exists.

    python -m app.bootstrap            # migrations + primary admin (from ADMIN_EMAIL / ADMIN_PASSWORD)

Safe to run on every deploy: migrations that already ran are skipped, and an existing admin is left alone
(its password is never overwritten). Sample data is separate: python -m app.seed.
"""
from __future__ import annotations

import sys

from .auth import ensure_admin
from .config import get_settings
from .db import SessionLocal, wait_for_db
from .migrate import upgrade


def main() -> int:
    s = get_settings()
    if len(s.jwt_secret or "") < 32:
        print("JWT_SECRET must be at least 32 characters", file=sys.stderr)
        return 1
    wait_for_db()
    applied = upgrade()
    print(f"database: {len(applied)} migration(s) applied" if applied else "database: schema is current")
    if s.admin_email and s.admin_password:
        with SessionLocal() as db:
            ensure_admin(db, s.admin_email, s.admin_password)
            db.commit()
        print(f"primary admin: {s.admin_email}")
    else:
        print("ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin created", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
