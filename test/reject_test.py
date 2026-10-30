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


asyncio.run(main())
