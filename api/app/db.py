"""Database connection.

The API is a client of the database, nothing more: point DATABASE_URL at any PostgreSQL 15+ with PostGIS
(a managed, always-on host such as Supabase Pro, or Neon with scale-to-zero turned off, or the local
docker service) and run `python -m app.migrate` to bring the schema up to date.

Hosted databases add a few things this module handles:
  * URLs as providers print them (postgres://..., postgresql://...) are accepted as-is.
  * TLS: keep `?sslmode=require` in the URL; it is passed straight to the driver.
  * Poolers in transaction mode (Supabase port 6543, PgBouncer) cannot use prepared statements,
    so they are switched off when DB_POOLER=transaction or the URL uses port 6543.
  * Idle connections get dropped by hosts and load balancers: pool_pre_ping + pool_recycle.
  * A database that is waking up or briefly unreachable: wait_for_db() retries with backoff.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

log = logging.getLogger("gyt.db")


def normalize_url(url: str) -> str:
    """Accept postgres:// and postgresql:// URLs from hosting dashboards; use the psycopg 3 driver."""
    url = url.strip()
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def uses_transaction_pooler(url: str, pooler_setting: str = "") -> bool:
    if pooler_setting:
        return pooler_setting.lower() == "transaction"
    try:
        return urlsplit(url).port == 6543
    except ValueError:
        return False


def db_host(url: str) -> str:
    try:
        return urlsplit(normalize_url(url)).hostname or ""
    except ValueError:
        return ""


def make_engine(url: str | None = None) -> Engine:
    s = get_settings()
    url = normalize_url(url or s.database_url)
    connect_args: dict = {"connect_timeout": s.db_connect_timeout, "application_name": "gyt-api",
                          "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10, "keepalives_count": 3}
    if uses_transaction_pooler(url, s.db_pooler):
        connect_args["prepare_threshold"] = None  # PgBouncer/Supavisor transaction mode
    return create_engine(url, future=True, pool_pre_ping=True, pool_recycle=s.db_pool_recycle,
                         pool_size=s.db_pool_size, max_overflow=s.db_max_overflow, connect_args=connect_args)


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def wait_for_db(timeout: float | None = None) -> None:
    """Block until the database answers, retrying with backoff (hosts can take a moment to wake)."""
    timeout = get_settings().db_wait_seconds if timeout is None else timeout
    deadline, delay, last = time.monotonic() + timeout, 0.5, None
    while True:
        try:
            with engine.connect() as c:
                c.execute(text("SELECT 1"))
            return
        except Exception as e:  # noqa: BLE001 - any connection error is retried
            last = e
            if time.monotonic() + delay > deadline:
                raise RuntimeError(f"Database at {db_host(get_settings().database_url) or 'DATABASE_URL'} is not reachable: {last}") from last
            log.warning("database not ready (%s); retrying in %.1fs", str(e).splitlines()[0][:120], delay)
            time.sleep(delay)
            delay = min(delay * 2, 8)


def init_db() -> None:
    """Bring the schema up to date (used by tests, the seed script and AUTO_MIGRATE)."""
    from .migrate import upgrade
    upgrade()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def scalar(db: Session, sql: str, **params):
    return db.execute(text(sql), params).scalar()
