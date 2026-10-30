"""Live credential format checks: catch the API-key-in-the-private-key-field mistake without printing secrets."""

import importlib.util
import os
import pathlib


def load(env):
    for k in (
        "POLYMARKET_PRIVATE_KEY",
        "POLYMARKET_WALLET_ADDRESS",
        "POLYMARKET_RELAYER_API_KEY",
    ):
        os.environ.pop(k, None)
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location(
        "lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py"
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


fake_key = "ab" * 32
ok = load(
    {
        "POLYMARKET_PRIVATE_KEY": "0x" + fake_key,
        "POLYMARKET_WALLET_ADDRESS": "0x" + "1" * 40,
        "POLYMARKET_RELAYER_API_KEY": "01a2b3c4-d5e6-7890-abcd-ef1234567890",
    }
)
assert ok.config_problems() == [], ok.config_problems()
assert (
    load(
        {
            "POLYMARKET_PRIVATE_KEY": fake_key,
            "POLYMARKET_WALLET_ADDRESS": "0x" + "1" * 40,
        }
    ).config_problems()
    == []
), "no 0x prefix is fine"
p = load(
    {
        "POLYMARKET_PRIVATE_KEY": "01a18a2e-0000-0000-0000-000000000000",
        "POLYMARKET_WALLET_ADDRESS": "0x" + "1" * 40,
    }
).config_problems()
assert len(p) == 1 and "dashes" in p[0] and "01a18a2e" not in p[0], p
p = load(
    {
        "POLYMARKET_PRIVATE_KEY": "0x" + fake_key,
        "POLYMARKET_WALLET_ADDRESS": "0x" + "1" * 40,
        "POLYMARKET_RELAYER_API_KEY": "0x" + "2" * 40,
    }
).config_problems()
assert len(p) == 1 and "Relayer" in p[0], p
assert (
    load({"POLYMARKET_PRIVATE_KEY": "", "POLYMARKET_WALLET_ADDRESS": "0x12"})
    .config_problems()
    .__len__()
    == 2
)
print("config ok")
