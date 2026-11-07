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

## Yacht map (OpenStreetMap)

`/map` shows every verified yacht's latest position on an OpenStreetMap map (Leaflet,
`web/components/OsmMap.tsx`), with a searchable list, filters by source (hardware GPS, phone, AIS),
trails, and popups linking to the passport and tracker. Passports have a **See on map** button.
Tiles come from `tile.openstreetmap.org`, which is free for light use with attribution; for real
traffic set `NEXT_PUBLIC_OSM_TILES` to another OpenStreetMap tile host or your own tile server.

## Tracking without hardware: Track from this device

A yacht with no GPS tracker fitted can be tracked from the owner's or captain's phone or laptop.
Open **Track from your phone** (`/track/device`), choose the yacht and press **Start sharing**. While the
page is open, the browser's location is sent as the yacht's position every 10 seconds.

* **Who can share:** the yacht's owner, crew the owner adds by email (on the same page), and admins.
* **Stored as** `positions.source = 'device'`, with the device's reported accuracy and the sharing
  session it came from (`device_sessions`). Starting and stopping each record a hashed event.
* **Checks** (`api/app/devices.py`): fixes vaguer than 1 km are refused; one fix per 10 s per
  session; clock-ahead and stale fixes are refused; jumps faster than 60 kn are stored but flagged.
  Fixes within 100 m with no flags count as good. All limits are `DEVICE_*` settings.
* **No signal at sea:** fixes wait in the browser and upload in one batch (`/device/fixes`) when the
  connection returns. At anchor, the last reading is re-sent once a minute so the yacht doesn't go quiet.
* **Trust level:** a phone fix is tied to a signed-in account, not sealed hardware. On the map it is
  labelled *Phone or laptop*. For an arrival proof, a good phone fix can stand in for signed GPS only
  when the yacht has no signed GPS fix, and AIS or satellite radar must still agree; the proof then
  says `primary: device`, `assurance: standard`.
* **Limits of the web:** phones pause location for web pages when the screen locks or the browser
  is in the background, so keep the page open, the screen on (the page asks to keep it awake) and
  the phone charging. Location needs HTTPS.

API: `GET /me/trackable`, `POST /yachts/{id}/device/start|fix|fixes|stop`,
`GET /yachts/{id}/device/sessions`, `GET|POST /yachts/{id}/crew`, `DELETE /yachts/{id}/crew/{user_id}`.

## Berths that fit, with live holds

`/berths` (**Find a berth** in the Platform menu) shows every berth at a marina drawn to scale against the
chosen yacht, with the yacht's outline in the selected berth.

* **Fit is a hard rule** (`api/app/berths.py`): length (LOA) and beam must be within the berth's maximums,
  and draft within the berth's depth when both are known. A berth that is too small is never offered.
* **Best fit first:** among berths that fit, the one with the least spare length, so big berths stay free
  for big yachts.
* **Live holds:** picking a berth places a 10-minute hold (`BERTH_HOLD_MINUTES`). Every other yacht sees
  it as "Held by another yacht (28 m)" at once (the page refreshes every 3 s); names are never shown.
  Holding locks the berth row, and an exclusion constraint on `berth_holds` (plus the existing one on
  `bookings`) means two yachts can never hold or book the same berth for overlapping dates.
* **Confirm** turns the hold into an escrowed booking; payment is released when arrival is proven.
* **Admin berth board** (`/admin/berths`): every berth, who is in it or holding it (with the countdown),
  how much of the berth the yacht uses, and anything that does not fit.

API: `GET /berths/availability`, `POST /berths/{id}/hold`, `DELETE /berths/holds/{id}`,
`POST /berths/holds/{id}/confirm`, `GET /admin/berths/board`.

**Booking with a size.** On Find a berth the client enters the yacht's length overall, beam and draft
as it will lie in the berth, with any bowsprit, swim platform, davits or tender. The fields are prefilled
with the registered size. The entered size decides which berths fit, is kept on the hold and the booking,
and is what the marina board and the autopilot check against. It can never be smaller than the yacht's
registered (verified) size. The satellite hull-length check at arrival still uses the registered hull.
API: `loa_m`, `beam_m` and `draft_m` on `GET /berths/availability` and `POST /berths/{id}/hold` (migration 011).

### 3D marina and berth plans

Find a berth and the admin berth board both have a **3D marina** view (three.js, `web/lib/marina3d.js`):
berths and yachts to scale, your yacht in teal where it fits and red where it doesn't, live holds in
amber, misfits over a red band, and a docking animation on confirm. It works with touch on phones.

**Berth plan to 3D** (`/admin/berths/plan`) turns an image of a marina's berth plan into berths:

1. Load the plan (PNG, JPEG or WebP; a drawing, scan or CAD screenshot). A sample is included.
2. Set the scale: the plan's width in metres, or *Measure the scale* and click both ends of its scale bar.
3. *Find berths* runs in the browser (`web/lib/berthplan.js`): every closed, berth-shaped outline at any
   angle becomes a berth, sized from the scale, with its pontoon end on the side that touches the pontoon.
   *Read with AI* (only when `ANTHROPIC_API_KEY` is set) also reads printed codes and sizes. Fix codes and
   sizes in the table, flip or delete a berth, or drag on the plan to draw one.
4. The 3D marina is built live from the plan, with the image on the water.
5. *Save* stores the image and adds or updates berths by code with their size and plan position. It never
   deletes a berth. Find a berth and the board then use the marina's real layout.

API: `GET /marinas/{id}/plan`, `GET /marinas/{id}/plan/image`, `PUT /admin/marinas/{id}/plan/image`,
`PUT /admin/marinas/{id}/plan`, `POST /admin/marinas/{id}/plan/read` (AI, advisory). After editing
`web/lib/marina3d.js` or `web/lib/berthplan.js`, run `python3 scripts/sync_pages_3d.py` to update the
GitHub Pages demo.

## Autopilot (automation, with optional AI)

`api/app/autopilot.py` runs every `AUTOPILOT_INTERVAL_SECONDS` (and on **Run now** in `/admin/autopilot`):
releases expired berth holds, flags bookings whose yacht no longer fits its berth, runs the three-signal
arrival check for bookings due today (and flags a satellite hull length that does not match), screens
new owner sign-ups, and, with AI on, writes a short brief for the team. Everything it does is logged
with the reason (`autopilot_log`).

**AI is optional and advisory.** Set `ANTHROPIC_API_KEY` (and optionally `AI_MODEL`) to have Claude read
uploaded registry certificates and write the brief (`api/app/ai.py`, structured tool output only). The
AI can add a reason to review; it never approves accounts, moves money or changes bookings. Rules make
the final call, and admins approve (or set `AUTOPILOT_AUTO_APPROVE=true` to approve owners whose every
rule-based check passes). Without a key everything works on rules alone.

## Admins and rights

* The **primary admin** is the first admin (`ADMIN_EMAIL`). It holds every right, and it can't be deleted,
  suspended or demoted. This is enforced by a database trigger (migration 010), so no code path can get around it.
* Only the primary admin opens **Admins & rights** (`/admin/admins`). There it adds secondary admins and ticks
  their rights: Autopilot, Monitoring, Registry (yachts, minting, hashes), Users, Investors, Banking, Berths
  (board, plans, marinas), Bookings (escrow), Audit log and Docs. An existing account can be promoted, or a
  new one is created with a temporary password that is shown once.
* Every admin endpoint checks its right against the database on each request, so a removed right stops
  working at once. Secondary admins see only the menu items they have rights for. Opening any other page
  explains which right is missing.
* Only the primary admin can change other admin accounts. An admin with the Users right still approves,
  suspends and edits ordinary users.

API: `GET /admin/rights`, `GET|POST /admin/admins`, `PATCH|DELETE /admin/admins/{id}`. `/auth/me` returns `is_primary` and `rights`.

## Who can sign up

With `REGISTRATION_MODE=owners_and_invites` (the default), accounts are only for:

* **Yacht owners**, who give the yacht's name, flag, length, MMSI and/or IMO and registry number, and
  upload the certificate of registry. Checks: MMSI format and country code against the flag, IMO check
  digit, no other account or yacht using those numbers, and the document (plus the AI reading, if on).
  The account stays pending until approved.
* **Invited people**: owners invite their captain or crew to one yacht (Track from your phone →
  Crew → Create invite code); admins invite investors, marina staff and partners. Codes are single-use,
  can be locked to one email, and expire after `INVITE_DAYS`.

Browsing yachts, the map and verifying records need no account. Set `REGISTRATION_MODE=open` for local
development.

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
