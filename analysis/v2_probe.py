"""Check the v1→v2 data-API layer of the executor against a real public wallet."""
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("lr", pathlib.Path(__file__).parent.parent / "bot" / "live_runner.py")
lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
w = sys.argv[1]
lr.WALLET = w
pos, pnl = lr.fetch_positions()
print("positions", len(pos), "pnl", round(pnl, 2), "rows", len(lr.POSITION_ROWS), lr.POSITION_ROWS[0] if lr.POSITION_ROWS else None)
val = lr.get_json(f"{lr.DATA}/value?user={w}")
act = lr.get_json(f"{lr.DATA}/activity?user={w}&limit=50")
a = lr.summarize_account(val if isinstance(val, list) else [val], act)
print({k: v for k, v in a.items() if k != "activity"}, a["activity"][:1])
