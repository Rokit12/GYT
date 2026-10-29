#!/usr/bin/env bash
# Runs a full demo flow against a running stack (API on :8000):
# two berth bookings and one credit stay; one yacht arrives on all three signals,
# another reports a signed GPS position 8–9 km away so its arrival is correctly rejected.
set -euo pipefail
API=${API:-http://localhost:8000}
cd "$(dirname "$0")/../api"

T=$(date -d tomorrow +%F); D=$(date -d "+4 days" +%F); L=$(date -d "+30 days" +%F)
berth_id() {
  curl -s "$API/berths/search?loa_m=$1&beam_m=$2&arrive=$T&depart=$D&region=Gulf" |
    python3 -c "import sys,json;print([b['id'] for b in json.load(sys.stdin) if b['code']=='$3'][0])"
}
# Sign in as the admin (from .env / environment) to place demo bookings
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@gyt.com}
TOKEN=$(curl -s -XPOST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"${ADMIN_PASSWORD:?set ADMIN_PASSWORD}\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
post() { curl -s -XPOST "$API$1" -H 'content-type: application/json' -H "Authorization: Bearer $TOKEN" -d "$2"; echo; }

post /bookings/berth "{\"ref\":\"BK-4098\",\"yacht_id\":\"YACHT-000007\",\"berth_id\":$(berth_id 47 9 A040),\"arrive\":\"$T\",\"depart\":\"$D\"}"
post /bookings/berth "{\"ref\":\"BK-4100\",\"yacht_id\":\"YACHT-000001\",\"berth_id\":$(berth_id 35 7.9 B128),\"arrive\":\"$T\",\"depart\":\"$D\"}"
post /investors/INV-1043/stays "{\"ref\":\"CS-7302\",\"yacht_id\":\"YACHT-000003\",\"arrive\":\"$L\",\"nights\":3}"

python3 -m app.simulate arrive YACHT-000007 MARINA-DXB-001
python3 - <<'EOF'
import json, datetime as dt, httpx
from app.signing import gps_message, sign
keys = json.load(open("tracker_keys.json")); tid = "TRK-0001"; k = keys[tid]
for j in range(3):
    t = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10 * (3 - j))).replace(microsecond=0)
    lat, lon = 25.3 - 0.07 * j, 55.25 - 0.035 * j
    httpx.post("http://localhost:8000/tracking/gps", json=dict(
        tracker_id=tid, yacht_id="YACHT-000001", lat=lat, lon=lon, observed_at=t.isoformat(),
        signature=sign(k["private_key"], gps_message(tid, "YACHT-000001", lat, lon, t)))).raise_for_status()
print("YACHT-000001 approaching Dubai Harbour, still ~9 km out")
EOF
echo "Demo data ready. Open http://localhost:3000/admin and press Prove arrival."
