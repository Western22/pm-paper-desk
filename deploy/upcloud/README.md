# Live desk on UpCloud

One small always-on server runs `bot/engine_server.js` (WebSocket books) + `bot/live_runner.py` (orders)
as a systemd service. It starts in **DRY RUN** and only trades after you put your key on the server.

## 1. Create the server (UpCloud control panel → Deploy server)
- **Location — must be one Polymarket allows trading from:** Amsterdam (`nl-ams1`), Helsinki (`fi-hel1/2`),
  Stockholm (`se-sto1`), Madrid (`es-mad1`), Copenhagen (`dk-cph1`).
  **Not** Frankfurt, London, Warsaw, Singapore, Sydney or any US region — they are close-only / blocked
  ([Polymarket geoblock](https://docs.polymarket.com/api-reference/geoblock)); the bot refuses to trade there.
- **Plan:** 1 CPU / 1–2 GB is plenty. **OS:** Ubuntu Server 24.04 LTS.
- **Login:** add your SSH public key (no password login).
- **Initialization script / User data:** paste the whole of [`cloud-init.yaml`](cloud-init.yaml).

## 2. Check it (≈5 min after boot)
```bash
ssh root@<server-ip>
cat /var/log/pm-desk-check.log          # geoblock verdict, latency to Polymarket, 150 s dry run
journalctl -u pm-live -f                # live log (dry run: "[dry] place …")
```
Pick the allowed region with the lowest `tls`/`total` times; if two are close, prefer Amsterdam.

## Live dashboard (private)
The bot serves a live page on the server itself (port 8080, not reachable from the internet). From your PC:
```powershell
ssh -L 8080:localhost:8080 root@<server-ip>
```
keep that window open and browse to **http://localhost:8080** — mode, wallet P&L vs loss limit, capital in orders,
resting orders, positions, engine markets, fills/pulls with latency, live events, and the paper account alongside.
Refreshes every 2 s; read-only; the key never appears in it.

## 3. Go live (small)
```bash
nano /etc/pm-desk/env                   # set POLYMARKET_WALLET_ADDRESS, POLYMARKET_PRIVATE_KEY, LIVE=1
systemctl restart pm-live && journalctl -u pm-live -f
```
On start it checks the server's location with Polymarket, refuses to trade if restricted, then connects,
arms the heartbeat and logs `connected · wallet type …`. Limits in the same file: `LIVE_MAX_USDC=50`,
`MAX_LOSS_USDC=15`.

## Day to day
| | |
|---|---|
| stop trading now (cancels all orders) | `systemctl stop pm-live` |
| back to dry run | set `LIVE=0` in `/etc/pm-desk/env`, `systemctl restart pm-live` |
| update to the latest engine | `pm-desk-update` |
| logs | `journalctl -u pm-live --since "1 hour ago"` |

Security: the key lives only in `/etc/pm-desk/env` (root-only, `0600`); the service runs as an unprivileged
`desk` user with a read-only filesystem except its state folder; the firewall allows SSH only. Never commit
the key, paste it into chat, or reuse a wallet that holds more than you're willing to trade.
