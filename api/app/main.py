import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .chain import ChainClient
from .config import get_settings
from .db import SessionLocal, init_db
from .events import anchor_pending
from . import live
from .admin import router as admin_router
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
    init_db()
    s = get_settings()
    tasks = []
    if s.anchor_interval_seconds > 0:
        tasks.append(asyncio.create_task(anchor_loop(s.anchor_interval_seconds)))
    if s.aisstream_api_key:
        tasks.append(asyncio.create_task(live.run(SessionLocal)))
    if s.digitraffic_enabled:
        tasks.append(asyncio.create_task(_digitraffic()))
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
app.include_router(admin_router)
app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True, "chain": ChainClient().enabled}
