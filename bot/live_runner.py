#!/usr/bin/env python3
"""
Low-latency live executor for the liquidity-rewards engine.

Pipeline (one persistent process each, no per-tick start-up cost):
  node bot/engine_server.js   books over Polymarket's market WebSocket → same engine as the paper trader
                              → desired orders every TICK_MS (5 s) + an immediate "pull" on any adverse move
  this executor               diffs desired vs resting orders in memory (no REST round-trip per tick),
                              cancels in one call, places in batches of 15 signed orders (post_orders),
                              runs every exchange call concurrently, reconciles with the exchange every 60 s.

Fast path: a WebSocket book update that moves the size-adjusted mid ≥ max(1.5¢, 0.4·v) or crosses our
quote → the engine emits "pull" → this process cancels that market's orders at once (logged with latency).

Safety
  * DRY RUN unless LIVE=1 — prints every action, sends nothing, needs no key.
  * LIVE_MAX_USDC  hard cap on capital the engine may allocate (default 50); BUY collateral is re-checked here.
  * MAX_LOSS_USDC  kill switch on wallet P&L since start (data-api cashPnl + realizedPnl), default 15.
  * Heartbeat every 5 s arms Polymarket's server-side cancel (orders pulled ~10-15 s after this dies; best effort).
  * No orders until real positions have been read; engine silent > 30 s → cancel all.
  * Ctrl-C / SIGTERM → cancel all.

    pip install polymarket-client
    export POLYMARKET_PRIVATE_KEY=0x...          # signer key — never commit, never paste anywhere
    export POLYMARKET_WALLET_ADDRESS=0x...       # your polymarket.com deposit / proxy wallet
    python bot/live_runner.py                    # dry run
    LIVE=1 LIVE_MAX_USDC=50 MAX_LOSS_USDC=15 python bot/live_runner.py

Resolved markets: the engine stops quoting them; redeem winning shares on polymarket.com.
SDK calls follow docs.polymarket.com (AsyncSecureClient.create, create_limit_order + post_orders (≤15),
place_limit_order, list_open_orders, cancel_orders, cancel_all, send_order_heartbeat). Verify against your SDK version.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LIVE = os.environ.get("LIVE") == "1"
WALLET = os.environ.get("POLYMARKET_WALLET_ADDRESS", "")
MAX_USDC = float(os.environ.get("LIVE_MAX_USDC", "50"))
MAX_LOSS = float(os.environ.get("MAX_LOSS_USDC", "15"))
MAX_MARKETS = int(os.environ.get("MAX_MARKETS", "8"))
POS_SEC = float(os.environ.get("POS_SEC", "5"))
RECONCILE_SEC = 60.0
RUN_SEC = float(
    os.environ.get("RUN_SEC", "0")
)  # >0: stop after this many seconds (tests)
HERE = Path(__file__).resolve().parent
STATE = Path(os.environ.get("LIVE_STATE", HERE / "run" / "live-state.json"))
DATA = "https://data-api.polymarket.com"
BATCH = 15


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"user-agent": "liquidity-desk-live/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_positions():
    """{asset: shares} and wallet P&L (cash + realized) from the public data-api."""
    if not WALLET:
        return {}, 0.0
    q = urllib.parse.urlencode({"user": WALLET, "sizeThreshold": 0, "limit": 500})
    rows = get_json(f"{DATA}/positions?{q}")
    pos = {str(p.get("asset")): float(p.get("size") or 0) for p in rows}
    pnl = sum(
        float(p.get("cashPnl") or 0) + float(p.get("realizedPnl") or 0) for p in rows
    )
    return pos, pnl


def key(o):
    return (
        str(o["token"]),
        o["side"].upper(),
        round(float(o["price"]), 4),
        int(float(o["size"])),
    )


def _attr(o, *names, default=None):
    for n in names:
        v = o.get(n) if isinstance(o, dict) else getattr(o, n, None)
        if v is not None:
            return v
    return default


def open_key(o):
    size = float(_attr(o, "original_size", "size", default=0)) - float(
        _attr(o, "size_matched", default=0) or 0
    )
    side = str(_attr(o, "side", default="")).upper().replace("SIDE.", "")
    return (
        str(_attr(o, "asset_id", "token_id", default="")),
        side,
        round(float(_attr(o, "price", default=0)), 4),
        int(size),
    )


class Executor:
    def __init__(self):
        self.client = None
        self.hb_id = ""
        self.stop = asyncio.Event()
        self.engine = None
        self.resting = {}  # key → {"id", "market", "token"}
        self.pnl0 = None
        self.have_pos = False
        self.last_engine = time.time()
        self.lock = (
            asyncio.Lock()
        )  # one order sync at a time; pulls jump the queue via cancel-only path
        self.stats = {
            "pulls": 0,
            "placed": 0,
            "cancelled": 0,
            "rejected": 0,
            "fills": 0,
            "pull_ms": [],
            "fill_ms": [],
        }
        self.pos = {}
        self.last_fill = 0.0
        self.seen_fills = set()

    # ------------------------------------------------------------ exchange
    async def connect(self):
        if not LIVE:
            log("[dry-run] nothing will be sent. Set LIVE=1 to trade.")
            return
        from polymarket import AsyncSecureClient  # pip install polymarket-client

        kw = {"private_key": os.environ["POLYMARKET_PRIVATE_KEY"]}
        if WALLET:
            kw["wallet"] = WALLET
        self.client = await AsyncSecureClient.create(**kw)
        log("connected · wallet type", getattr(self.client, "wallet_type", "?"))
        await self.reconcile()

    async def heartbeat(self):
        if not LIVE:
            return
        from polymarket import OrderHeartbeatMismatchError

        while not self.stop.is_set():
            try:
                try:
                    hb = await self.client.send_order_heartbeat(heartbeat_id=self.hb_id)
                except OrderHeartbeatMismatchError as e:
                    hb = await self.client.send_order_heartbeat(
                        heartbeat_id=e.heartbeat_id
                    )
                self.hb_id = hb.heartbeat_id
            except Exception as e:  # noqa: BLE001 — keep the dead-man switch alive through blips
                log("[heartbeat]", type(e).__name__, e)
                self.hb_id = ""
            await asyncio.sleep(5)

    async def reconcile(self):
        """Exchange truth → in-memory book (fills shrink or remove resting orders)."""
        if not LIVE:
            return
        fresh = {}
        async for page in self.client.list_open_orders():
            for o in page.items:
                fresh[open_key(o)] = {
                    "id": _attr(o, "id", "order_id"),
                    "market": None,
                    "token": str(_attr(o, "asset_id", "token_id", default="")),
                }
        for k, v in fresh.items():
            if k in self.resting:
                v["market"] = self.resting[k]["market"]
        self.resting = fresh

    async def cancel_ids(self, ids):
        ids = [i for i in ids if i]
        if not ids:
            return
        self.stats["cancelled"] += len(ids)
        if LIVE:
            r = await self.client.cancel_orders(order_ids=ids)
            bad = _attr(r, "not_canceled", default=None)
            if bad:
                log("  ! not cancelled", bad)

    async def place_batch(self, orders):
        if not LIVE:
            for o in orders:
                self.resting[key(o)] = {
                    "id": f"dry-{len(self.resting)}",
                    "market": o["market"],
                    "token": o["token"],
                }
            self.stats["placed"] += len(orders)
            return
        try:  # batch: sign locally, one request for up to 15
            signed = await asyncio.gather(
                *[
                    self.client.create_limit_order(
                        asset_id=o["token"],
                        side=o["side"],
                        price=f"{o['price']:.3f}",
                        size=f"{o['size']}",
                        post_only=True,
                    )
                    for o in orders
                ]
            )
            res = await self.client.post_orders(list(signed))
        except (
            AttributeError,
            TypeError,
        ) as e:  # SDK without batch / different signature → concurrent singles
            log("  batch unavailable, placing singly:", e)
            res = await asyncio.gather(
                *[
                    self.client.place_limit_order(
                        asset_id=o["token"],
                        side=o["side"],
                        price=f"{o['price']:.3f}",
                        size=f"{o['size']}",
                        post_only=True,
                    )
                    for o in orders
                ]
            )
        for o, r in zip(orders, res):
            if getattr(r, "ok", False):
                self.resting[key(o)] = {
                    "id": r.order_id,
                    "market": o["market"],
                    "token": o["token"],
                }
                self.stats["placed"] += 1
            else:
                self.stats["rejected"] += 1
                log(
                    "  REJECTED",
                    o["side"],
                    o["size"],
                    "@",
                    o["price"],
                    o["question"][:40],
                    getattr(r, "code", ""),
                    getattr(r, "message", ""),
                )

    async def cancel_all(self, why):
        log("CANCEL ALL —", why)
        if LIVE and self.client:
            try:
                await self.client.cancel_all()
            except Exception as e:  # noqa: BLE001 — last resort: tell the operator
                log("cancel_all FAILED — check open orders on polymarket.com:", e)
        self.resting.clear()

    # ------------------------------------------------------------ own fills (user channel)
    def apply_fill(self, order_id, asset, side, amount):
        """Instant inventory + resting-order update when one of our maker orders is matched."""
        k = next((k for k, v in self.resting.items() if v["id"] == order_id), None)
        if k is None:
            return False
        amt = float(amount)
        self.pos[str(asset)] = self.pos.get(str(asset), 0.0) + (amt if side.upper() == "BUY" else -amt)
        v = self.resting.pop(k)
        left = k[3] - int(round(amt))
        if left >= 1:
            self.resting[(k[0], k[1], k[2], left)] = v
        self.last_fill = time.time()
        self.stats["fills"] += 1
        return True

    async def on_trade(self, p):
        if str(_attr(p, "status", default="")).upper() not in ("MATCHED", "MINED", "CONFIRMED"):
            return
        hit = False
        for mo in _attr(p, "maker_orders", default=()) or ():
            oid = _attr(mo, "order_id")
            tag = (str(_attr(p, "id")), str(oid))
            if tag in self.seen_fills:
                continue
            amt = _attr(mo, "matched_amount", default=0)
            if self.apply_fill(oid, _attr(mo, "asset_id"), str(_attr(mo, "side", default="")), amt):
                self.seen_fills.add(tag)
                hit = True
                log(f"FILL {_attr(mo, 'side')} {float(amt):.0f} @ {_attr(mo, 'price')} · asset …{str(_attr(mo, 'asset_id'))[-6:]}")
        if hit:
            t0 = time.time()
            await self.send({"type": "positions", "pos": self.pos, "kick": True})  # engine requotes in ~150 ms
            self.stats["fill_ms"].append((time.time() - t0) * 1000)

    async def user_stream(self):
        if not LIVE:
            return
        from polymarket.streams import UserSpec

        while not self.stop.is_set():
            try:
                async with await self.client.subscribe(UserSpec()) as stream:
                    async with self.lock:
                        await self.reconcile()  # the stream doesn't replay what was missed while disconnected
                    log("user stream connected (instant fills)")
                    async for ev in stream:
                        if getattr(ev, "type", None) == "trade":
                            await self.on_trade(ev.payload)
            except Exception as e:  # noqa: BLE001 — reconnect; the positions poll still covers us
                log("[user stream]", type(e).__name__, e)
                await asyncio.sleep(2)

    # ------------------------------------------------------------ engine messages
    async def on_pull(self, m):
        t_recv = time.time()
        toks = set(m.get("tokens") or [])
        ks = [
            k
            for k, v in self.resting.items()
            if v["token"] in toks or v["market"] == m.get("market")
        ]
        if not ks:
            return
        await self.cancel_ids([self.resting[k]["id"] for k in ks])
        for k in ks:
            self.resting.pop(k, None)
        lat = (time.time() * 1000 - m["t"]), (time.time() - t_recv) * 1000
        self.stats["pulls"] += 1
        self.stats["pull_ms"].append(lat[0])
        log(
            f"PULL {len(ks)} orders · {m.get('reason')} · signal→cancelled {lat[0]:.0f} ms (exchange {lat[1]:.0f} ms)"
        )

    async def on_orders(self, m):
        if not self.have_pos:
            return
        orders = m["orders"]
        cost = sum(o["price"] * o["size"] for o in orders if o["side"] == "BUY")
        if cost > MAX_USDC * 1.05:
            await self.cancel_all(
                f"engine asked for ${cost:.2f} BUY collateral > cap ${MAX_USDC}"
            )
            return
        want = {key(o): o for o in orders}
        async with self.lock:
            stale = [k for k in self.resting if k not in want]
            new = [o for k, o in want.items() if k not in self.resting]
            if not stale and not new:
                return
            t0 = time.time()
            # cancel first (frees collateral), then place in concurrent batches
            await self.cancel_ids([self.resting[k]["id"] for k in stale])
            for k in stale:
                self.resting.pop(k, None)
            await asyncio.gather(
                *[
                    self.place_batch(new[i : i + BATCH])
                    for i in range(0, len(new), BATCH)
                ]
            )
            tag = "" if LIVE else "[dry] "
            log(
                f"{tag}sync: cancel {len(stale)} · place {len(new)} · keep {len(want) - len(new)} · BUY collateral ${cost:.2f} · {(time.time() - t0) * 1000:.0f} ms · engine {m.get('engineMs')} ms"
            )
            for o in new[:6] if not LIVE else []:
                log(
                    f"   [dry] {o['side']:<4} {o['size']:>4} @ {o['price']:.3f} [{o['leg']}] {o['question'][:50]}"
                )

    async def read_engine(self):
        while not self.stop.is_set():
            line = await self.engine.stdout.readline()
            if not line:
                log("engine exited")
                self.stop.set()
                break
            self.last_engine = time.time()
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            ty = m.get("type")
            if ty == "pull":
                asyncio.create_task(self.on_pull(m))  # never wait behind a sync
            elif ty == "orders":
                for line_ in m.get("log", [])[-8:]:
                    log("  engine:", line_[:150])
                asyncio.create_task(self.on_orders(m))
            elif ty == "info":
                log("  engine:", m.get("msg"))

    async def send(self, obj):
        self.engine.stdin.write((json.dumps(obj) + "\n").encode())
        await self.engine.stdin.drain()

    async def positions_loop(self):
        last_rec = time.time()
        while not self.stop.is_set():
            try:
                pos, pnl = await asyncio.to_thread(fetch_positions)
                if self.pnl0 is None:
                    self.pnl0 = pnl
                if pnl - self.pnl0 < -MAX_LOSS:
                    await self.cancel_all(
                        f"loss limit: P&L {pnl - self.pnl0:+.2f} < -{MAX_LOSS}"
                    )
                    self.stop.set()
                    break
                # the data-api lags the matching engine: while fills are fresh, the streamed inventory wins
                if time.time() - self.last_fill > 60 or not self.have_pos:
                    self.pos = pos
                await self.send({"type": "positions", "pos": self.pos})
                self.have_pos = True
            except Exception as e:  # noqa: BLE001 — positions are retried; orders wait until we have them
                log("[positions]", e)
            if time.time() - self.last_engine > 30 and self.resting:
                await self.cancel_all("engine silent > 30 s")
            if time.time() - last_rec > RECONCILE_SEC:
                last_rec = time.time()
                try:
                    async with self.lock:
                        await self.reconcile()
                except Exception as e:  # noqa: BLE001
                    log("[reconcile]", e)
            await asyncio.sleep(POS_SEC)

    async def run(self):
        await self.connect()
        env = dict(os.environ)
        self.engine = await asyncio.create_subprocess_exec(
            "node",
            str(HERE / "engine_server.js"),
            str(STATE),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            env=env,
            limit=1 << 22,
        )
        await self.send(
            {
                "type": "config",
                "capital": MAX_USDC,
                "params": {"maxMarkets": MAX_MARKETS},
            }
        )
        tasks = [
            asyncio.create_task(c)
            for c in (self.heartbeat(), self.read_engine(), self.positions_loop(), self.user_stream())
        ]
        if RUN_SEC:
            asyncio.get_running_loop().call_later(RUN_SEC, self.stop.set)
        try:
            await self.stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            await self.cancel_all("shutdown")
            if self.engine.returncode is None:
                self.engine.terminate()
            p = sorted(self.stats["pull_ms"])
            log(
                f"stats: placed {self.stats['placed']} · cancelled {self.stats['cancelled']} · rejected {self.stats['rejected']} · pulls {self.stats['pulls']}"
                + (
                    f" · pull latency p50 {p[len(p) // 2]:.0f} ms max {p[-1]:.0f} ms"
                    if p
                    else ""
                )
            )


def main():
    if LIVE and not os.environ.get("POLYMARKET_PRIVATE_KEY"):
        sys.exit("LIVE=1 needs POLYMARKET_PRIVATE_KEY in the environment")
    ex = Executor()
    loop = asyncio.new_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, ex.stop.set)
        except NotImplementedError:
            pass
    loop.run_until_complete(ex.run())


if __name__ == "__main__":
    main()
