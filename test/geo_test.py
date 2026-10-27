"""Live trading refuses restricted locations (Polymarket geoblock: blocked or close-only)."""

import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py"
)
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)

cases = {
    ("FI", "18", False): True,  # Helsinki: allowed
    ("SE", "AB", False): True,  # Stockholm
    ("NL", "NH", False): True,  # Amsterdam: frontend-only restriction, API allowed
    ("DE", "HE", False): False,  # Frankfurt: close-only
    ("GB", "ENG", False): False,  # London: close-only
    ("US", "NY", False): False,
    ("CA", "ON", False): False,  # region-level rule
    ("CA", "NS", False): True,
    ("ES", "MD", True): False,  # endpoint says blocked → always refuse
}
for (c, r, blocked), want in cases.items():
    lr.get_json = lambda _url, c=c, r=r, blocked=blocked: {
        "blocked": blocked,
        "ip": "1.2.3.4",
        "country": c,
        "region": r,
    }
    ok, info = lr.geocheck()
    assert ok is want, (c, r, blocked, ok, info)
print("geo ok")
