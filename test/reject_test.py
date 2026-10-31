"""Exchange rejects a batch (wrong wallet): logged, counted, no crash, further placing stops."""

import asyncio
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py"
)
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)
lr.LIVE = True


class Client:
    calls = 0

    async def create_limit_order(self, **kw):
        return kw

    async def post_orders(self, signed):
        Client.calls += 1
        raise RuntimeError(
            "maker address not allowed, please use the deposit wallet flow"
        )


async def main():
    ex = lr.Executor()
    ex.client = Client()
    o = {
        "token": "Y",
        "side": "BUY",
        "price": 0.44,
        "size": 30,
        "market": "m",
        "question": "q",
        "leg": "bid",
    }
    await ex.place_batch([o])
    assert ex.stats["rejected"] == 1 and not ex.resting
    assert ex.blocked and "polymarket.com profile" in ex.blocked
    ex.have_pos = True
    await ex.on_orders({"orders": [o]})
    assert Client.calls == 1, "no more orders sent once blocked"
    print("reject ok")
    rows = [
        {"asset": "ben", "pnl": -5.5, "avg": 0.48, "cur": 0.205},
        {"asset": "oil", "pnl": -0.4, "avg": 0.14, "cur": 0.115},  # −18 %, −$0.40
        {"asset": "ok", "pnl": -0.2, "avg": 0.30, "cur": 0.29},
        {"asset": "up", "pnl": 2.0, "avg": 0.30, "cur": 0.40},
    ]
    assert lr.losers(rows) == ["ben", "oil"], lr.losers(rows)
    print("losers ok")
    import tempfile

    f = pathlib.Path(tempfile.mkdtemp()) / "b.json"
    assert lr.loss_baseline(-1.5, f) == -1.5, "first run saves the start"
    assert lr.loss_baseline(-9.0, f) == -1.5, (
        "restart keeps counting from the saved start"
    )
    print("baseline ok")
    rows = [
        {"asset": "gem", "size": 20, "pnl": 3.2, "avg": 0.24, "cur": 0.40},
        {
            "asset": "small",
            "size": 20,
            "pnl": 0.4,
            "avg": 0.50,
            "cur": 0.52,
        },  # +2¢: any gain counts now
        {"asset": "flat", "size": 20, "pnl": 0.0, "avg": 0.50, "cur": 0.50},
        {"asset": "down", "size": 20, "pnl": -1.0, "avg": 0.50, "cur": 0.45},
    ]
    assert [w["asset"] for w in lr.winners(rows)] == ["gem", "small"], lr.winners(rows)
    print("winners ok")
    # account summary from Polymarket's own data (31 Oct: $4.21 reward just after 00:00 UTC)
    act = [
        {"type": "REWARD", "usdcSize": 4.2124, "timestamp": 1793404810},
        {
            "type": "TRADE",
            "side": "SELL",
            "title": "ECB",
            "size": 20,
            "price": 0.24,
            "usdcSize": 4.8,
            "timestamp": 1793402026,
        },
        {"type": "REWARD", "usdcSize": 1.0, "timestamp": 1793300000},  # yesterday
        {"type": "DEPOSIT", "usdcSize": 19.3, "timestamp": 1793346822},
    ]
    a = lr.summarize_account(
        [{"value": 7.1}], act, cash=52.0, net_deposits=70.3, now=1793405000
    )
    assert (a["total"], a["pnl"], a["rewardsToday"], a["rewardsAll"]) == (
        59.1,
        -11.2,
        4.21,
        5.21,
    ), a
    assert a["activity"][1]["side"] == "SELL" and len(a["activity"]) == 4
    b = lr.summarize_account([{"value": 7.1}], act, cash=None)
    assert b["total"] is None and b["netDeposits"] == 19.3 and b["pnl"] is None
    assert lr.parse_cash(52.31) == 52.31 and lr.parse_cash("52310000") == 52.31
    assert (
        lr.parse_cash({"balance": "52310000"}) == 52.31
        and lr.parse_cash(object()) is None
    )
    print("account ok")


asyncio.run(main())
