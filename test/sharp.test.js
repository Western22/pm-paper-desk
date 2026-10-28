// "Sharp money on the other side" → stop adding to our side, keep quoting the leg that reduces it.
const assert = require('assert');
const P = require('../paper.js');
const E = require('../lib/paper-engine.js');
const meta = { id: 'S', question: 'Sharp test', tokens: [{ id: 'Y' }, { id: 'N' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.5, endTs: Date.now() + 30 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const params = Object.assign({}, P.DEFAULTS, { tickSec: 5 });
const book = (bb, ba) => ({ tick_size: '0.01', bids: [{ price: bb.toFixed(2), size: '300' }], asks: [{ price: ba.toFixed(2), size: '300' }] });
let t = Date.UTC(2026, 9, 28, 22);

// long 30 YES, sharp money on NO → no bid (no more YES), ask still offered to sell our YES
const ms = Object.assign(P.newMarketState(meta, model, t, 40), { inv: 30, cash: -15, avoid: { side: 'YES', until: t + 3.6e6 } });
const ev = P.step(ms, book(0.48, 0.52), t, params);
assert(ms.quote, 'still quoting: ' + ms.status + ' ' + ev.join(' | '));
assert.strictEqual(ms.quote.bs, 0, 'no new YES exposure');
assert(ms.quote.as > 0, 'keeps offering to sell YES');
assert(ev.some(e => /^SHARP/.test(e)), 'logged');

// long NO (inv < 0), sharp money on YES → no ask leg (no more NO), bid buys back
const ms2 = Object.assign(P.newMarketState(meta, model, t, 40), { inv: -30, cash: 15, avoid: { side: 'NO', until: t + 3.6e6 } });
P.step(ms2, book(0.48, 0.52), t, params);
assert.strictEqual(ms2.quote.as, 0); assert(ms2.quote.bs > 0);

// expired flag → normal two-sided quoting again
const ms3 = Object.assign(P.newMarketState(meta, model, t, 40), { inv: 30, cash: -15, avoid: { side: 'YES', until: t - 1 } });
P.step(ms3, book(0.48, 0.52), t, params);
assert(ms3.quote.bs > 0 && ms3.quote.as > 0, 'expired flag ignored');

// runner side: report verdicts set / lift flags on the matching markets
const s = E.freshState(200);
s.markets.S = P.newMarketState(meta, model, t, 40); s.markets.S.inv = 30;
s.markets.T = Object.assign(P.newMarketState(Object.assign({}, meta, { id: 'T' }), model, t, 40), { inv: -10, avoid: { side: 'NO', until: t + 1e9 } });
E.applyPeerVerdicts(s, { markets: [{ id: 'S', side: 'YES', verdict: 'sharp money on the other side', opposite: { sharp: 3 }, sameSharp: 1 }, { id: 'T', side: 'NO', verdict: 'no edge from wallets', opposite: { sharp: 0 }, sameSharp: 0 }] }, t);
assert.strictEqual(s.markets.S.avoid.side, 'YES'); assert(s.markets.S.avoid.until > t);
assert(!s.markets.T.avoid, 'flag lifted when verdict clears');
console.log('sharp ok');
// scorecard: flag set at mid 0.50 holding YES; mid falls to 0.44 → sharp wallets were right (+6¢)
{
  const s2 = E.freshState(200);
  s2.markets.S = Object.assign(P.newMarketState(meta, model, t, 40), { inv: 30, cash: -15, lastMid: 0.5 });
  E.applyPeerVerdicts(s2, { markets: [{ id: 'S', side: 'YES', verdict: 'sharp money on the other side', opposite: { sharp: 2 }, sameSharp: 0 }] }, t);
  s2.markets.S.lastMid = 0.44;
  E.applyPeerVerdicts(s2, { markets: [{ id: 'S', side: 'YES', verdict: 'no edge from wallets', opposite: { sharp: 0 }, sameSharp: 0 }] }, t + 3.6e6);
  const ep = s2.sharpEpisodes[0];
  assert(ep && ep.sharpRight && Math.abs(ep.moveC - 6) < 1e-9 && Math.abs(ep.tradingDelta + 1.8) < 1e-9, JSON.stringify(ep));
  assert(E.publicView(s2).sharpEpisodes.length === 1);
  console.log('scorecard ok');
}
