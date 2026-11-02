"""Executor reports yesterday's real payout once a day, >= 2 h after 00:00 UTC, even when it was $0."""

import asyncio
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location("lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py")
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)


async def main():
    ex = lr.Executor()
    sent = []

    async def send(o):
        sent.append(o)

    ex.send = send
    day0 = 1793404800  # 2026-10-31 00:00 UTC
    lr.ACCOUNT.clear()
    lr.ACCOUNT.update({"at": day0, "rewardsToday": 4.21})
    await ex.report_reward(day0 + 600)  # too early: payout may not have landed
    assert not sent
    await ex.report_reward(day0 + 7300)
    assert sent == [{"type": "rewardPaid", "usd": 4.21}], sent
    await ex.report_reward(day0 + 9000)  # once per day
    assert len(sent) == 1
    lr.ACCOUNT["rewardsToday"] = 0
    await ex.report_reward(day0 + 86400 + 7300)  # next day, nothing paid → still reported
    assert sent[-1] == {"type": "rewardPaid", "usd": 0.0}
    print("reward report ok")


asyncio.run(main())
