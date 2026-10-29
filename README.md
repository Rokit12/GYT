# GYT · Global Yacht Tokenization

A trust and operating layer for yachts: a verified digital passport per vessel, three-signal position
tracking (AIS + signed onboard GPS + satellite SAR), proof-of-arrival escrow for berth and charter
payments, and permissioned economic units with **Use or Earn** usage credits.

```
web/        Next.js 14 (App Router, TypeScript). Public site: home, explore yachts, passports,
            Track & verify (live track + every event hash, verified in the browser), Use or Earn,
            List your yacht, sign in / sign up. Admin console: dashboard, monitoring, yachts &
            minting, hashes & addresses, users & approvals, investors & KYC, banking details,
            bookings & escrow, marinas & berths, audit log, internal documentation
api/        FastAPI + SQLAlchemy + PostGIS: registry, tracking ingest, fusion, bookings,
            anchoring, compliance preflight, credits
contracts/  Solidity 0.8.26 + Foundry: IdentityRegistry, Compliance, YachtUnits (ERC-3643-style),
            YachtTwin (ERC-721), ProofRegistry (Merkle roots), ArrivalEscrow
scripts/    demo.sh: runs a full booking → arrival → anchor → release flow
```

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build              # PostGIS, Anvil chain, contract deploy, API :8000, web :3000
docker compose exec api python -m app.seed
docker compose exec api python -m app.simulate arrive YACHT-000007 MARINA-DXB-001
```

Open http://localhost:3000 and sign in with the admin account from `.env`
(`ADMIN_EMAIL` / `ADMIN_PASSWORD`; the template ships `admin@gyt.com` / `change-me-before-deploy`, so change it
before anyone else can reach the server). API docs: http://localhost:8000/docs.

## Accounts and access

| Who | How they get in | What they can do |
| --- | --- | --- |
| Visitor | No account | Home, explore yachts, passports, verify any hash |
| Client (pending) | Signs up | Everything above plus Track & verify; cannot book or submit yachts yet |
| Client (active) | Approved by an admin | Book berths, book with credits, submit yachts for onboarding |
| Admin | Seeded from env, or promoted by another admin | Full console; every change is written to the audit log |

Passwords are scrypt-hashed. Sessions are HS256 JWTs (shared `JWT_SECRET`) stored in an httpOnly
cookie by the web app. The API enforces every rule; the web middleware only routes people to sign in.
Five failed sign-ins in 15 minutes lock that email/IP pair. The last active admin cannot be demoted
or deleted. Bank account numbers are encrypted with `BANK_DATA_KEY` and only the last four digits
are ever returned or logged.

## Without Docker

```bash
# contracts
cd contracts && forge test && anvil &                     # 28 tests
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER_KEY --broadcast

# api (needs PostgreSQL 16 with PostGIS 3)
cd api && pip install -r requirements-dev.txt
cp ../.env.example .env   # set DATABASE_URL
python -m app.migrate && python -m app.seed && uvicorn app.main:app --reload
TEST_DATABASE_URL=postgresql+psycopg://... pytest       # 58 tests; resets that database (local hosts only)

# web
cd web && npm install && npm test && API_URL=http://localhost:8000 JWT_SECRET=... npm run dev

# demo flow
ADMIN_PASSWORD=... ./scripts/demo.sh
```

## How the pieces fit

**Proofs.** Every important event (position batch, check-in, inspection, document, arrival) becomes a
SHA-256 leaf in Postgres. The anchor loop builds a Merkle tree every `ANCHOR_INTERVAL_SECONDS` and writes
the root to `ProofRegistry`. Anyone can fetch `/proofs/{event_id}` and recompute the path; the passport
page does it in the browser. Tree rules are identical in Python (`api/app/proof.py`), TypeScript
(`web/lib/merkle.ts`) and Solidity (`ProofRegistry.computeRoot`), and one shared test vector is
asserted in all three test suites.

**Fusion.** `api/app/fusion.py` decides arrival. Signed GPS is required (ed25519, key generated on the
tracker). AIS or SAR must agree with it within `FUSION_MAX_SPREAD_M`. If AIS disagrees, spoofing is
flagged and SAR becomes mandatory. SAR hull length must be within 20% of the registered LOA. The
fused record is hashed into `fusionDigest`.

**Escrow.** `ArrivalEscrow.release` recomputes `sha256(ref || twinId || marinaId || fusionDigest)` and
checks it against an anchored root before paying the split. If no proof arrives by the deadline the
payer can refund. `POST /bookings/{ref}/release` returns the exact call arguments for the oracle.

**Compliance.** `YachtUnits` runs `Compliance.canTransfer` on every mint and transfer: frozen wallets,
verified and current identity, country allowlist, holding caps by investor category, lock-up.
`POST /compliance/check-transfer` explains the same rules before anyone signs. Agents can pause and
force-transfer (court orders, lost wallets).

**Double bookings** are impossible at the database level: a GiST exclusion constraint on
`(berth_id, daterange(arrive, depart))`.

## Hosting the database (always on, independent of the app)

The database is its own service. The API only connects to `DATABASE_URL`; it never creates, resets or
owns the data, and it keeps no state of its own (photos are stored in the database too). You can
redeploy, scale or replace the API and web containers, or this development environment can stop,
without touching the data.

**Pick a host that never pauses** (PostgreSQL 15+ with PostGIS):

| Host | Pauses? | Notes |
| --- | --- | --- |
| Supabase **Pro** | Never ("paid plans cannot be paused") | PostGIS built in. The Free plan pauses after 7 days of low activity, so do not use it for production. |
| Neon **paid plan** | Only if scale-to-zero is on; turn it **off** | The Free plan always suspends after 5 minutes idle (wakes on the next query). |
| AWS RDS / Google Cloud SQL / Railway / your own server | Always on | Enable the `postgis`, `citext` and `btree_gist` extensions. |

**Set it up once:**

```bash
# 1. Create the project on your host, copy its connection string into .env
DATABASE_URL=postgresql://...?sslmode=require        # postgres:// and postgresql:// are both fine
# 2. Create the schema (versioned; safe to re-run; recorded in schema_migrations)
docker compose -f docker-compose.hosted.yml run --rm migrate          # or: cd api && python -m app.migrate
# 3. First admin (ADMIN_EMAIL / ADMIN_PASSWORD in .env) and the sample fleet
docker compose -f docker-compose.hosted.yml run --rm api python -m app.seed
# 4. Run the app against it
docker compose -f docker-compose.hosted.yml up -d --build
```

**What the code does for hosted databases**

- `python -m app.migrate` applies each file in `api/sql/` once, in a transaction, under an advisory
  lock (safe with several API replicas). `python -m app.migrate status` lists applied and pending
  migrations; editing an already-applied file is flagged, so add a new numbered file instead.
- The API waits for the database at startup (up to `DB_WAIT_SECONDS`, with backoff) and refuses to
  start on an out-of-date schema unless `AUTO_MIGRATE=true`.
- Connections are checked before use and recycled, so restarts and dropped idle connections recover
  on their own. Transaction poolers (Supabase port 6543, PgBouncer) are detected and prepared
  statements are turned off for them.
- `python -m app.seed --reset` refuses to run against any non-local database unless `GYT_ALLOW_RESET=1`.
- `GET /health` reports database reachability and pending migrations, ready for an uptime monitor.
- `scripts/db-backup.sh` writes a `pg_dump` of the database to `backups/`; `scripts/db-restore.sh`
  restores it (for example, to move hosts). Keep these in addition to your host's own backups.

## Client accounts

- **Sign-up wizard** (`/signup`): account → interests, country and mobile → follow yachts → welcome checklist.
  Live password checklist and strength meter, inline validation, and it returns you to where you started.
- **Previews before sign-in**: signed-out visitors to `/track`, `/earn`, `/onboard` or `/account` see what the
  feature does (live map, real unit maths, what you'll need) with sign-up and sign-in buttons, at the same URL.
- **My GYT** (`/account`): followed, owned and held yachts with live status, a filterable activity feed of hashed
  records, holdings (units, share, value, Use/Earn), bookings, and a setup checklist. Refreshes every 30 s.
- **Settings** (`/account/settings`): profile, interests, notification switches, password change, investor status
  and wallet.
- **Photos**: owners add up to 12 photos while onboarding or later from the yacht's page (drag and drop, resized
  in the browser, set cover, captions). Each file's SHA-256 is recorded as a `PHOTO_ADDED` event. Stored under
  `MEDIA_DIR`.

### What one unit is worth

Each yacht sits in its own company, which issues `units_total` equal units. **1 unit = latest independent
valuation ÷ units issued** (for Sea Lantern: $24.0M ÷ 40,000 = $600, i.e. 0.0025% of the yacht). The price moves
only when a valuation is recorded (`valuations` table); it is not a market quote. `GET /yachts/{id}/units` returns
the price, valuation history and the pseudonymous holder list; the passport shows it with a calculator.

## Site navigation

The header uses the GYT mark (`web/components/Logo.tsx`; also `web/public/favicon.svg`): a yacht on moving water
inside a brass compass ring, with a block node at north. Its waves drift and the ring turns on hover.
`MainNav.tsx` gives a hover pill and an ink line under the current page, a **Platform** mega menu (Track & verify,
Verify a record, Use or Earn, List your yacht), and on phones a slide-in drawer with a morphing menu button. Esc
closes menus, and every animation respects reduced motion.

Client pages: `/how-it-works` (paths for guests, investors, owners and marinas, the three-signal pipeline and FAQ)
and `/about` (mission, principles, data sources and roadmap).

## Live maps

The home page, the yacht gallery (`/yachts?view=map`), every passport and the tracker use one MapLibre map
(`web/components/LiveMap.tsx`). Everything on it is free:

| Layer | Source | Key? |
| --- | --- | --- |
| Basemap | [OpenFreeMap](https://openfreemap.org) vector tiles (© OpenMapTiles, © OpenStreetMap contributors). Falls back to a bundled Natural Earth coastline if the tile host is unreachable | No |
| GYT fleet | `/live/fleet`: newest signed GPS or AIS fix per minted yacht, plus a 3-hour trail. Markers glide between fixes | No |
| Public yachts | `/live/vessels`: AIS ship types 36 (sailing) and 37 (pleasure craft) | see below |
| ↳ Digitraffic | Fintraffic's open AIS API, polled every 30 s. No key; CC BY 4.0; covers the Baltic around Finland. On by default | No |
| ↳ aisstream.io | Worldwide websocket feed, subscribed around every partner marina and to our fleet's MMSIs | Free key in `AISSTREAM_API_KEY` |

Fleet yachts heard on either feed are also stored as `ais` positions, so fusion and admin monitoring
see them. AIS keys stay on the server; the browser only talks to the GYT API. Swap the basemap with
`NEXT_PUBLIC_MAP_STYLE` / `NEXT_PUBLIC_MAP_STYLE_DARK` (these are read at build time).

## Hero video and imagery

`web/public/media/hero-yacht.mp4` (12 s seamless loop, 1280×720, H.264, 1.8 MB) and the yacht photos in
`web/public/media/yachts/` are original 3D renders made for GYT (three.js), so there are no licence
terms to track. They are illustrations, labelled as such in the gallery. Set `NEXT_PUBLIC_HERO_VIDEO_URL`
to use a licensed clip instead. The video pauses off screen, has a pause button, and stays on its poster
for visitors who ask for reduced motion. Headlines use Big Shoulders Display as a variable font: letters
thicken toward the pointer.

## Live data

| Feed | Adapter | Env var | Status |
| --- | --- | --- | --- |
| AIS | `AisHub` (AISHub exchange) | `AISHUB_USERNAME` | Implemented; commercial feeds use the same interface |
| Satellite SAR | `GlobalFishingWatchSar` | `GFW_API_TOKEN` | Implemented; confirm dataset id and params with GFW docs |
| OSIRIS | `OsirisAdapter` | `OSIRIS_ENDPOINT` | Interface only; OSIRIS (ESA / CNR-ISTI) has no public API, so this needs a research partnership |
| KYC / sanctions | `KycProvider` | `KYC_PROVIDER_KEY` | Simulated locally; wire Sumsub, Onfido or Jumio |

## Before production

- Security audit of all contracts; move admin roles to a multisig and the oracle to an HSM-held key.
- Add SSO and finer roles (owner, marina, inspector, investor) on top of the client/admin split; add
  2FA for admins; move the rate limiter to Redis when running more than one API instance.
- Replace `MockUSD` with a regulated stablecoin and add escrow dispute handling.
- Legal structuring per jurisdiction: economic units are likely securities and must be offered through a
  licensed partner (for example a VARA-licensed broker in Dubai or a MiCA-authorised CASP in the EU).
- Encrypted document storage (S3-compatible, per-document keys) behind the `documents.storage_key` column.
- Partition `positions` by month (or move to TimescaleDB) once telemetry volume grows.
