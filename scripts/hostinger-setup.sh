#!/usr/bin/env bash
# GYT on a Hostinger VPS: one-command setup and update.
#
#   curl -fsSL https://raw.githubusercontent.com/Rokit12/GYT/main/scripts/hostinger-setup.sh | bash -s -- your-domain.com
#
# First run: installs Docker if needed, downloads GYT to /opt/gyt, generates the secrets on this server
# (they never leave it), asks for the primary admin's email and password, and starts the database
# (PostgreSQL + PostGIS), API, website, HTTPS and nightly backups.
# Later runs: update GYT to the latest version. Your settings and data are kept.
set -euo pipefail

DOMAIN="${1:-}"
DIR=/opt/gyt
REPO=https://github.com/Rokit12/GYT.git
COMPOSE="docker compose -f docker-compose.hostinger.yml --env-file .env"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -r -p "$1" v < /dev/tty; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1" v < /dev/tty; echo > /dev/tty; printf '%s' "$v"; }

[ "$(id -u)" = 0 ] || die "Run this as root (ssh root@your-vps, or the browser terminal in hPanel)."

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose is missing. Choose the Docker template for this VPS in hPanel, then run this again."
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

say "GYT code in $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  say "Settings (stored only on this server, in $DIR/.env)"
  [ -n "$DOMAIN" ] || DOMAIN="$(ask 'Domain for GYT (e.g. example.com): ')"
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#www.}"; DOMAIN="${DOMAIN%%/*}"
  [ -n "$DOMAIN" ] || die "A domain is needed."
  ADMIN_EMAIL="$(ask 'Primary admin email: ')"
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "That doesn't look like an email address."
  while :; do
    ADMIN_PASSWORD="$(ask_secret 'Primary admin password (at least 12 characters): ')"
    [ "${#ADMIN_PASSWORD}" -ge 12 ] || { echo "Too short, try again."; continue; }
    [[ "$ADMIN_PASSWORD" != *\'* ]] || { echo "Please don't use the ' character in it; try again."; continue; }
    [ "$ADMIN_PASSWORD" = "$(ask_secret 'Same password again: ')" ] && break
    echo "The passwords didn't match, try again."
  done
  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
BANK_DATA_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 24)
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD='$ADMIN_PASSWORD'
DIGITRAFFIC_ENABLED=false
AUTOPILOT_INTERVAL_SECONDS=300
ANCHOR_INTERVAL_SECONDS=0
EOF
  chmod 600 .env
  echo "Saved. Keep a copy of $DIR/.env somewhere safe: BANK_DATA_KEY and POSTGRES_PASSWORD can't be recovered."
else
  DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
  echo "Using the existing settings in $DIR/.env (domain: $DOMAIN)."
fi

say "Firewall: allowing web traffic (80, 443)"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null; echo "ufw updated"
else
  echo "No active ufw firewall on this server. If hPanel's VPS firewall is on, allow ports 80 and 443 there."
fi

say "Building and starting GYT (the first build takes a few minutes)"
$COMPOSE pull db caddy backup 2>/dev/null || true
$COMPOSE build --pull
$COMPOSE up -d

say "Waiting for the database and the first-run setup"
for _ in $(seq 1 60); do
  state="$($COMPOSE ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk '$1=="bootstrap"{print $2" "$3}')"
  case "$state" in
    "exited 0") break ;;
    exited*) $COMPOSE logs bootstrap | tail -20; die "First-run setup failed (see above)." ;;
  esac
  sleep 5
done
$COMPOSE logs bootstrap | tail -3

say "Checking the domain"
IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
for name in "$DOMAIN" "www.$DOMAIN"; do
  got="$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ "$got" = "$IP" ]; then echo "OK   $name -> $IP"
  else echo "WAIT $name -> ${got:-no record yet} (needs an A record pointing to $IP)"; fi
done

cat <<EOF

GYT is running on this VPS.
  Website:  https://$DOMAIN   (HTTPS starts working once the domain points here; Caddy retries by itself)
  Sign in:  the primary admin email and password you just set
  Status:   cd $DIR && $COMPOSE ps
  Logs:     cd $DIR && $COMPOSE logs -f api web caddy
  Backups:  nightly, kept on the 'backups' volume (see docs/HOSTINGER.md)
  Update:   run this same command again

Optional sample data for demonstrations (marinas, yachts, investors):
  cd $DIR && $COMPOSE run --rm api python -m app.seed
EOF
