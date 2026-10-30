// An unchanged quote must not be re-logged as REQUOTE every tick (live log noise seen on the server).
const assert = require('assert');
const P = require('../paper.js');
const meta = { id: 'B', question: 'Brazil courts test', tokens: [{ id: 'Y' }, { id: 'N' }], v: 3.5, minSize: 50, rate: 40, tick: 0.01, mid: 0.13, endTs: Date.now() + 60 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const book = { tick_size: '0.01', bids: [{ price: '0.12', size: '400' }], asks: [{ price: '0.14', size: '400' }] };
for (const live of [false, true]) {
  const params = Object.assign({}, P.DEFAULTS, { tickSec: 5, live });
  let t = Date.UTC(2026, 9, 30, 1);
  const ms = P.newMarketState(meta, model, t, 10);
  const logs = [];
  for (let i = 0; i < 12; i++) { logs.push(...P.step(ms, book, t, params)); t += 5000; }
  const re = logs.filter(l => /^REQUOTE/.test(l));
  assert(ms.quote, 'quoting');
  assert(re.length === 0, `live=${live}: ${re.length} REQUOTE lines for an unchanged quote, e.g. ${re[0]} (first post: ${logs.find(l => /^POST/.test(l))})`);
}
console.log('requote noise ok');
