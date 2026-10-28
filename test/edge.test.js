// Picking battles: competitor-aware allocation + hour-of-day sizing.
const assert = require('assert');
const P = require('../paper.js');
const E = require('../lib/paper-engine.js');
const now = Date.UTC(2026, 9, 29, 14, 30); // Thursday 14:30 UTC
const ts = now / 1000 - 3600;

// 1) competitors in a candidate market: known market makers + unknown wallets trading both sides repeatedly
const mm = new Set(['0xmm1']);
const trades = [
  { proxyWallet: '0xmm1', side: 'BUY', outcomeIndex: 0, size: 50, price: 0.4, timestamp: ts },
  { proxyWallet: '0xq', side: 'BUY', outcomeIndex: 0, size: 30, price: 0.4, timestamp: ts }, // two-sided, repeated → maker-like
  { proxyWallet: '0xq', side: 'SELL', outcomeIndex: 0, size: 30, price: 0.42, timestamp: ts },
  { proxyWallet: '0xq', side: 'BUY', outcomeIndex: 1, size: 30, price: 0.57, timestamp: ts },
  { proxyWallet: '0xq', side: 'SELL', outcomeIndex: 1, size: 30, price: 0.59, timestamp: ts },
  { proxyWallet: '0xq', side: 'BUY', outcomeIndex: 0, size: 30, price: 0.4, timestamp: ts },
  { proxyWallet: '0xq', side: 'SELL', outcomeIndex: 0, size: 30, price: 0.42, timestamp: ts },
  ...[1, 2, 3, 4, 5, 6].map(() => ({ proxyWallet: '0xdir2', side: 'BUY', outcomeIndex: 0, size: 5, price: 0.4, timestamp: ts })), // busy but one-sided
  { proxyWallet: '0xdir', side: 'BUY', outcomeIndex: 0, size: 900, price: 0.41, timestamp: ts }, // one-way directional: not a maker
  { proxyWallet: '0xold', side: 'BUY', outcomeIndex: 0, size: 10, price: 0.4, timestamp: ts - 9 * 86400 }, // too old
];
const c = E.competitorsFromTrades(trades, mm, now);
assert.deepStrictEqual(c.sort(), ['0xmm1', '0xq'], 'known MM + maker-like wallet: ' + c);
assert.strictEqual(E.crowdedC(100, 0, { mmPenalty: 0.5 }), 100);
assert.strictEqual(E.crowdedC(100, 2, { mmPenalty: 0.5 }), 200, 'two competitors double the expected competition');
assert.strictEqual(E.crowdedC(100, 22, { mmPenalty: 0.5 }), 400, 'penalty capped at 6 rivals');
// MM wallets are learned from peer reports
const s = E.freshState(200);
E.learnMakers(s, { markets: [{ peers: [{ wallet: '0xA', record: { style: 'market maker' } }, { wallet: '0xB', record: { style: 'directional' } }], opposite: { holders: [{ wallet: '0xC', record: { style: 'market maker' } }] } }] });
assert.deepStrictEqual(s.mmWallets.sort(), ['0xA', '0xC']);

// 2) hour-of-day scoreboard: losses beat rewards at 14:00 UTC weekdays for 3+ days → half size then; other hours full
const h = E.freshState(200);
for (let d = 0; d < 4; d++) {
  const day = Date.UTC(2026, 9, 26 + d);
  E.recordHour(h, day + 14.5 * 3.6e6, { reward: 1.0, trade: -3.0 });
  E.recordHour(h, day + 3.5 * 3.6e6, { reward: 2.0, trade: -0.5 });
}
assert.strictEqual(E.hourMult(h, now), 0.5, '14:00 weekday is a losing hour');
assert.strictEqual(E.hourMult(h, Date.UTC(2026, 9, 29, 3, 10)), 1, '03:00 is profitable');
assert.strictEqual(E.hourMult(h, Date.UTC(2026, 9, 31, 14, 10)), 1, 'weekend bucket has no data yet → full size');
const fresh = E.freshState(200); E.recordHour(fresh, now, { reward: 0, trade: -9 });
assert.strictEqual(E.hourMult(fresh, now), 1, 'needs ≥3 days before acting');

// the engine honours the multiplier: half the budget → at most half the collateral
const meta = { id: 'H', question: 'Hour test', tokens: [{ id: 'Y' }, { id: 'N' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.5, endTs: now + 30 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const book = { tick_size: '0.01', bids: [{ price: '0.48', size: '300' }], asks: [{ price: '0.52', size: '300' }] };
const full = P.newMarketState(meta, model, now, 100), half = P.newMarketState(meta, model, now, 100);
P.step(full, book, now, Object.assign({}, P.DEFAULTS));
P.step(half, book, now, Object.assign({}, P.DEFAULTS, { hourMultNow: 0.5 }));
assert(P.collateral(half) <= 50 + 1e-6 && P.collateral(full) > 50, `collateral full ${P.collateral(full)} half ${P.collateral(half)}`);
console.log('edge ok');
