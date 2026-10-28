const assert = require('assert');
const P = require('../paper.js');
const meta = { id: 'g', question: 'Gate test', tokens: [{ id: '1' }, { id: '2' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.5, endTs: Date.now() + 30 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const params = Object.assign({}, P.DEFAULTS);
const book = (bb, ba) => ({ tick_size: '0.01', bids: [{ price: bb.toFixed(3), size: '30' }], asks: [{ price: ba.toFixed(3), size: '30' }] });

// 1) a fresh market in a thin book wiggling ±0.2¢ must keep quoting (old floor gated this)
let t = Date.UTC(2026, 9, 26, 3), ms = P.newMarketState(meta, model, t, 25), gated = 0;
for (let i = 0; i < 30; i++) { t += 60000; const o = i % 2 ? 0.002 : 0; /* ±0.2¢, like the live Lula gate (0.155¢/min) */ P.step(ms, book(0.48 + o, 0.52 + o), t, params); if (ms.status === 'GATED') gated++; }
assert.strictEqual(gated, 0, 'small wiggles must not gate, gated ' + gated + ' ticks');
assert(ms.quotedMs > 0, 'quoted time counted');

// 2) a real 6¢ jump still pulls quotes
t += 60000; P.step(ms, book(0.54, 0.58), t, params);
assert.strictEqual(ms.status, 'GATED', 'large jump gates');

// 3) one-sided quoting counts toward uptime
const ms3 = P.newMarketState(Object.assign({}, meta, { minSize: 200, mid: 0.2 }), model, t, 60);
for (let i = 0; i < 3; i++) { t += 60000; P.step(ms3, book(0.19, 0.21), t, params); }
assert(ms3.quote && ms3.quote.mode !== 'two', 'one-sided');
assert(ms3.quotedMs > 0, 'one-sided quote counts as quoting');
console.log('gate ok');
