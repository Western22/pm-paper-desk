const assert = require('assert');
const P = require('../paper.js');
const meta = { id: 'm', question: 'Test market', tokens: [{ id: '1' }, { id: '2' }], v: 3.5, minSize: 50, rate: 400, tick: 0.01, mid: 0.5, endTs: Date.now() + 30 * 864e5 };
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const params = Object.assign({}, P.DEFAULTS); // tickSec 60, capital 200, $1 floor
const book = (bb, ba, sz = 300) => ({ tick_size: '0.01', bids: [{ price: String(bb), size: String(sz) }, { price: String(+(bb - 0.01).toFixed(2)), size: '2000' }], asks: [{ price: String(ba), size: String(sz) }, { price: String(+(ba + 0.01).toFixed(2)), size: '2000' }] });

let t = Date.UTC(2026, 9, 25, 23, 55);
// 1) budget-limited quote: $100 budget → collateral ≤ $100
const ms = P.newMarketState(meta, model, t, 100);
let ev = P.step(ms, book(0.49, 0.51), t, params);
console.log(ev);
assert.strictEqual(ms.status, 'QUOTING');
assert(P.collateral(ms) <= 100 + 1e-6, 'collateral within budget: ' + P.collateral(ms));
assert(ms.quote.bs >= 50 && ms.quote.as >= 50);
const q0 = ms.quote;
// 2) a minute later: reward accrues into today's pending bucket
t += 60000; P.step(ms, book(0.49, 0.51), t, params);
assert(ms.dayReward > 0 && ms.rewardPaid === 0);
// 3) book trades through our bid → fill; inventory now locks capital
t += 60000; ev = P.step(ms, book(q0.bid - 0.03, q0.bid - 0.01), t, params);
console.log(ev);
assert.strictEqual(ms.fills, 1); assert(ms.inv > 0); assert(P.locked(ms) > 0);
// 4) midnight rollover settles the day: pending ≥ $1 → PAYOUT, else FORFEIT
const pend = ms.dayReward;
t = Date.UTC(2026, 9, 26, 0, 1); ev = P.step(ms, book(0.46, 0.48), t, params);
console.log(ev.filter(e => /PAYOUT|FORFEIT/.test(e)));
assert(ev.some(e => (pend >= 1 ? /PAYOUT/ : /FORFEIT/).test(e)), 'epoch settled');
assert.strictEqual(ms.dayReward >= 0, true);
// 5) budget below min size → NO CAPITAL
const ms2 = P.newMarketState(Object.assign({}, meta, { minSize: 200 }), model, t, 40);
P.step(ms2, book(0.49, 0.51), t, params); assert.strictEqual(ms2.status, 'NO CAPITAL');
// 6) allocator splits $200 and respects min sizes / payout floor
const cands = [
  { mk: Object.assign({}, meta, { id: 'a', rate: 300 }), C: 3000, sig: 0.02, mid: 0.5, model },
  { mk: Object.assign({}, meta, { id: 'b', rate: 900, minSize: 100 }), C: 20000, sig: 0.02, mid: 0.6, model },
  { mk: Object.assign({}, meta, { id: 'c', rate: 2 }), C: 50, sig: 0.02, mid: 0.5, model }, // tiny pool: < $1/day
  { mk: Object.assign({}, meta, { id: 'd', rate: 500, minSize: 500 }), C: 100, sig: 0.02, mid: 0.5, model }, // min size > bankroll
];
const al = P.allocateCapital(cands, 200, 1, 4);
console.log(al.map(a => `${cands[a.i].mk.id}: $${a.budget} → $${a.edgeDay.toFixed(2)}/day`));
const tot = al.reduce((s, a) => s + a.budget, 0);
assert(tot <= 200, 'never over-allocates'); assert(!al.some(a => cands[a.i].mk.id === 'd'), 'skips unaffordable min size');
assert(!al.some(a => cands[a.i].mk.id === 'c'), 'skips pools that can’t clear the $1 floor');
console.log('paper core ok · reward', ms.reward.toFixed(4), '· paid', ms.rewardPaid.toFixed(4), '· forfeit', ms.rewardForfeit.toFixed(4), '· mtm', P.mtm(ms).toFixed(2));
// 7) one-sided: $60 budget, min 200, mid 20¢ → can't afford a $196 two-sided pair, but BUY YES 200 @ ~0.19 costs ~$38
const ms7 = P.newMarketState(Object.assign({}, meta, { minSize: 200, mid: 0.2 }), model, t, 60);
const ev7 = P.step(ms7, book(0.19, 0.21), t, params);
console.log(ev7);
assert.strictEqual(ms7.status, 'QUOTING'); assert(ms7.quote.mode === 'yes' || ms7.quote.mode === 'no', 'one-sided mode');
assert(P.collateral(ms7) <= 60 + 1e-6, 'one-sided collateral within budget');
// 8) allocator spreads $200 over several cheap one-sided entries
const cheap = [0.2, 0.25, 0.3, 0.75].map((m, k) => ({ mk: Object.assign({}, meta, { id: 'x' + k, rate: 300, minSize: 200, mid: m }), C: 2000, sig: 0.02, mid: m, model }));
const al2 = P.allocateCapital(cheap, 200, 0, 6, 5, 70);
console.log(al2.map(a => `${cheap[a.i].mk.id}@${cheap[a.i].mid}: $${a.budget} ${a.mode} → $${a.edgeDay.toFixed(2)}/day`));
assert(al2.length >= 3, 'spreads over ≥3 markets with one-sided entries');
console.log('one-sided ok');
