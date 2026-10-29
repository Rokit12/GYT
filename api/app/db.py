from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

engine = create_engine(get_settings().database_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

SQL_DIR = Path(__file__).resolve().parent.parent / "sql"


def init_db() -> None:
    """Apply SQL migrations in order. Every statement is idempotent (IF NOT EXISTS)."""
    with engine.begin() as conn:
        for f in sorted(SQL_DIR.glob("*.sql")):
            conn.exec_driver_sql(f.read_text())


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def scalar(db: Session, sql: str, **params):
    return db.execute(text(sql), params).scalar()
