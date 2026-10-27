# pm-paper-desk — automated Polymarket liquidity-rewards PAPER trader

Paper trading only: no wallet, no keys, no orders. A GitHub Actions runner quotes a fixed paper bankroll
(default **$200**) against **live Polymarket order books** 24/7 and publishes the ledger to the
[`paper-state`](../../tree/paper-state) branch. The desk UI is at <https://pm-liquidity-desk.vercel.app> → **05 Paper Live**.

## How it trades
- **Universe:** reward markets passing ≥ 5/6 safety checks (mid 15–85¢, > 24 h to resolution, calm, tight two-sided book), affordable min size.
- **Allocation:** greedy $5 chunks to the market with the best expected *net* $/day — modelled reward share minus
  crossing/jump and taker-markout cost. A market whose expected reward is < $1/day earns nothing (Polymarket's payout floor),
  so the allocator won't fund it. Fill flow is never counted as profit.
- **Quoting (every 60 s):** BUY YES at bid + BUY NO at 1 − ask at the optimal distance/size, fully collateralised from the
  market's budget; inventory skews and tapers quotes; a volatility gate pulls quotes after jumps; quotes are pulled 12 h before resolution.
- **Fills:** booked only when the live book trades through the paper price (conservative — no queue fills).
- **Rewards:** quadratic score vs live competition, accrued per minute, settled at 00:00 UTC; any market-day under $1 is forfeited.
- **Rebalance (every 6 h):** idle markets are closed and freed capital (incl. realised P&L) is re-allocated.

## Controls — edit [`paper-config.json`](paper-config.json)
| key | meaning |
|---|---|
| `running` | `false` pauses quoting (ledger keeps ticking time) |
| `capital` | bankroll in USDC for a new account |
| `resetId` | bump the number to start a fresh account with `capital` (the old ledger stays in the `paper-state` history of this run only) |
| `maxMarkets`, `eventGuardH`, `rebalanceH`, `payoutFloor` | engine knobs |

Edits are picked up within ~5 minutes by the running job.

## Files
`runner/run.js` (24/7 loop) · `lib/paper-engine.js` (state machine) · `paper.js` (quote/fill/reward core) ·
`engine.js` (scoring, calibration) · `api/scan.js` (reward-market scanner + safety screen) · `.github/workflows/paper.yml`.

Research tooling, not investment advice. Check Polymarket's terms and restricted-region list before trading real money.

## Going live (your machine, your key)

The paper engine above makes every decision; `bot/` runs the same engine against real money.

```
node bot/engine_server.js  ← Polymarket market WebSocket: live books, 5 s requotes,
                              instant "pull" when the size-adjusted mid jumps ≥ max(1.5¢, 0.4·v) or crosses a quote
python bot/live_runner.py  ← in-memory order diff, one cancel call, batched post-only placement (15/req),
                              concurrent calls, 5 s heartbeat (server cancels your orders if this dies)
```

```bash
pip install polymarket-client          # Node ≥ 22 also required
python bot/live_runner.py              # DRY RUN: prints every order, sends nothing
export POLYMARKET_PRIVATE_KEY=0x...    # never commit / paste this anywhere
export POLYMARKET_WALLET_ADDRESS=0x...
LIVE=1 LIVE_MAX_USDC=50 MAX_LOSS_USDC=15 python bot/live_runner.py
```

Kill switches: capital cap, wallet-P&L loss limit, no orders before positions are read, cancel-all if the
engine goes silent 30 s, cancel-all on exit. Start small: paper rewards assume the pool split the engine
sees; real competition and informed takers will be tougher. Redeem resolved winners on polymarket.com.
