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
