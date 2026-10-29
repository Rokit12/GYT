"""Versioned schema migrations, run as their own step: `python -m app.migrate`.

Each file in api/sql/ is applied once, in name order, inside a transaction, and recorded in
schema_migrations with its SHA-256. A Postgres advisory lock makes concurrent runs safe (two API
replicas starting at once). Editing a file that has already been applied is reported, because the
change would never reach existing databases; add a new numbered file instead.

    python -m app.migrate            # apply pending migrations
    python -m app.migrate status     # list applied / pending, exit 1 if anything is pending
"""
from __future__ import annotations

import hashlib
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text

from . import db as dbmod

log = logging.getLogger("gyt.migrate")
SQL_DIR = Path(__file__).resolve().parent.parent / "sql"
LOCK_KEY = 0x47595401  # "GYT" + 1


@dataclass
class Migration:
    version: str
    path: Path
    checksum: str


class MigrationError(RuntimeError):
    pass


def discover(sql_dir: Path | None = None) -> list[Migration]:
    d = sql_dir or SQL_DIR
    return [Migration(p.stem, p, hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(d.glob("*.sql"))]


def _ensure_table(conn) -> None:
    conn.exec_driver_sql("""CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER NOT NULL DEFAULT 0)""")


def applied(conn) -> dict[str, str]:
    _ensure_table(conn)
    return {r.version: r.checksum for r in conn.execute(text("SELECT version, checksum FROM schema_migrations"))}


def status(sql_dir: Path | None = None) -> dict:
    with dbmod.engine.begin() as conn:
        done = applied(conn)
    files = discover(sql_dir)
    return {
        "applied": [m.version for m in files if m.version in done],
        "pending": [m.version for m in files if m.version not in done],
        "changed": [m.version for m in files if m.version in done and done[m.version] != m.checksum],
        "unknown": sorted(set(done) - {m.version for m in files}),
    }


def upgrade(sql_dir: Path | None = None, strict: bool = False) -> list[str]:
    """Apply every pending migration. Returns the versions applied."""
    ran: list[str] = []
    with dbmod.engine.connect() as conn:
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
        conn.commit()  # the lock is held by the session, across the per-file transactions below
        try:
            with conn.begin():
                done = applied(conn)
            for m in discover(sql_dir):
                if m.version in done:
                    if done[m.version] != m.checksum:
                        msg = f"{m.path.name} changed after it was applied; add a new migration file instead"
                        if strict:
                            raise MigrationError(msg)
                        log.warning(msg)
                    continue
                t0 = time.monotonic()
                with conn.begin():
                    conn.exec_driver_sql(m.path.read_text())
                    conn.execute(text("INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES (:v,:c,:d)"),
                                 {"v": m.version, "c": m.checksum, "d": int((time.monotonic() - t0) * 1000)})
                log.info("applied %s", m.version)
                ran.append(m.version)
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
            conn.commit()
    return ran


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    dbmod.wait_for_db()
    host = dbmod.db_host(dbmod.get_settings().database_url) or "database"
    if argv[:1] == ["status"]:
        st = status()
        for v in st["applied"]:
            print(f"  applied  {v}{'  (file changed since)' if v in st['changed'] else ''}")
        for v in st["pending"]:
            print(f"  pending  {v}")
        print(f"{host}: {len(st['applied'])} applied, {len(st['pending'])} pending")
        return 1 if st["pending"] else 0
    ran = upgrade(strict="--strict" in argv)
    print(f"{host}: applied {len(ran)} migration(s){': ' + ', '.join(ran) if ran else ' (already up to date)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
