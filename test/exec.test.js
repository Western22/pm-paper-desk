// Execution edge: keep queue priority (replace hysteresis), event-driven ticks, toxic-flow and sibling pulls.
const assert = require('assert');
const P = require('../paper.js');
const E = require('../lib/paper-engine.js');
const meta = { id: 'A', question: 'Exec test', tokens: [{ id: 'Y' }, { id: 'N' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.5, endTs: Date.now() + 30 * 864e5, eventSlug: 'ev' };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const params = Object.assign({}, P.DEFAULTS, { tickSec: 5 });
const book = (bb, ba, sz = 300) => ({ tick_size: '0.01', bids: [{ price: bb.toFixed(3), size: String(sz) }], asks: [{ price: ba.toFixed(3), size: String(sz) }] });

// 1) hysteresis: a 0.5¢ mid wobble must not cancel/replace the resting quote (queue priority kept)
let t = Date.UTC(2026, 9, 27, 3);
const ms = P.newMarketState(meta, model, t, 40);
P.step(ms, book(0.45, 0.55), t, params);
const q0 = Object.assign({}, ms.quote);
let replaced = 0;
for (let i = 0; i < 12; i++) { t += 5000; const o = i % 2 ? 0.005 : 0; P.step(ms, book(0.45 + o, 0.55 + o), t, params); if (ms.quote && (ms.quote.bid !== q0.bid || ms.quote.ask !== q0.ask)) replaced++; }
assert.strictEqual(replaced, 0, 'wobble replaced quote ' + replaced + ' times');
assert.strictEqual(ms.quote.t, q0.t, 'queue time preserved');
// …but a move that leaves our bid too aggressive (above the new optimum) must replace at once
t += 5000; P.step(ms, book(0.40, 0.50), t, params);
assert(!ms.quote || ms.quote.bid < q0.bid, 'stale aggressive bid replaced or pulled');

// 2) event-driven ticks: 60 updates 1 s apart on a calm book must not trip the gate
const ms2 = P.newMarketState(meta, model, t, 40);
for (let i = 0; i < 60; i++) { t += 1000; P.step(ms2, book(0.45, 0.55), t, params); }
assert.strictEqual(ms2.status, 'QUOTING', 'calm 1 s ticks: ' + ms2.status);
// a 4¢ jump within 1 s is a shock
t += 1000; P.step(ms2, book(0.49, 0.59), t, params);
assert.strictEqual(ms2.status, 'GATED', 'fast jump gates');
// cooldown is wall-clock, not tick count: still gated 10 min later even with sparse ticks, free after 21 min
t += 10 * 60000; P.step(ms2, book(0.49, 0.59), t, params); assert.strictEqual(ms2.status, 'GATED');
t += 11 * 60000; P.step(ms2, book(0.49, 0.59), t, params); assert.notStrictEqual(ms2.status, 'GATED', 'cooldown expires by time');

// 3) toxic flow: a large taker sale near our bid pulls the market; a small one doesn't
const ms3 = P.newMarketState(meta, model, t, 40);
P.step(ms3, book(0.45, 0.55), t, params);
const b3 = ms3.quote.bid;
t += 5000; P.step(ms3, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: b3 + 0.01, size: 8, timestamp: Math.floor(t / 1000) - 1 }]);
assert.strictEqual(ms3.status, 'QUOTING', 'small trade ignored');
t += 5000; const ev3 = P.step(ms3, book(0.45, 0.55), t, params, [{ asset: 'Y', side: 'SELL', price: b3 + 0.01, size: 400, timestamp: Math.floor(t / 1000) - 1 }]);
assert.strictEqual(ms3.status, 'GATED', 'large taker sale near our bid pulls: ' + ev3.join(' | '));
assert(ev3.some(e => /^TOXIC/.test(e)), 'logged as TOXIC');

// 4) siblings: a shock/toxic event in one market of an event cools the other markets of that event
const s = E.freshState(200);
s.markets.A = P.newMarketState(meta, model, t, 40);
s.markets.B = P.newMarketState(Object.assign({}, meta, { id: 'B', tokens: [{ id: 'Y2' }, { id: 'N2' }] }), model, t, 40);
s.markets.C = P.newMarketState(Object.assign({}, meta, { id: 'C', eventSlug: 'other', tokens: [{ id: 'Y3' }, { id: 'N3' }] }), model, t, 40);
const hit = E.siblingPull(s, 'A', t, 'test shock');
assert.deepStrictEqual(hit, ['B'], 'only same-event siblings: ' + hit);
assert(s.markets.B.coolUntil > t && !(s.markets.C.coolUntil > t));
console.log('exec ok');
