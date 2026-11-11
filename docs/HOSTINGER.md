# Hosting GYT on Hostinger

GYT runs on a **Hostinger VPS**, with the database on the same VPS. Hostinger's Web and Cloud hosting
plans can't host it: they offer MySQL only and no Python apps, and GYT needs PostgreSQL with PostGIS
plus the Python API.

Everything is in `docker-compose.hostinger.yml`:

| Container | What it does |
| --- | --- |
| `db` | PostgreSQL 16 + PostGIS. Data on the `pgdata` volume. No port open to the internet. |
| `bootstrap` | On every deploy: brings the schema up to date and creates the primary admin. Then stops. |
| `api` | The FastAPI backend. |
| `web` | The Next.js website and admin. |
| `caddy` | HTTPS for your domain (certificate obtained and renewed automatically). |
| `backup` | Dumps the database every night to the `backups` volume and keeps the last 14. |

## 1. Get the VPS ready

1. In hPanel buy or open a **VPS** (KVM 2 or bigger: 2 vCPU, 8 GB RAM is comfortable) and choose the
   **Docker** template under OS & Panel → Operating System. It installs Docker and Docker Manager.
2. In the domain's DNS (hPanel → Domains → your domain → DNS / Nameservers), point both names at the VPS IP:
   an **A record** for `@` → VPS IP, and an **A record** for `www` → VPS IP (or a CNAME `www` → the domain).
   Leave any `MX` and `TXT` records alone: they carry email and verification. `www` redirects to the main address.

## Quickest: one command

In hPanel open the VPS's **Browser terminal** (or `ssh root@YOUR-VPS-IP`) and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Rokit12/GYT/main/scripts/hostinger-setup.sh | bash -s -- your-domain.com
```

It installs Docker if needed, downloads GYT to `/opt/gyt`, generates every secret on the server, asks for the
primary admin's email and password, starts everything and checks that the domain points at the VPS.
Run the same command again to update. The manual steps below do the same thing by hand.

## 2. Set the settings

Fill in the values listed in `.env.hostinger.example`. Generate each secret with `openssl rand -hex 32`
(in the VPS browser terminal). Required: `DOMAIN`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `BANK_DATA_KEY`. Keep a copy of `BANK_DATA_KEY` and `POSTGRES_PASSWORD` somewhere safe.

## 3. Deploy

**Docker Manager:** VPS → Docker Manager → Compose → *from URL* →
`https://github.com/Rokit12/GYT/blob/main/docker-compose.hostinger.yml`, paste the settings as environment
variables, and deploy.

**Or over SSH:**

```bash
git clone https://github.com/Rokit12/GYT.git gyt && cd gyt
cp .env.hostinger.example .env && nano .env          # fill in the values
docker compose -f docker-compose.hostinger.yml up -d --build
docker compose -f docker-compose.hostinger.yml logs -f bootstrap   # "primary admin: …" means ready
```

Open `https://YOUR-DOMAIN` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Optional sample data for demonstrations (marinas, yachts, investors):
`docker compose -f docker-compose.hostinger.yml run --rm api python -m app.seed`

## Updating

```bash
docker compose -f docker-compose.hostinger.yml build --pull && docker compose -f docker-compose.hostinger.yml up -d
```

`bootstrap` applies any new migrations before the API starts. Your data stays on the `pgdata` volume.

## Backups and restore

```bash
docker compose -f docker-compose.hostinger.yml exec backup ls -lh /backups          # list
docker compose -f docker-compose.hostinger.yml cp backup:/backups/gyt_YYYYMMDD_HHMMSS.dump .   # download
# restore into the running database (overwrites it):
docker compose -f docker-compose.hostinger.yml exec -T db pg_restore -U gyt -d gyt --clean --if-exists < gyt_YYYYMMDD_HHMMSS.dump
```

Also turn on Hostinger's weekly VPS snapshots in hPanel as a second copy.
