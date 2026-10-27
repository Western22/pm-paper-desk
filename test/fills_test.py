"""User-channel fill handling: instant inventory, resting-order shrink, dedupe, engine kick."""

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
    ex.resting = {
        ("Y", "BUY", 0.44, 30): {"id": "o1", "market": "m", "token": "Y"},
        ("N", "BUY", 0.53, 30): {"id": "o2", "market": "m", "token": "N"},
    }
    trade = {
        "id": "t1",
        "status": "MATCHED",
        "maker_orders": [
            {
                "order_id": "o1",
                "asset_id": "Y",
                "side": "BUY",
                "matched_amount": "12",
                "price": "0.44",
            },
            {
                "order_id": "someone-else",
                "asset_id": "Y",
                "side": "BUY",
                "matched_amount": "50",
                "price": "0.44",
            },
        ],
    }
    await ex.on_trade(trade)
    assert ex.pos == {"Y": 12.0}, ex.pos
    assert ("Y", "BUY", 0.44, 18) in ex.resting and (
        "Y",
        "BUY",
        0.44,
        30,
    ) not in ex.resting, ex.resting
    assert sent and sent[-1]["kick"] is True and sent[-1]["pos"] == {"Y": 12.0}
    # duplicate MINED / CONFIRMED updates of the same trade are not double counted
    await ex.on_trade(dict(trade, status="CONFIRMED"))
    assert ex.pos == {"Y": 12.0}, ex.pos
    # full fill removes the order; FAILED trades are ignored
    await ex.on_trade(
        {
            "id": "t2",
            "status": "FAILED",
            "maker_orders": [
                {
                    "order_id": "o2",
                    "asset_id": "N",
                    "side": "BUY",
                    "matched_amount": "30",
                }
            ],
        }
    )
    assert ("N", "BUY", 0.53, 30) in ex.resting
    await ex.on_trade(
        {
            "id": "t3",
            "status": "MATCHED",
            "maker_orders": [
                {
                    "order_id": "o2",
                    "asset_id": "N",
                    "side": "BUY",
                    "matched_amount": "30",
                }
            ],
        }
    )
    assert not any(v["id"] == "o2" for v in ex.resting.values()) and ex.pos["N"] == 30.0
    print("fills ok")


asyncio.run(main())
