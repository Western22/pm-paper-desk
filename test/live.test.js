// Paper → live realism: taker-trade fills, resolution settlement, per-market stop-loss.
const assert = require('assert');
const P = require('../paper.js');
const E = require('../lib/paper-engine.js');
const meta = { id: 'L', question: 'Live test', tokens: [{ id: 'Y' }, { id: 'N' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.5, endTs: Date.now() + 30 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const params = Object.assign({}, P.DEFAULTS);
const book = (bb, ba) => ({ tick_size: '0.01', bids: [{ price: bb.toFixed(2), size: '30' }], asks: [{ price: ba.toFixed(2), size: '30' }] });

// 1) a taker SELL of YES at our bid fills us even though the book never trades through (old model: no fill)
let t = Date.UTC(2026, 9, 27, 3);
const ms = P.newMarketState(meta, model, t, 25);
P.step(ms, book(0.45, 0.55), t, params);
const q = ms.quote; assert(q && q.bs >= 20, 'quoting'); const bs0 = q.bs, bid0 = q.bid;
t += 60000;
const ts = Math.floor(t / 1000) - 10;
let ev = P.step(ms, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: bid0, size: 60, timestamp: ts }]);
assert.strictEqual(ms.fills, 1, 'taker trade at our bid fills: ' + ev.join(' | '));
assert(ms.inv > 0 && ms.inv <= bs0, 'filled at most our size');
// 2) the same trade is not counted twice
const inv1 = ms.inv;
t += 60000; P.step(ms, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: bid0, size: 60, timestamp: ts }]);
assert.strictEqual(ms.inv, inv1, 'old trades ignored');
// 3) a taker SELL of NO below (1 − ask) hits our resting BUY NO = a YES buy from us at ≥ ask → ask leg fills
const q3 = ms.quote;
t += 60000; ev = P.step(ms, book(0.45, 0.55), t, params, [{ asset: 'N', side: 'SELL', price: +(1 - q3.ask - 0.01).toFixed(2), size: 60, timestamp: Math.floor(t / 1000) - 5 }]);
assert(ms.inv < inv1, 'NO-side taker sell fills our YES ask: ' + ev.join(' | '));
// 4) trades before the quote existed don't fill it
const ms4 = P.newMarketState(meta, model, t, 25);
P.step(ms4, book(0.45, 0.55), t, params);
t += 60000; P.step(ms4, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: 0.4, size: 100, timestamp: Math.floor((t - 120000) / 1000) }]);
assert.strictEqual(ms4.fills, 0, 'pre-quote trades ignored');

// 4b) a quote restored from old state (no posting time) must not be filled by hours-old trades
const ms4b = P.newMarketState(meta, model, t, 25);
P.step(ms4b, book(0.45, 0.55), t, params); delete ms4b.quote.t; delete ms4b.lastTradeMs;
t += 60000; P.step(ms4b, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: 0.4, size: 100, timestamp: Math.floor((t - 3 * 3.6e6) / 1000) }]);
assert.strictEqual(ms4b.fills, 0, 'legacy quote not back-filled');
// 5) resolution: YES won → long-YES inventory pays $1/share, market closes
const s = E.freshState(200);
s.markets.R = Object.assign(P.newMarketState(meta, model, t, 25), { inv: 40, cash: -20, lastMid: 0.3 });
E.settleResolved(s, 'R', 1);
assert(!s.markets.R, 'resolved market closed');
assert(Math.abs(s.closed - 20) < 1e-9, 'pays 40×$1 − $20 cost = +$20, got ' + s.closed);
// short YES (= long NO) when YES wins loses its stake
s.markets.S = Object.assign(P.newMarketState(meta, model, t, 25), { inv: -30, cash: 12, lastMid: 0.6 });
E.settleResolved(s, 'S', 1);
assert(Math.abs(s.closed - (20 + 12 - 30)) < 1e-9, 'long NO loses on YES, got ' + s.closed);

// 6) stop-loss: trading loss beyond 30% of budget net of rewards → close and blacklist for 24 h
s.markets.X = Object.assign(P.newMarketState(meta, model, t, 30), { inv: 0, cash: -14, reward: 3 });
s.markets.OK = Object.assign(P.newMarketState(meta, model, t, 30), { inv: 0, cash: -2, reward: 1 });
E.riskCheck(s, t);
assert(!s.markets.X && s.markets.OK, 'loser closed, healthy market kept');
assert(s.blacklist && s.blacklist.L > t, 'loser blacklisted');
console.log('live realism ok');
