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
python -m app.seed && uvicorn app.main:app --reload
TEST_DATABASE_URL=postgresql+psycopg://... pytest       # 39 tests; resets that database

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
