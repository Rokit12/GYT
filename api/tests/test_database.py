"""Database independence: provider URLs, pooler handling, versioned migrations, reset guard, health."""
import shutil

import pytest

from tests.conftest import DB


def test_provider_urls_are_normalised():
    from app.db import db_host, normalize_url, uses_transaction_pooler

    assert normalize_url("postgres://u:p@db.abc.supabase.co:5432/postgres?sslmode=require") == \
        "postgresql+psycopg://u:p@db.abc.supabase.co:5432/postgres?sslmode=require"
    assert normalize_url("postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require").startswith("postgresql+psycopg://")
    assert normalize_url("postgresql+psycopg://u@h/d") == "postgresql+psycopg://u@h/d"
    assert uses_transaction_pooler("postgresql://u@aws-0-eu.pooler.supabase.com:6543/postgres")
    assert not uses_transaction_pooler("postgresql://u@aws-0-eu.pooler.supabase.com:5432/postgres")
    assert uses_transaction_pooler("postgresql://u@pgbouncer:5432/d", "transaction")
    assert db_host("postgres://u:p@ep-x.neon.tech/neondb") == "ep-x.neon.tech"


def test_reset_refuses_remote_databases(monkeypatch):
    from app import seed
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "database_url", "postgresql://u:p@db.abc.supabase.co:5432/postgres")
    monkeypatch.setattr(seed.sys, "argv", ["seed", "--reset"])
    monkeypatch.delenv("GYT_ALLOW_RESET", raising=False)
    called = []
    monkeypatch.setattr(seed, "reset", lambda: called.append(1))
    with pytest.raises(SystemExit, match="Refusing to --reset"):
        seed.main()
    assert not called


@pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
def test_migrations_are_versioned_and_applied_once(client, tmp_path):
    from app import migrate

    st = migrate.status()
    assert st["pending"] == [] and len(st["applied"]) >= 6 and st["changed"] == []
    # a copy of the real migrations plus one new file: only the new one runs, exactly once
    d = tmp_path / "sql"
    shutil.copytree(migrate.SQL_DIR, d)
    (d / "900_test_extra.sql").write_text("CREATE TABLE IF NOT EXISTS _migration_probe (n INTEGER);")
    assert migrate.upgrade(d) == ["900_test_extra"]
    assert migrate.upgrade(d) == []
    assert "900_test_extra" in migrate.status(d)["applied"]
    # editing an applied file is reported (and rejected in strict mode)
    (d / "900_test_extra.sql").write_text("SELECT 1;")
    assert migrate.status(d)["changed"] == ["900_test_extra"]
    with pytest.raises(migrate.MigrationError, match="changed after it was applied"):
        migrate.upgrade(d, strict=True)


@pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
def test_health_reports_database(client):
    h = client.get("/health").json()
    assert h["ok"] and h["database"]["ok"] and h["database"]["pending_migrations"] == []
