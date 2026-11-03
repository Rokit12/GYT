import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .chain import ChainClient
from .config import get_settings
from .db import SessionLocal, engine, wait_for_db
from .migrate import status as migration_status, upgrade as migrate_upgrade
from .events import anchor_pending
from . import live
from .account import router as account_router
from .admin import router as admin_router
from .admins import router as admins_router
from .photos import router as photos_router
from .devices import router as devices_router
from .berths import router as berths_router
from .berthplan import router as berthplan_router
from .registration import router as registration_router
from .autopilot import router as autopilot_router
from .auth import router as auth_router
from .routes import router

log = logging.getLogger("gyt")


async def anchor_loop(interval: int):
    chain = ChainClient()
    while True:
        await asyncio.sleep(interval)
        try:
            with SessionLocal() as db:
                res = await asyncio.to_thread(anchor_pending, db, chain)
                if res:
                    log.info("anchored %s events root=%s chain_tx=%s", res["leaf_count"], res["root"], res["chain_tx"])
        except Exception:  # keep the loop alive; the next tick retries the same events
            log.exception("anchor loop failed")


async def autopilot_loop(interval: int):
    from . import autopilot

    while True:
        await asyncio.sleep(interval)
        try:
            with SessionLocal() as db:
                res = await asyncio.to_thread(autopilot.run, db)
                log.info("autopilot: %s", res)
        except Exception:  # never let one bad run stop the loop
            log.exception("autopilot run failed")


async def _digitraffic():
    # Our fleet's MMSIs, so fleet yachts seen on Digitraffic are stored as AIS positions too.
    try:
        with SessionLocal() as db:
            _, fleet = await asyncio.to_thread(live.load_targets, db)
        live.live.fleet.update(fleet)
    except Exception:
        log.exception("could not load fleet MMSIs for Digitraffic")
    await live.run_digitraffic(SessionLocal)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    # The database lives on its own (local container or an always-on host). Wait for it, then make
    # sure its schema is current: apply migrations only when AUTO_MIGRATE is set, otherwise refuse
    # to run against an out-of-date schema.
    await asyncio.to_thread(wait_for_db)
    if s.auto_migrate:
        await asyncio.to_thread(migrate_upgrade)
    else:
        pending = (await asyncio.to_thread(migration_status))["pending"]
        if pending:
            raise RuntimeError(f"Database schema is behind ({', '.join(pending)} pending). Run: python -m app.migrate")
    tasks = []
    if s.anchor_interval_seconds > 0:
        tasks.append(asyncio.create_task(anchor_loop(s.anchor_interval_seconds)))
    if s.aisstream_api_key:
        tasks.append(asyncio.create_task(live.run(SessionLocal)))
    if s.digitraffic_enabled:
        tasks.append(asyncio.create_task(_digitraffic()))
    if s.autopilot_interval_seconds > 0:
        tasks.append(asyncio.create_task(autopilot_loop(s.autopilot_interval_seconds)))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="GYT API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(account_router)
app.include_router(photos_router)
app.include_router(devices_router)
app.include_router(berths_router)
app.include_router(berthplan_router)
app.include_router(registration_router)
app.include_router(autopilot_router)
app.include_router(admins_router)
app.include_router(admin_router)
app.include_router(router)


@app.get("/health")
def health():
    """Liveness plus database reachability and schema state, for uptime monitors."""
    from sqlalchemy import text as _t
    try:
        with engine.connect() as c:
            c.execute(_t("SELECT 1"))
        st = migration_status()
        db = {"ok": True, "pending_migrations": st["pending"], "applied": len(st["applied"])}
    except Exception as e:  # noqa: BLE001
        db = {"ok": False, "error": str(e).splitlines()[0][:200]}
    return {"ok": db["ok"], "database": db, "chain": ChainClient().enabled}
