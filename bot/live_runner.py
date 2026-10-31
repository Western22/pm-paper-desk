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
import collections
import contextlib
import json
import math
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
# compounding: the cap follows the account's real value (cash + positions − $2 buffer), so rewards and banked
# gains go back to work the same day and losses shrink the book. COMPOUND_MAX is a hard ceiling.
COMPOUND = os.environ.get("COMPOUND", "1") != "0"
COMPOUND_MAX = float(os.environ.get("COMPOUND_MAX", "500"))
# sell-immediately in the executor itself (no engine round-trip): after a BUY fill, sell the shares at once
# with a marketable limit no lower than fill price − FLATTEN_SLIP_C (it executes at the best bids above that)
FLATTEN = os.environ.get("FLATTEN", "1") != "0"
FLATTEN_SLIP_C = float(os.environ.get("FLATTEN_SLIP_C", "6"))
MAX_LOSS = float(os.environ.get("MAX_LOSS_USDC", "15"))
MAX_MARKETS = int(os.environ.get("MAX_MARKETS", "8"))
# diversify: no market gets more than this share of capital (0 = let the optimiser concentrate)
SPREAD_FRAC = float(os.environ.get("SPREAD_FRAC", "0.3"))
# holdings poll; fills arrive instantly on the user stream, so 10 s is plenty (5 s hit data-api 429s)
POS_SEC = float(os.environ.get("POS_SEC", "10"))
RECONCILE_SEC = 60.0
DASH_HOST = os.environ.get(
    "DASH_HOST", "127.0.0.1"
)  # local only: view through an SSH tunnel
DASH_PORT = int(os.environ.get("DASH_PORT", "8080"))
RUN_SEC = float(
    os.environ.get("RUN_SEC", "0")
)  # >0: stop after this many seconds (tests)
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
STATE = Path(os.environ.get("LIVE_STATE", HERE / "run" / "live-state.json"))
DATA = "https://data-api.polymarket.com"
BATCH = 15


EVENTS = collections.deque(maxlen=400)  # recent log lines for the live dashboard
LOCATION = {"info": "not checked (dry run)"}
POSITION_ROWS = []  # latest wallet positions (data-api), for the dashboard
ACCOUNT = {}  # the account as Polymarket reports it (value, cash, rewards, activity) — for the dashboard
NET_DEPOSITS = float(
    os.environ.get("NET_DEPOSITS_USDC", "0") or 0
)  # what you put in, for P&L vs deposits
REWARD_TYPES = {"REWARD", "MAKER_REBATE", "LIQUIDITY_REWARD"}


def log(*a):
    line = " ".join(str(x) for x in a)
    EVENTS.append({"t": time.time(), "msg": line})
    print(time.strftime("%H:%M:%S"), line, flush=True)


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
    POSITION_ROWS.clear()
    POSITION_ROWS.extend(
        {
            "asset": str(p.get("asset")),
            "title": p.get("title"),
            "outcome": p.get("outcome"),
            "size": float(p.get("size") or 0),
            "avg": float(p.get("avgPrice") or 0),
            "cur": float(p.get("curPrice") or 0),
            "pnl": float(p.get("cashPnl") or 0),
            "redeemable": bool(p.get("redeemable")),
        }
        for p in rows
        if float(p.get("size") or 0) > 0
    )
    return pos, pnl


def summarize_account(value_rows, activity, cash=None, net_deposits=0.0, now=None):
    """Polymarket's own numbers: positions value (/value), rewards and trades (/activity), cash (exchange)."""
    now = now or time.time()
    day0 = (
        now - now % 86400
    )  # 00:00 UTC — rewards for the previous day land just after it
    pos_value = sum(float(v.get("value") or 0) for v in value_rows or [])
    # any reward-like type counts (REWARD, MAKER_REBATE, …) — the API's naming isn't documented
    rew = [
        a
        for a in activity
        if str(a.get("type", "")).upper() in REWARD_TYPES
        or "REWARD" in str(a.get("type", "")).upper()
        or "REBATE" in str(a.get("type", "")).upper()
    ]
    dep = sum(
        float(a.get("usdcSize") or 0)
        for a in activity
        if str(a.get("type", "")).upper() == "DEPOSIT"
    )
    wd = sum(
        float(a.get("usdcSize") or 0)
        for a in activity
        if str(a.get("type", "")).upper() == "WITHDRAW"
    )
    net = net_deposits or (dep - wd)
    total = None if cash is None else cash + pos_value
    return {
        "at": now,
        "positionsValue": round(pos_value, 2),
        "cash": None if cash is None else round(cash, 2),
        "total": None if total is None else round(total, 2),
        "netDeposits": round(net, 2) if net else None,
        "pnl": round(total - net, 2) if total is not None and net else None,
        "rewardsToday": round(
            sum(
                float(a.get("usdcSize") or 0)
                for a in rew
                if float(a.get("timestamp") or 0) >= day0
            ),
            2,
        ),
        "rewardsAll": round(sum(float(a.get("usdcSize") or 0) for a in rew), 2),
        "activity": [
            {
                "t": int(a.get("timestamp") or 0),
                "type": str(a.get("type", "")),
                "side": a.get("side") or "",
                "title": a.get("title") or "",
                "outcome": a.get("outcome") or "",
                "size": round(float(a.get("size") or 0), 2),
                "price": round(float(a.get("price") or 0), 3),
                "usdc": round(float(a.get("usdcSize") or 0), 2),
            }
            for a in activity[:30]
        ],
    }


def compound_cap(total, current, buffer=2.0):
    """New cap from the account's value, or None when compounding is off / value unknown."""
    if not COMPOUND or total is None:
        return None
    return round(max(5.0, min(COMPOUND_MAX, total - buffer)), 2)


def parse_cash(r):
    """Collateral balance from whatever the SDK returns (number, object or dict; base units → dollars)."""
    for v in (
        r,
        getattr(r, "balance", None),
        r.get("balance") if isinstance(r, dict) else None,
    ):
        if v is None or isinstance(v, bool):
            continue
        try:
            x = float(v)
        except (TypeError, ValueError):
            continue
        # collateral has 6 decimals: an integer-looking amount above 10 000 is base units
        return x / 1e6 if ("." not in str(v) and x > 1e4) else x
    return None


def loss_baseline(pnl, path=None):
    """Starting P&L for the loss limit, saved to disk on first use so restarts don't reset the limit.
    Delete the file (or set a new MAX_LOSS_USDC) to start counting afresh."""
    p = Path(
        path
        or os.environ.get("LOSS_BASELINE_FILE", STATE.parent / "loss-baseline.json")
    )
    try:
        return float(json.loads(p.read_text())["pnl0"])
    except (OSError, ValueError, KeyError, TypeError):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(
                {
                    "pnl0": pnl,
                    "since": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
                }
            )
        )
        log(f"loss limit: counting from P&L {pnl:+.2f} (saved to {p})")
        return pnl


def losers(rows, usd=1.0, frac=0.15):
    """Assets whose held position is losing: ≥ $usd down, or price ≥ frac below cost (and ≥ $0.30 down)."""
    return [
        r["asset"]
        for r in rows
        if r["pnl"] <= -usd
        or (r["avg"] > 0 and r["cur"] / r["avg"] - 1 <= -frac and r["pnl"] <= -0.3)
    ]


# sell held shares as soon as the price is this many cents above cost — bank any gain before it turns
TP_MIN_C = float(os.environ.get("TAKE_PROFIT_C", "2"))
TP_USD = float(
    os.environ.get("TAKE_PROFIT_USD", "1")
)  # …or once the whole position is up this many dollars


def winners(rows, min_c=TP_MIN_C, usd=TP_USD):
    """Held positions trading ≥ min_c ¢ above cost → [{asset, avg}]; the engine sells them at the live best bid
    if that bid still clears cost + min_c (the data-api price lags, the bid decides)."""
    return [
        {"asset": r["asset"], "avg": r["avg"]}
        for r in rows
        if r["avg"] > 0
        and r["size"] >= 1
        and ((r["cur"] - r["avg"]) * 100 >= min_c - 1 or r["pnl"] >= usd * 0.8)
    ]


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
        self.blocked = None  # set when the exchange refuses this wallet → stop placing
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
        # dashboard state
        self.started = time.time()
        self.pnl = 0.0
        self.markets = []
        self.cost = 0.0
        self.last_hb_ok = 0.0
        self.last_sync = 0.0
        self.paper = None

    # ------------------------------------------------------------ exchange
    async def connect(self):
        if not LIVE:
            log("[dry-run] nothing will be sent. Set LIVE=1 to trade.")
            return
        from polymarket import AsyncSecureClient  # pip install polymarket-client

        kw = {"private_key": os.environ["POLYMARKET_PRIVATE_KEY"]}
        if WALLET:
            kw["wallet"] = WALLET
        # optional Relayer API key (polymarket.com → Settings → API Keys → Relayer API Keys): enables gasless
        # wallet operations such as trading approvals; order signing itself only needs the signer key
        rk, ra = (
            os.environ.get("POLYMARKET_RELAYER_API_KEY"),
            os.environ.get("POLYMARKET_RELAYER_API_KEY_ADDRESS"),
        )
        if rk and ra:
            from polymarket import RelayerApiKey

            kw["api_key"] = RelayerApiKey(key=rk, address=ra)
        self.client = await AsyncSecureClient.create(**kw)
        log("connected · wallet type", getattr(self.client, "wallet_type", "?"))
        # public addresses only — lets you match them against your polymarket.com profile
        log(
            "  signer",
            getattr(self.client, "signer", "?"),
            "· trading wallet",
            getattr(self.client, "wallet", None)
            or getattr(self.client, "address", "?"),
        )
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
                self.last_hb_ok = time.time()
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
        try:
            res = await self._send(orders)
        except Exception as e:  # noqa: BLE001 — exchange said no: log it, never crash the loop
            self.stats["rejected"] += len(orders)
            msg = str(e)
            log(f"REJECTED batch of {len(orders)}: {msg}")
            if "deposit wallet" in msg or "maker address not allowed" in msg:
                self.blocked = (
                    "Polymarket refuses orders from this wallet. Set POLYMARKET_WALLET_ADDRESS to the address shown "
                    "on your polymarket.com profile (your deposit wallet, where the $ sits), then: systemctl restart pm-live"
                )
                log("CONFIG ERROR —", self.blocked)
            elif "address of the API KEY" in msg:
                self.blocked = (
                    "the API key belongs to a different address than the signer. Comment out POLYMARKET_RELAYER_API_KEY "
                    "and POLYMARKET_RELAYER_API_KEY_ADDRESS in /etc/pm-desk/env (the bot derives its own key), then restart"
                )
                log("CONFIG ERROR —", self.blocked)
            return
        self._record(orders, res)

    async def _send(self, orders):
        try:  # batch: sign locally, one request for up to 15
            signed = await asyncio.gather(
                *[
                    self.client.create_limit_order(
                        asset_id=o["token"],
                        side=o["side"],
                        price=f"{o['price']:.3f}",
                        size=f"{o['size']}",
                        post_only=not o.get(
                            "taker"
                        ),  # take-profit exits cross the spread
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
                        post_only=not o.get(
                            "taker"
                        ),  # take-profit exits cross the spread
                    )
                    for o in orders
                ]
            )
        return res

    def _record(self, orders, res):
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
        self.pos[str(asset)] = self.pos.get(str(asset), 0.0) + (
            amt if side.upper() == "BUY" else -amt
        )
        v = self.resting.pop(k)
        left = k[3] - round(amt)
        if left >= 1:
            self.resting[(k[0], k[1], k[2], left)] = v
        self.last_fill = time.time()
        self.stats["fills"] += 1
        return True

    async def operator_sells(self):
        """Sell on request: put words from a market's title in /opt/pm-desk/run/sell.txt (one per line, or ALL);
        every held position whose title matches is sold now at the best bids (floor: current price − 6¢)."""
        f = Path(os.environ.get("SELL_FILE", STATE.parent / "sell.txt"))
        if not f.exists():
            return
        words = [w.strip().lower() for w in f.read_text().splitlines() if w.strip()]
        f.replace(f.with_suffix(".done"))
        hits = [
            r
            for r in POSITION_ROWS
            if r["size"] >= 5
            and any(w == "all" or w in str(r.get("title") or "").lower() for w in words)
        ]
        if not hits:
            log(f"[sell] nothing held matches {words}")
            return
        self.manual = getattr(self, "manual", {})
        for r in hits:
            n = int(self.pos.get(r["asset"], r["size"]))
            floor = max(0.01, math.floor((r["cur"] - FLATTEN_SLIP_C / 100) * 100) / 100)
            o = {
                "token": r["asset"],
                "side": "SELL",
                "price": floor,
                "size": n,
                "market": "",
                "question": r.get("title") or "",
                "leg": "manual",
                "taker": True,
            }
            async with self.lock:
                await self.place_batch([o])
            self.manual[key(o)] = time.time()
            log(
                f"[sell] {n} × {str(r.get('title'))[:50]} {r.get('outcome')} · limit ≥ {floor:.2f} (now {r['cur']}, cost {r['avg']})"
            )

    def flatten_soon(self, asset, fill_price):
        """Fire-and-forget sell of everything held in `asset` (one in flight per asset)."""
        self.flattening = getattr(self, "flattening", set())
        if asset in self.flattening:
            return
        self.flattening.add(asset)
        task = asyncio.create_task(self.flatten_now(asset, fill_price))
        task.add_done_callback(lambda _t: self.flattening.discard(asset))

    async def flatten_now(self, asset, fill_price):
        """Sell the shares a fill just gave us, now: a SELL limit at fill − slip executes against the best bids
        (CLOB gives the taker the makers' prices), so the real price is usually the bid, 1–3¢ under the fill."""
        await asyncio.sleep(
            0.05
        )  # let partial-fill messages for the same order land first
        n = int(self.pos.get(asset, 0.0))
        if n < 5:
            return
        floor = max(0.01, math.floor((fill_price - FLATTEN_SLIP_C / 100) * 100) / 100)
        m = next(
            (m for m in self.markets or [] if asset in (m.get("tokens") or [])), {}
        )
        o = {
            "token": asset,
            "side": "SELL",
            "price": floor,
            "size": n,
            "market": m.get("id", ""),
            "question": m.get("q", "") or "",
            "leg": "flatten",
            "taker": True,
        }
        t0 = time.time()
        async with self.lock:
            await self.place_batch([o])
        log(
            f"SELL NOW {n} (limit ≥ {floor:.2f}, filled @ {fill_price}) · {(time.time() - t0) * 1000:.0f} ms"
        )

    async def on_trade(self, p):
        if str(_attr(p, "status", default="")).upper() not in (
            "MATCHED",
            "MINED",
            "CONFIRMED",
        ):
            return
        hit = False
        for mo in _attr(p, "maker_orders", default=()) or ():
            oid = _attr(mo, "order_id")
            tag = (str(_attr(p, "id")), str(oid))
            if tag in self.seen_fills:
                continue
            amt = _attr(mo, "matched_amount", default=0)
            if self.apply_fill(
                oid, _attr(mo, "asset_id"), str(_attr(mo, "side", default="")), amt
            ):
                self.seen_fills.add(tag)
                hit = True
                if FLATTEN and str(_attr(mo, "side", default="")).upper() == "BUY":
                    with contextlib.suppress(TypeError, ValueError):
                        self.flatten_soon(
                            str(_attr(mo, "asset_id")), float(_attr(mo, "price"))
                        )
                # engine measures the adverse move after each fill to calibrate the fill cost it plans with
                with contextlib.suppress(TypeError, ValueError):
                    await self.send(
                        {
                            "type": "fill",
                            "asset": str(_attr(mo, "asset_id")),
                            "side": str(_attr(mo, "side", default="")).upper(),
                            "price": float(_attr(mo, "price")),
                            "size": float(amt),
                        }
                    )
                log(
                    f"FILL {_attr(mo, 'side')} {float(amt):.0f} @ {_attr(mo, 'price')} · asset …{str(_attr(mo, 'asset_id'))[-6:]}"
                )
        # our own marketable orders (take-profit / sell-immediately) fill as the TAKER: track those too, or the
        # engine keeps trying to sell shares that are already gone until the data-api catches up
        tid = _attr(p, "taker_order_id", default=None)
        if tid:
            tag = (str(_attr(p, "id")), str(tid))
            if tag not in self.seen_fills and self.apply_fill(
                tid,
                _attr(p, "asset_id"),
                str(_attr(p, "side", default="")),
                _attr(p, "size", default=0),
            ):
                self.seen_fills.add(tag)
                hit = True
                log(
                    f"FILL (taker) {_attr(p, 'side')} {float(_attr(p, 'size', default=0)):.0f} @ {_attr(p, 'price')} · asset …{str(_attr(p, 'asset_id'))[-6:]}"
                )
        if hit:
            t0 = time.time()
            await self.send(
                {"type": "positions", "pos": self.pos, "kick": True}
            )  # engine requotes in ~150 ms
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
        if not self.have_pos or self.blocked:
            return
        orders = m["orders"]
        self.markets = m.get("markets") or self.markets
        cost = sum(o["price"] * o["size"] for o in orders if o["side"] == "BUY")
        self.cost = cost
        self.last_sync = time.time()
        if cost > MAX_USDC * 1.05:
            await self.cancel_all(
                f"engine asked for ${cost:.2f} BUY collateral > cap ${MAX_USDC}"
            )
            return
        want = {key(o): o for o in orders}
        async with self.lock:
            manual = getattr(
                self, "manual", {}
            )  # operator sell orders: the engine doesn't know them, keep 10 min
            stale = [
                k
                for k in self.resting
                if k not in want and time.time() - manual.get(k, 0) > 600
            ]
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
                    if (
                        "] REQUOTE " in line_
                    ):  # routine re-pricing: order changes show up as "sync" lines
                        continue
                    log("  engine:", line_[:150])
                asyncio.create_task(self.on_orders(m))
            elif ty == "info":
                log("  engine:", m.get("msg"))

    async def paper_loop(self):
        """Paper account totals (public ledger), refreshed every 5 min for the live-vs-paper panel."""
        url = "https://raw.githubusercontent.com/Western22/pm-paper-desk/paper-state/ledger.json"
        while not self.stop.is_set():
            try:
                d = await asyncio.to_thread(get_json, url, 20)
                self.paper = {
                    "totals": d.get("totals"),
                    "history": (d.get("history") or [])[-7:],
                    "at": time.time(),
                }
            except Exception as e:  # noqa: BLE001 — comparison panel only
                log("[paper]", e)
            await asyncio.sleep(300)

    async def send(self, obj):
        self.engine.stdin.write((json.dumps(obj) + "\n").encode())
        await self.engine.stdin.drain()

    async def cash(self):
        """Exchange collateral balance via the SDK (method name differs between versions; first one that works wins)."""
        if not LIVE or not self.client:
            return None
        names = (
            [self._cash_fn]
            if getattr(self, "_cash_fn", None)
            else [
                "get_collateral_balance",
                "get_balance",
                "get_usdc_balance",
                "get_balance_allowance",
                "balance",
            ]
        )
        for n in names:
            fn = getattr(self.client, n, None)
            if not callable(fn):
                continue
            try:
                r = fn()
                if asyncio.iscoroutine(r):
                    r = await r
                x = parse_cash(r)
            except Exception:  # noqa: BLE001, S112 — wrong signature for this SDK: try the next name
                continue
            if x is not None:
                if getattr(self, "_cash_fn", None) != n:
                    log(f"[account] cash balance via client.{n}()")
                self._cash_fn = n
                return x
        if not getattr(self, "_cash_warned", False):
            self._cash_warned = True
            log(
                "[account] cash balance not available from this SDK — showing positions value and rewards only"
            )
        return None

    async def compound(self):
        """Cap = real account value − $2 (rewards and banked gains go straight back to work; losses shrink it)."""
        global MAX_USDC
        cap = compound_cap(ACCOUNT.get("total"), MAX_USDC)
        if cap is None or abs(cap - MAX_USDC) < 1:
            return
        log(
            f"[compound] cap ${MAX_USDC:.2f} → ${cap:.2f} (account ${ACCOUNT['total']:.2f})"
        )
        MAX_USDC = cap
        await self.send({"type": "config", "capital": MAX_USDC})

    async def account_loop(self):
        """Every 60 s: the account exactly as Polymarket reports it, for the live page."""
        while not self.stop.is_set():
            if WALLET:
                try:
                    q = urllib.parse.urlencode({"user": WALLET})
                    val = await asyncio.to_thread(get_json, f"{DATA}/value?{q}")
                    act = await asyncio.to_thread(
                        get_json,
                        f"{DATA}/activity?{urllib.parse.urlencode({'user': WALLET, 'limit': 500})}",
                    )
                    ACCOUNT.clear()
                    ACCOUNT.update(
                        summarize_account(
                            val if isinstance(val, list) else [val],
                            act if isinstance(act, list) else [],
                            await self.cash(),
                            NET_DEPOSITS,
                        )
                    )
                    await self.compound()
                except Exception as e:  # noqa: BLE001 — the page just shows the previous snapshot
                    log("[account]", e)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.stop.wait(), 60)

    async def positions_loop(self):
        last_rec = time.time()
        while not self.stop.is_set():
            try:
                pos, pnl = await asyncio.to_thread(fetch_positions)
                if self.pnl0 is None:
                    self.pnl0 = loss_baseline(pnl)
                self.pnl = pnl - self.pnl0
                if pnl - self.pnl0 < -MAX_LOSS:
                    await self.cancel_all(
                        f"loss limit: P&L {pnl - self.pnl0:+.2f} < -{MAX_LOSS}"
                    )
                    self.stop.set()
                    break
                # the data-api lags the matching engine: while fills are fresh, the streamed inventory wins
                if time.time() - self.last_fill > 60 or not self.have_pos:
                    self.pos = pos
                await self.send(
                    {
                        "type": "positions",
                        "pos": self.pos,
                        "losers": losers(POSITION_ROWS),
                        "winners": winners(POSITION_ROWS),
                    }
                )
                self.have_pos = True
            except Exception as e:  # noqa: BLE001 — positions are retried; orders wait until we have them
                log("[positions]", e)
            await self.operator_sells()
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
                "params": {"maxMarkets": MAX_MARKETS, "spreadFrac": SPREAD_FRAC},
            }
        )
        tasks = [
            asyncio.create_task(c)
            for c in (
                self.heartbeat(),
                self.read_engine(),
                self.positions_loop(),
                self.account_loop(),
                self.user_stream(),
                self.paper_loop(),
            )
        ]
        if DASH_PORT:
            from dashboard import serve  # bot/dashboard.py

            tasks.append(
                asyncio.create_task(
                    serve(self, DASH_HOST, DASH_PORT, sys.modules[__name__])
                )
            )
        if RUN_SEC:
            asyncio.get_running_loop().call_later(RUN_SEC, self.stop.set)
        try:
            await self.stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            await self.cancel_all("shutdown")
            await asyncio.gather(
                *tasks, return_exceptions=True
            )  # let cancelled tasks finish
            if self.engine.returncode is None:
                with contextlib.suppress(Exception):
                    self.engine.stdin.close()  # engine exits on stdin EOF
                self.engine.terminate()
                try:  # reap the child inside the loop, so nothing is cleaned up after it closes
                    await asyncio.wait_for(self.engine.wait(), 5)
                except asyncio.TimeoutError:
                    self.engine.kill()
                    await self.engine.wait()
            p = sorted(self.stats["pull_ms"])
            log(
                f"stats: placed {self.stats['placed']} · cancelled {self.stats['cancelled']} · rejected {self.stats['rejected']} · pulls {self.stats['pulls']}"
                + (
                    f" · pull latency p50 {p[len(p) // 2]:.0f} ms max {p[-1]:.0f} ms"
                    if p
                    else ""
                )
            )


# Polymarket restricts order placement by location (docs.polymarket.com/api-reference/geoblock).
# Countries/regions where the API is blocked or close-only — never trade live from these.
RESTRICTED = {
    "IR",
    "SY",
    "CU",
    "KP",
    "UA-43",
    "UA-14",
    "UA-09",
    "AR",
    "AU",
    "BY",
    "BE",
    "BI",
    "BR",
    "CA-BC",
    "CA-ON",
    "CA-AB",
    "CA-QC",
    "CF",
    "CD",
    "ET",
    "FR",
    "DE",
    "IQ",
    "IT",
    "LB",
    "LY",
    "MM",
    "NZ",
    "NI",
    "PL",
    "RU",
    "SG",
    "SO",
    "SK",
    "SS",
    "SD",
    "TW",
    "TH",
    "GB",
    "US",
    "UM",
    "VE",
    "YE",
    "ZW",
}


def geocheck():
    """(ok, info) from Polymarket's own geoblock endpoint for this machine's IP."""
    g = get_json("https://polymarket.com/api/geoblock")
    c, r = str(g.get("country", "")).upper(), str(g.get("region", "")).upper()
    bad = bool(g.get("blocked")) or c in RESTRICTED or f"{c}-{r}" in RESTRICTED
    return (
        not bad,
        f"{g.get('ip')} · {c}{'-' + r if r else ''} · blocked={g.get('blocked')}",
    )


def config_problems():
    """Format checks for live credentials (values are never printed)."""
    import re

    probs = []
    key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    if not re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", key):
        hint = " (looks like an API key — it has dashes)" if "-" in key else ""
        probs.append(
            f"POLYMARKET_PRIVATE_KEY is not a private key{hint}: expected 64 hex characters (0-9, a-f), optionally 0x-prefixed"
        )
    if WALLET and not re.fullmatch(r"0x[0-9a-fA-F]{40}", WALLET.strip()):
        probs.append(
            "POLYMARKET_WALLET_ADDRESS is not an address: expected 0x + 40 hex characters"
        )
    rk = os.environ.get("POLYMARKET_RELAYER_API_KEY", "").strip()
    if rk and re.fullmatch(r"0x[0-9a-fA-F]{40}", rk):
        probs.append(
            "POLYMARKET_RELAYER_API_KEY holds an address — it should be the Relayer API key (the value with dashes)"
        )
    return probs


def idle_on_config_error(probs):
    """Never trade with bad credentials, and don't crash-loop: explain, then wait for a fixed env + restart."""
    for p in probs:
        log("CONFIG ERROR —", p)
    log(
        "not trading. Fix /etc/pm-desk/env (or set LIVE=0), then: systemctl restart pm-live"
    )
    while True:
        time.sleep(3600)


def main():
    if LIVE:
        probs = config_problems()
        if probs:
            idle_on_config_error(probs)
    if LIVE:
        try:
            ok, info = geocheck()
        except Exception as e:  # noqa: BLE001 — can't verify location → don't trade
            sys.exit(f"geoblock check failed ({e}) — refusing to trade live")
        log("location:", info)
        LOCATION["info"] = info
        if not ok:
            sys.exit(
                f"Polymarket restricts trading from this location ({info}) — refusing to trade live. "
                "Run the server in an allowed region (e.g. Helsinki, Stockholm, Amsterdam, Madrid)."
            )
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
