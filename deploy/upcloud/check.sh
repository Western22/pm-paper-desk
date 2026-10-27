#!/bin/sh
# Server preflight: is trading allowed from here, and how close are we to Polymarket?
# Run on the server:  sh /opt/pm-desk/app/deploy/upcloud/check.sh
set -u

echo "== Polymarket geoblock for this server's IP =="
curl -fsS --max-time 10 https://polymarket.com/api/geoblock || echo "geoblock endpoint unreachable"
echo
echo "(blocked=true or a close-only country such as US, GB, DE, FR, PL, SG, AU means: do not trade live from here)"

echo
echo "== Latency to Polymarket (5 samples each; TCP connect / TLS done / total, seconds) =="
for url in https://clob.polymarket.com/time https://ws-subscriptions-clob.polymarket.com/ https://data-api.polymarket.com/trades?limit=1; do
  echo "$url"
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null --max-time 10 -w "  connect %{time_connect}  tls %{time_appconnect}  total %{time_total}\n" "$url"
  done
done

echo
echo "== Engine dry-run (150 s: first market scan takes ~1 min; no orders, no key needed) =="
cd /opt/pm-desk/app 2>/dev/null || cd "$(dirname "$0")/../.."
LIVE=0 RUN_SEC=150 LIVE_STATE=/tmp/pm-check-state.json timeout 200 python3 bot/live_runner.py 2>&1 | tail -15
