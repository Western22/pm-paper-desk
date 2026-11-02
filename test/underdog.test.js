// Underdog paper forward-test: side/price selection from a real-shaped book, settlement and the summary.
const assert = require('assert');
const U = require('../lib/underdog.js');

// YES mid 0.25 → underdog YES at the ask 0.26
let s = U.pickSide({ bids: [{ price: '0.24', size: '100' }], asks: [{ price: '0.26', size: '50' }] });
assert.deepStrictEqual([s.side, s.ask, s.spread], ['YES', 0.26, 0.02]);
// YES mid 0.72 → underdog NO; its ask = 1 − YES best bid 0.71 = 0.29
s = U.pickSide({ bids: [{ price: '0.71', size: '40' }, { price: '0.70', size: '90' }], asks: [{ price: '0.73', size: '60' }] });
assert.deepStrictEqual([s.side, s.ask], ['NO', 0.29]);
assert(Math.abs(s.depthUsd - 0.29 * 40) < 1e-9);
assert.strictEqual(U.pickSide({ bids: [], asks: [{ price: '0.5', size: '1' }] }), null);

// summary over settled bets: win rate vs price, streak, drawdown
const u = U.fresh();
const mk = (status, price, i) => ({ id: String(i), q: 'q' + i, side: 'YES', price, shares: 1 / price, stake: 1, status, payout: status === 'won' ? 1 / price : 0, pnl: status === 'won' ? 1 / price - 1 : -1, settledAt: i, end: 0 });
u.bets = [mk('lost', 0.25, 1), mk('lost', 0.25, 2), mk('won', 0.25, 3), mk('lost', 0.3, 4), { id: '9', status: 'open', stake: 1, price: 0.2 }];
const sm = U.summary(u);
assert.strictEqual(sm.settled, 4); assert.strictEqual(sm.open, 1); assert.strictEqual(sm.won, 1);
assert.strictEqual(sm.pnl, 0); // −1 −1 +3 −1
assert.strictEqual(sm.worstStreak, 2); assert.strictEqual(sm.maxDrawdown, 2);
assert(Math.abs(sm.avgPrice - 0.2625) < 1e-9);
const pv = U.publicView(u);
assert(pv.summary && Array.isArray(pv.bets) && pv.bets[0].id === '9', 'newest first');
console.log('underdog ok');

// quant layer: calibrated p, edge, half-Kelly stake, $1 floor, one per event
{
  const p = U.pHat(0.25);
  assert(Math.abs(p - (0.25 + 0.053 * 0.5)) < 1e-9, String(p));
  const sz = U.sizeBet(p, 0.25, 50);
  assert(sz.edge > 0.1 && sz.edge < 0.12, JSON.stringify(sz)); // ≈ +10.6% per $
  assert.strictEqual(sz.stake, 1, 'half-Kelly ≈ $0.88 → rounded up to the $1 minimum');
  assert.strictEqual(U.sizeBet(0.25, 0.25, 50).stake, 0, 'no edge → no bet');
  assert(U.sizeBet(p, 0.25, 400).stake > 1 && U.sizeBet(p, 0.25, 400).stake <= 12, 'grows with bankroll, capped at 3%');
  assert.strictEqual(U.eventKey({ events: [{ slug: 'nba-bucks-wolves' }] }), 'nba-bucks-wolves');
  assert.strictEqual(U.eventKey({ question: 'CD Pamplona vs. SD Eibar: O/U 3.5' }), 'cd pamplona vs. sd eibar');
  const u2 = U.fresh(); u2.bets = [{ kpnl: 2.5 }, { kpnl: -1 }];
  assert.strictEqual(U.sizedBankroll(u2), 51.5);
  // summary of the sized book + model check
  const u3 = U.fresh();
  u3.bets = [
    { id: 'a', status: 'won', price: 0.25, stake: 1, pnl: 3, settledAt: 1, kstake: 1, kpnl: 3, p: 0.2765, edge: 0.106 },
    { id: 'b', status: 'lost', price: 0.25, stake: 1, pnl: -1, settledAt: 2, kstake: 1, kpnl: -1, p: 0.2765, edge: 0.106 },
    { id: 'c', status: 'lost', price: 0.3, stake: 1, pnl: -1, settledAt: 3, kstake: 0 },
  ];
  const k = U.summary(u3).sized;
  assert.deepStrictEqual([k.settled, k.pnl, k.bankroll, k.actualWins, k.predictedWins, k.expectedPnl], [2, 2, 52, 1, 0.6, 0.21]);
  console.log('quant layer ok');
}
