"""Load the sample fleet, marinas, berths and investors. Safe to run more than once.

    python -m app.seed            # seed data
    python -m app.seed --reset    # drop everything first (local only)
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path

from sqlalchemy import text

from .auth import ensure_admin
from .chain import ChainClient
from .config import get_settings
from .db import SessionLocal, engine, init_db
from .events import record_event
from .signing import new_keypair

MARINAS = [
    ("MARINA-DXB-001", "Dubai Harbour", "Gulf", 25.09, 55.14),
    ("MARINA-AUH-002", "Yas Marina, Abu Dhabi", "Gulf", 24.46, 54.60),
    ("MARINA-MCO-001", "Port Hercule, Monaco", "Mediterranean", 43.73, 7.42),
    ("MARINA-ANT-001", "Port Vauban, Antibes", "Mediterranean", 43.58, 7.13),
    ("MARINA-OLB-001", "Porto Cervo, Sardinia", "Mediterranean", 41.13, 9.53),
    ("MARINA-MIA-001", "Miami Beach Marina", "Caribbean & Florida", 25.77, -80.14),
    ("MARINA-ANU-001", "Falmouth Harbour, Antigua", "Caribbean & Florida", 17.01, -61.77),
    ("MARINA-MBA-001", "Mombasa, Kenya", "East Africa", -4.06, 39.67),
    ("MARINA-ZNZ-001", "Zanzibar", "East Africa", -6.16, 39.19),
    ("MARINA-HKT-001", "Phuket, Thailand", "Southeast Asia", 7.82, 98.35),
]
BERTHS = [
    ("MARINA-DXB-001", "B128", 35, 8, 850, "Shore power 125A, fuel, crew lounge"),
    ("MARINA-DXB-001", "A040", 60, 12, 2100, "Shore power 400A, fuel, security"),
    ("MARINA-DXB-001", "C210", 24, 6.5, 520, "Shore power 63A, water"),
    ("MARINA-AUH-002", "Y12", 50, 10, 1600, "Shore power 250A, fuel"),
    ("MARINA-AUH-002", "Y31", 36, 8.2, 900, "Shore power 125A, water"),
    ("MARINA-MCO-001", "Q.1", 70, 13, 4200, "Shore power 400A, black water, concierge"),
    ("MARINA-MCO-001", "Q.9", 40, 8.8, 2600, "Shore power 125A"),
    ("MARINA-ANT-001", "IYCC-14", 90, 16, 5100, "Shore power 400A, heliport access"),
    ("MARINA-ANT-001", "Q7", 34, 7.5, 1150, "Shore power 125A, fuel"),
    ("MARINA-OLB-001", "P3", 30, 7, 980, "Shore power 63A, water"),
    ("MARINA-OLB-001", "P18", 45, 9.5, 1900, "Shore power 250A, fuel"),
    ("MARINA-MIA-001", "D-04", 40, 9, 780, "Shore power 100A, fuel, customs"),
    ("MARINA-MIA-001", "F-11", 60, 11.5, 1300, "Shore power 200A, fuel"),
    ("MARINA-ANU-001", "FH-7", 55, 11, 1050, "Shore power 200A, fuel"),
    ("MARINA-MBA-001", "K-2", 35, 8, 320, "Water, fuel by bowser, 24h guard"),
    ("MARINA-MBA-001", "K-5", 28, 7, 240, "Water, 24h guard"),
    ("MARINA-ZNZ-001", "Z-1", 30, 7.5, 280, "Mooring buoy, tender service"),
    ("MARINA-HKT-001", "C22", 40, 8.5, 420, "Shore power 125A, fuel"),
    ("MARINA-HKT-001", "A05", 55, 10.5, 690, "Shore power 200A, fuel, haul-out"),
]
# id, name, mmsi, flag, loa, beam, year, builder, home, berth, value, units, insured, inspection, charter/wk
YACHTS = [
    ("YACHT-000001", "Azure Meridian", "319001234", "Cayman Islands", 35, 7.9, 2019, "Italian yard", "MARINA-DXB-001", "B128", 12.5e6, 20000, True, "VALID", 85000),
    ("YACHT-000002", "Sea Lantern", "248112093", "Malta", 42, 8.6, 2021, "Dutch yard", "MARINA-MCO-001", "Q.9", 24e6, 40000, True, "VALID", 160000),
    ("YACHT-000003", "Kilindini Star", "634009871", "Kenya", 28, 6.8, 2016, "Turkish yard", "MARINA-MBA-001", "K-5", 4.2e6, 8000, True, "DUE_30D", 38000),
    ("YACHT-000004", "Northwind Reverie", "538007712", "Marshall Islands", 55, 10.2, 2023, "German yard", "MARINA-MIA-001", "F-11", 68e6, 0, True, "VALID", 420000),
    ("YACHT-000005", "Corallo", "247330911", "Italy", 31, 7.1, 2018, "Italian yard", "MARINA-ANT-001", "Q7", 6.8e6, 12000, True, "VALID", 62000),
    ("YACHT-000006", "Andaman Pearl", "567221004", "Thailand", 38, 8.1, 2017, "Taiwan yard", "MARINA-HKT-001", "C22", 9.1e6, 15000, False, "VALID", 70000),
    ("YACHT-000007", "Yas Falcon", "470118320", "UAE", 47, 9.0, 2022, "UAE yard", "MARINA-AUH-002", "Y12", 31e6, 50000, True, "VALID", 190000),
    ("YACHT-000008", "Gallura Blue", "247119087", "Italy", 26, 6.4, 2015, "Italian yard", "MARINA-OLB-001", "P3", 3.1e6, 0, True, "PENDING", 29000),
]
INVESTORS = [
    ("INV-1041", "Halvorsen Family Office", "entity", 578, True, "pending", "clear"),
    ("INV-1042", "A. Odhiambo", "individual", 404, False, "pending", "clear"),
    ("INV-1043", "Meridian Capital FZE", "entity", 784, True, "approved", "clear"),
    ("INV-1044", "L. Moreau", "individual", 250, False, "pending", "pep_review"),
    ("INV-1045", "Blue Ridge Holdings LLC", "entity", 840, True, "approved", "clear"),
    ("INV-1046", "Northline Trading Ltd", "entity", 0, False, "pending", "sanctions_hit"),
]
HOLDINGS = [("INV-1043", "YACHT-000001", 400, "use"), ("INV-1043", "YACHT-000003", 300, "earn"),
            ("INV-1043", "YACHT-000005", 250, "use"), ("INV-1043", "YACHT-000007", 120, "earn"),
            ("INV-1045", "YACHT-000001", 2600, "earn"), ("INV-1045", "YACHT-000002", 6400, "earn"),
            ("INV-1045", "YACHT-000007", 4100, "use"), ("INV-1041", "YACHT-000002", 3800, "use"),
            ("INV-1041", "YACHT-000005", 1500, "earn"), ("INV-1042", "YACHT-000003", 140, "use"),
            ("INV-1042", "YACHT-000001", 90, "earn")]
# Quarterly valuation multipliers, oldest first; the last one equals today's valuation.
VALUATION_PATH = [0.9, 0.92, 0.915, 0.94, 0.955, 0.97, 0.985, 1.0]
ALLOWED = [784, 404, 578, 250, 840, 380, 470, 702]  # UAE, Kenya, Norway, France, US, Italy, Malta, Singapore

KEYS_FILE = Path(__file__).resolve().parent.parent / "tracker_keys.json"


def reset():
    with engine.begin() as c:
        c.exec_driver_sql(
            "DROP TABLE IF EXISTS schema_migrations, yacht_photos, valuations, follows, audit_log, chain_txs, bank_accounts, users, credit_spend, holdings, investors, bookings, anchors, events, positions, trackers, "
            "documents, compliance_config, yachts, berths, marinas CASCADE"
        )


def main():
    if "--reset" in sys.argv:
        import os
        from .db import db_host
        host = db_host(get_settings().database_url)
        if host not in ("localhost", "127.0.0.1", "::1", "db", "") and os.environ.get("GYT_ALLOW_RESET") != "1":
            raise SystemExit(f"Refusing to --reset the database at {host}: it would delete every table. "
                             "Set GYT_ALLOW_RESET=1 if you really mean it.")
        reset()
    init_db()
    keys = json.loads(KEYS_FILE.read_text()) if KEYS_FILE.exists() else {}
    with SessionLocal() as db:
        for m in MARINAS:
            db.execute(
                text("INSERT INTO marinas (id,name,region,location) VALUES (:i,:n,:r,ST_MakePoint(:lon,:lat)::geography) ON CONFLICT DO NOTHING"),
                dict(i=m[0], n=m[1], r=m[2], lat=m[3], lon=m[4]),
            )
        for b in BERTHS:
            db.execute(
                text("""INSERT INTO berths (marina_id,code,max_loa_m,max_beam_m,rate_usd_day,services)
                        VALUES (:m,:c,:l,:b,:r,:s) ON CONFLICT DO NOTHING"""),
                dict(m=b[0], c=b[1], l=b[2], b=b[3], r=b[4], s=b[5]),
            )
        new = []
        for i, y in enumerate(YACHTS, start=1):
            res = db.execute(
                text(
                    """INSERT INTO yachts (id,name,mmsi,flag,loa_m,beam_m,year_built,builder,home_marina_id,berth_code,
                                           valuation_usd,units_total,tokenized,insurance_verified,inspection_status,
                                           charter_week_usd,twin_token_id)
                       VALUES (:id,:n,:mmsi,:f,:l,:b,:yr,:bu,:h,:be,:v,:u,:t,:ins,:insp,:cw,:tok) ON CONFLICT DO NOTHING"""
                ),
                dict(id=y[0], n=y[1], mmsi=y[2], f=y[3], l=y[4], b=y[5], yr=y[6], bu=y[7], h=y[8], be=y[9], v=y[10], u=y[11],
                     t=y[11] > 0, ins=y[12], insp=y[13], cw=y[14], tok=i),
            )
            if res.rowcount:
                new.append(y)
            if y[11] > 0:
                db.execute(
                    text("INSERT INTO compliance_config (yacht_id, allowed_countries) VALUES (:y,:c) ON CONFLICT DO NOTHING"),
                    {"y": y[0], "c": ALLOWED},
                )
            tid = f"TRK-{y[0][-4:]}"
            if tid not in keys:
                priv, pub = new_keypair()
                keys[tid] = {"yacht_id": y[0], "private_key": priv, "public_key": pub}
            db.execute(
                text("INSERT INTO trackers (id,yacht_id,public_key) VALUES (:i,:y,:k) ON CONFLICT (id) DO UPDATE SET public_key=EXCLUDED.public_key"),
                dict(i=tid, y=y[0], k=keys[tid]["public_key"]),
            )
        for inv in INVESTORS:
            db.execute(
                text("""INSERT INTO investors (id,name,kind,country_code,professional,kyc_status,screening,kyc_expires)
                        VALUES (:i,:n,:k,:c,:p,:s,:sc, CASE WHEN :s='approved' THEN current_date + 365 END) ON CONFLICT DO NOTHING"""),
                dict(i=inv[0], n=inv[1], k=inv[2], c=inv[3], p=inv[4], s=inv[5], sc=inv[6]),
            )
        for h in HOLDINGS:
            db.execute(
                text("INSERT INTO holdings VALUES (:i,:y,:u,:m) ON CONFLICT DO NOTHING"), dict(i=h[0], y=h[1], u=h[2], m=h[3])
            )
        today = datetime.now(timezone.utc).date()
        for y in YACHTS:
            for q, f in enumerate(VALUATION_PATH):
                d = today - timedelta(days=91 * (len(VALUATION_PATH) - 1 - q))
                db.execute(text("""INSERT INTO valuations (yacht_id, valued_at, value_usd, source) VALUES (:y,:d,:v,:s)
                                   ON CONFLICT (yacht_id, valued_at) DO NOTHING"""),
                           {"y": y[0], "d": d, "v": round(y[10] * f, -3) if f < 1 else y[10],
                            "s": "Independent surveyor" if q % 2 else "Broker desktop valuation"})
        st = get_settings()
        if st.admin_email and st.admin_password:
            ensure_admin(db, st.admin_email, st.admin_password)
        db.flush()
        # Sample fleet arrives already verified and minted; new onboardings start as 'pending'.
        db.execute(text("UPDATE yachts SET twin_status='minted', units_minted=units_total WHERE id = ANY(:ids)"),
                   {"ids": [y[0] for y in YACHTS]})
        chain = ChainClient()
        if chain.twin_enabled:  # mint the sample twins on-chain so token ids and tx hashes are real
            for y in YACHTS:
                tid = chain.twin_id_of(y[0])
                tx = None
                if not tid:
                    r = chain.mint_twin(y[0], hashlib.sha256(f"{y[3]}|{y[2]}".encode()).digest(), b"\x00" * 32)
                    tid, tx = r.index, r.tx_hash
                    db.execute(text("INSERT INTO chain_txs (kind,ref,tx_hash,contract,detail) VALUES ('twin_mint',:r,:tx,:c,CAST(:d AS JSONB))"),
                               dict(r=y[0], tx=tx, c=get_settings().yacht_twin_address, d=json.dumps({"token_id": tid, "seed": True})))
                db.execute(text("UPDATE yachts SET twin_token_id=:t, twin_tx=coalesce(:tx, twin_tx) WHERE id=:i"), {"t": tid, "tx": tx, "i": y[0]})
        else:
            db.execute(text("UPDATE yachts SET twin_token_id=NULL WHERE id = ANY(:ids) AND twin_tx IS NULL"), {"ids": [y[0] for y in YACHTS]})
        for y in new:
            record_event(db, y[0], "TWIN_MINT", marina_id=y[8], berth_code=y[9])
        db.commit()
    KEYS_FILE.write_text(json.dumps(keys, indent=2))
    print(f"Seeded {len(MARINAS)} marinas, {len(BERTHS)} berths, {len(YACHTS)} yachts, {len(INVESTORS)} investors.")
    if get_settings().admin_email:
        print(f"Admin account: {get_settings().admin_email} (password from ADMIN_PASSWORD; change it after first sign-in)")
    print(f"Simulator tracker keys written to {KEYS_FILE.name} (local development only).")


if __name__ == "__main__":
    main()
