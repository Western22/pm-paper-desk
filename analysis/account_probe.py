"""Check the live page's account summary against a real public wallet (no keys needed)."""

import importlib.util
import pathlib
import sys
import urllib.parse

spec = importlib.util.spec_from_file_location(
    "lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py"
)
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)
w = sys.argv[1]
val = lr.get_json(f"{lr.DATA}/value?{urllib.parse.urlencode({'user': w})}")
act = lr.get_json(
    f"{lr.DATA}/activity?{urllib.parse.urlencode({'user': w, 'limit': 500})}"
)
a = lr.summarize_account(val if isinstance(val, list) else [val], act)
print({k: v for k, v in a.items() if k != "activity"})
print(sorted({x["type"] for x in act}))
for x in a["activity"][:5]:
    print(" ", x)
