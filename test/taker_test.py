"""Our own marketable exit (sell-immediately) fills as the TAKER: inventory must drop at once."""

import asyncio
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py"
)
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)


async def main():
    ex = lr.Executor()
    sent = []

    async def send(obj):
        sent.append(obj)

    ex.send = send
    ex.pos = {"Y": 20.0}
    ex.resting = {("Y", "SELL", 0.3, 20): {"id": "exit1", "market": "m", "token": "Y"}}
    trade = {
        "id": "t9",
        "status": "MATCHED",
        "taker_order_id": "exit1",
        "asset_id": "Y",
        "side": "SELL",
        "size": "20",
        "price": "0.30",
        "maker_orders": [
            {
                "order_id": "someone",
                "asset_id": "Y",
                "side": "BUY",
                "matched_amount": "20",
                "price": "0.30",
            }
        ],
    }
    await ex.on_trade(trade)
    assert ex.pos["Y"] == 0.0 and not ex.resting, (ex.pos, ex.resting)
    assert sent and sent[-1]["type"] == "positions" and sent[-1]["kick"]
    assert not any(m["type"] == "fill" for m in sent), "taker exits are not maker fills"
    await ex.on_trade(trade)  # duplicate message → no double count
    assert ex.pos["Y"] == 0.0
    print("taker ok")

    # maker BUY fill of 21 NO @0.46 → executor itself sells 21 at once with a limit ≥ 0.40 (6¢ slip floor)
    ex2 = lr.Executor()
    ex2.send = send
    ex2.markets = [{"id": "m1", "q": "Russian diesel", "tokens": ["N", "Y2"]}]
    ex2.resting = {("N", "BUY", 0.46, 21): {"id": "b1", "market": "m1", "token": "N"}}
    placed = []

    async def place_batch(orders):
        placed.extend(orders)

    ex2.place_batch = place_batch
    fill = {
        "id": "t10",
        "status": "MATCHED",
        "maker_orders": [
            {
                "order_id": "b1",
                "asset_id": "N",
                "side": "BUY",
                "matched_amount": "21",
                "price": "0.46",
            }
        ],
    }
    await ex2.on_trade(fill)
    await asyncio.sleep(0.2)
    assert len(placed) == 1, placed
    o = placed[0]
    assert (o["token"], o["side"], o["size"], o["price"], o["taker"], o["market"]) == (
        "N",
        "SELL",
        21,
        0.4,
        True,
        "m1",
    ), o
    print("executor sell-immediately ok")

    # unsettled shares: first two sells rejected (balance 0), third goes through
    ex4 = lr.Executor()
    ex4.send = send
    ex4.markets = []
    ex4.pos = {"N": 9.0}
    tries = []

    async def place4(orders):
        tries.append(orders[0]["size"])
        if len(tries) <= 2:
            ex4.stats["rejected"] += 1

    ex4.place_batch = place4
    lr_sleep = asyncio.sleep

    async def fast_sleep(s):
        await lr_sleep(0)

    lr.asyncio.sleep = fast_sleep
    try:
        await ex4.flatten_now("N", 0.40)
    finally:
        lr.asyncio.sleep = lr_sleep
    assert tries == [9, 9, 9], tries
    print("settlement retry ok")

    # executor-side take-profit: Altman 25 @0.36 now 0.41 → sell with limit 0.37 (profit guaranteed), kept up
    lr.POSITION_ROWS[:] = [
        {
            "asset": "A1",
            "title": "Altman",
            "outcome": "Yes",
            "size": 25.0,
            "avg": 0.36,
            "cur": 0.41,
            "pnl": 1.25,
        },
        {
            "asset": "L1",
            "title": "loser",
            "outcome": "No",
            "size": 20.0,
            "avg": 0.50,
            "cur": 0.45,
            "pnl": -1.0,
        },
    ]
    ex5 = lr.Executor()
    ex5.send = send
    ex5.markets = []
    ex5.pos = {"A1": 25.0, "L1": 20.0}
    got = []

    async def place5(orders):
        got.extend(orders)

    ex5.place_batch = place5
    ex5.take_profits()
    await asyncio.sleep(0.2)
    assert [(o["token"], o["side"], o["size"], o["price"]) for o in got] == [
        ("A1", "SELL", 25, 0.37)
    ], got
    assert lr.key(got[0]) in ex5.manual, (
        "a resting take-profit isn't cancelled by the engine sync"
    )
    print("executor take-profit ok")

    # cash via get_balance_allowance(asset_type=...) — the call the live SDK has
    class Bal:
        balance = "56090000"

    class Client:
        async def get_balance_allowance(self, asset_type):
            assert asset_type in ("COLLATERAL",), asset_type
            return Bal()

    lr.LIVE = True
    ex6 = lr.Executor()
    ex6.client = Client()
    try:
        assert await ex6.cash() == 56.09
        assert ex6._cash_fn == "get_balance_allowance" and ex6._cash_kw == {
            "asset_type": "COLLATERAL"
        }
        assert await ex6.cash() == 56.09, "second call reuses the working spelling"
    finally:
        lr.LIVE = False
    print("cash balance ok")

    # compounding cap follows the account value minus $2, within [5, COMPOUND_MAX]
    assert lr.compound_cap(59.8, 52) == 57.8
    assert lr.compound_cap(3.0, 52) == 5.0
    assert lr.compound_cap(None, 52) is None
    assert lr.compound_cap(10_000, 52) == lr.COMPOUND_MAX
    print("compound ok")

    # operator sell: "altman" in sell.txt → the 25 Altman YES are sold (limit ≥ cur − 6¢); file consumed
    import os
    import tempfile

    d = pathlib.Path(tempfile.mkdtemp())
    os.environ["SELL_FILE"] = str(d / "sell.txt")
    (d / "sell.txt").write_text("Altman\n")
    lr.POSITION_ROWS[:] = [
        {
            "asset": "A1",
            "title": "Will Trump meet with Sam Altman by November 30, 2026?",
            "outcome": "Yes",
            "size": 25.0,
            "avg": 0.36,
            "cur": 0.41,
            "pnl": 1.25,
        },
        {
            "asset": "B1",
            "title": "Will BTC close above $120k?",
            "outcome": "No",
            "size": 20.0,
            "avg": 0.5,
            "cur": 0.5,
            "pnl": 0.0,
        },
    ]
    ex3 = lr.Executor()
    ex3.pos = {"A1": 25.0, "B1": 20.0}
    sold = []

    async def place3(orders):
        sold.extend(orders)

    ex3.place_batch = place3
    await ex3.operator_sells()
    assert [(o["token"], o["side"], o["size"], o["price"]) for o in sold] == [
        ("A1", "SELL", 25, 0.35)
    ], sold
    assert not (d / "sell.txt").exists() and (d / "sell.done").exists()
    k = lr.key(sold[0])
    assert k in ex3.manual, "kept away from the engine's stale-order cancel"
    print("operator sell ok")


asyncio.run(main())


async def stale():
    # holdings feed down > 5 min → cancel everything once and stop syncing until it's back
    lr.LIVE = True
    ex = lr.Executor()
    ex.have_pos = True
    ex.pos_ok_at = lr.time.time() - 400
    ex.resting = {("Y", "BUY", 0.4, 20): {"id": "o1", "market": "m", "token": "Y"}}
    cancelled = []

    async def cancel_all(why):
        cancelled.append(why)
        ex.resting.clear()

    ex.cancel_all = cancel_all
    try:
        await ex.on_orders({"orders": [{"token": "Y", "side": "BUY", "price": 0.4, "size": 20}]})
        assert cancelled and "holdings feed down" in cancelled[0] and not ex.resting
        await ex.on_orders({"orders": [{"token": "Y", "side": "BUY", "price": 0.4, "size": 20}]})
        assert len(cancelled) == 1, "only once"
    finally:
        lr.LIVE = False
    print("stale holdings guard ok")


asyncio.run(stale())
