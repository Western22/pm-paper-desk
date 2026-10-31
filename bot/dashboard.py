"""Private live dashboard for the executor: GET / (page) and GET /status (JSON), stdlib only.

Binds to 127.0.0.1 by default — view it from your PC through an SSH tunnel:
    ssh -L 8080:localhost:8080 root@<server-ip>     then open http://localhost:8080
Read-only: there is no endpoint that changes anything, and the key never appears in the data.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

PAGE = Path(__file__).resolve().parent / "dashboard.html"


def _names(markets):
    """token id → (question, outcome) from the engine's market list."""
    out = {}
    for m in markets or []:
        toks = m.get("tokens") or []
        for i, t in enumerate(toks):
            out[str(t)] = (
                m.get("q") or m.get("question") or "",
                "YES" if i == 0 else "NO",
            )
    return out


def status(
    ex, live: bool, max_usdc: float, max_loss: float, events, location, positions
):
    names = _names(ex.markets)
    orders = []
    for (token, side, price, size), v in ex.resting.items():
        q, outcome = names.get(str(token), ("", ""))
        orders.append(
            {
                "question": q,
                "outcome": outcome,
                "side": side,
                "price": price,
                "size": size,
                "usd": round(price * size, 2),
                "id": str(v.get("id"))[:14],
            }
        )
    orders.sort(key=lambda o: (o["question"], o["outcome"], o["side"]))
    pulls = sorted(ex.stats.get("pull_ms") or [])
    now = time.time()
    return {
        "now": now,
        "mode": "LIVE" if live else "DRY RUN",
        "location": location.get("info"),
        "uptimeSec": round(now - ex.started),
        "pnl": round(ex.pnl, 2),
        "maxLoss": max_loss,
        "lossUsedPct": round(max(0.0, -ex.pnl) / max_loss * 100, 1) if max_loss else 0,
        "capital": max_usdc,
        "collateral": round(ex.cost, 2),
        "heartbeatAgeSec": round(now - ex.last_hb_ok, 1) if ex.last_hb_ok else None,
        "engineAgeSec": round(now - ex.last_engine, 1),
        "lastSyncAgeSec": round(now - ex.last_sync, 1) if ex.last_sync else None,
        "stats": {
            k: ex.stats.get(k)
            for k in ("placed", "cancelled", "rejected", "fills", "pulls")
        },
        "pullMs": {
            "p50": round(pulls[len(pulls) // 2]) if pulls else None,
            "max": round(pulls[-1]) if pulls else None,
            "n": len(pulls),
        },
        "markets": [
            {
                "question": m.get("q"),
                "status": m.get("status"),
                "inv": m.get("inv"),
                "mid": m.get("mid"),
                "ws": m.get("ws"),
            }
            for m in ex.markets or []
        ],
        "orders": orders,
        "positions": positions,
        "paper": ex.paper,
        "events": list(events)[-120:],
    }


async def serve(ex, host: str, port: int, lr):
    """lr = the running live_runner module (its globals hold LIVE, limits, EVENTS, LOCATION, POSITION_ROWS)."""

    async def handle(reader, writer):
        try:
            req = (await asyncio.wait_for(reader.readline(), 5)).decode("latin-1")
            while (await asyncio.wait_for(reader.readline(), 5)) not in (
                b"\r\n",
                b"\n",
                b"",
            ):
                pass  # headers ignored
            path = req.split(" ")[1] if " " in req else "/"
            if path.startswith("/status"):
                st = status(
                    ex,
                    lr.LIVE,
                    lr.MAX_USDC,
                    lr.MAX_LOSS,
                    lr.EVENTS,
                    lr.LOCATION,
                    lr.POSITION_ROWS,
                )
                st["account"] = dict(getattr(lr, "ACCOUNT", {}) or {})
                body = json.dumps(st).encode()
                ctype = "application/json"
            elif path in ("/", "/index.html"):
                body, ctype = PAGE.read_bytes(), "text/html; charset=utf-8"
            else:
                body, ctype = b"not found", "text/plain"
            code = "404 Not Found" if body == b"not found" else "200 OK"
            writer.write(
                f"HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        except Exception:  # noqa: BLE001, S110 — a broken browser request must never affect trading
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, host, port)
    lr.log(
        f"dashboard on http://{host}:{port}  (from your PC: ssh -L {port}:localhost:{port} root@<server-ip>)"
    )
    async with server:
        await server.serve_forever()
