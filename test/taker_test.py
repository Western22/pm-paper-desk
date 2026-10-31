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


asyncio.run(main())
