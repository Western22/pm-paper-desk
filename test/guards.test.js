// Live guards after the 30 Oct losses: loss cool-down (exit-only, no re-entry), event-wide pull on a big jump,
// headline-market filter.
const assert = require('assert');
const P = require('../paper.js');
const E = require('../lib/paper-engine.js');
const { exitOnly } = require('../bot/decide.js');
const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
const mk = (id, q, ev) => ({ id, question: q, eventSlug: ev, tokens: [{ id: id + 'Y' }, { id: id + 'N' }], v: 3.5, minSize: 20, rate: 50, tick: 0.01, mid: 0.3, endTs: Date.now() + 30 * 864e5 });
const now = Date.now();

// 1) headline filter: the three markets that lost are all caught; ordinary ones are not
for (const q of ["Major airlines suspend Ben Gurion flights by January 31, 2027?", "Brazil's top courts strike down oil export tax by June 30, 2027?", 'Will Gemini Carbon be released on November 10, 2026?'])
  assert(E.isHeadline(q), q);
for (const q of ['Will BTC close above $120k on Dec 31?', 'Lakers vs Celtics: who wins?', 'Will ETH reach $5,000 in November?'])
  assert(!E.isHeadline(q), q);
// scheduled decisions gap at a known time (the ECB market lost 16¢ on 30 Oct)
for (const q of ['Will the ECB make no change to the deposit facility rate at the February meeting?', 'Will the Fed cut rates in December?'])
  assert(E.isHeadline(q), q);

// 2) loss cool-down: losing YES → only SELLs survive, held shares still offered, blacklisted for 24 h
const s = E.freshState(68); s.P.live = true; s.P.headlineFilter = 0;
s.markets.A = P.newMarketState(mk('A', 'Will BTC close above $120k?', 'btc'), model, now, 20);
s.markets.A.quote = { bid: 0.29, ask: 0.31, bs: 20, as: 20, mode: 'two' };
E.markLosers(s, ['AY'], now);
assert(s.markets.A.lossCoolUntil > now && s.blacklist.A > now, 'flagged + blacklisted');
const buys = [{ token: 'AY', side: 'BUY', price: 0.29, size: 20 }, { token: 'AN', side: 'BUY', price: 0.69, size: 20 }];
const o = exitOnly(s, 'A', s.markets.A, buys, 51, 0);
assert.deepStrictEqual(o.map(x => [x.token, x.side, x.price, x.size]), [['AY', 'SELL', 0.31, 51]], JSON.stringify(o));
assert.strictEqual(s.markets.A.status, 'EXIT ONLY');
// once flat, the market is closed (and the blacklist keeps it from coming back)
assert.deepStrictEqual(exitOnly(s, 'A', s.markets.A, buys, 0, 0), []);
assert(!s.markets.A, 'closed when flat');

// 3) headline market held from before: exit-only too; normal market untouched
s.P.headlineFilter = 1;
s.markets.B = P.newMarketState(mk('B', 'Major airlines suspend Ben Gurion flights by December 31, 2026?', 'bg'), model, now, 20);
s.markets.B.quote = { bid: 0.3, ask: 0.33, bs: 20, as: 20, mode: 'two' };
assert.deepStrictEqual(exitOnly(s, 'B', s.markets.B, buys.map(b => ({ ...b, token: b.token.replace('A', 'B') })), 0, 20).map(x => [x.token, x.side]), [['BN', 'SELL']]);
s.markets.C = P.newMarketState(mk('C', 'Will BTC close above $130k?', 'btc'), model, now, 20);
assert.strictEqual(exitOnly(s, 'C', s.markets.C, buys, 0, 0), buys, 'normal market trades normally');

// 4) big jump → whole event out for 6 h and blocked from new allocation
s.markets.D = P.newMarketState(mk('D', 'Will BTC close above $140k?', 'btc'), model, now, 20);
const hit = E.siblingPull(s, 'C', now, 'mid jumped 6.0¢', 360);
assert.deepStrictEqual(hit, ['D']);
assert(s.markets.D.coolUntil >= now + 359 * 60000, 'sibling out for hours');
assert(s.eventCool.btc >= now + 359 * 60000, 'event blocked for allocation');
// small/toxic sibling pull keeps the short cool and no event block
const s2 = E.freshState(68);
s2.markets.X = P.newMarketState(mk('X', 'q1', 'ev'), model, now, 20); s2.markets.Y = P.newMarketState(mk('Y', 'q2', 'ev'), model, now, 20);
E.siblingPull(s2, 'X', now, 'toxic');
assert(s2.markets.Y.coolUntil <= now + 11 * 60000 && !s2.eventCool);
console.log('guards ok');

// 5) take profit: 20 YES bought @0.24, bid now 0.40 → sell all 20 @0.40 as a taker, drop YES buys/asks
{
  const { takeProfit } = require('../bot/decide.js');
  const ms = P.newMarketState(mk('T', 'Will BTC close above $150k?', 'btc2'), model, now, 20);
  const orders = [{ token: 'TY', side: 'BUY', price: 0.38, size: 20 }, { token: 'TY', side: 'SELL', price: 0.43, size: 20 }, { token: 'TN', side: 'BUY', price: 0.57, size: 20 }];
  const win = new Map([['TY', 0.24]]);
  const o = takeProfit(ms, orders, { TY: 20, TN: 0 }, win, t => (t === 'TY' ? 0.4 : 0.55));
  assert.deepStrictEqual(o.map(x => [x.token, x.side, x.price, x.size, !!x.taker]), [['TN', 'BUY', 0.57, 20, false], ['TY', 'SELL', 0.4, 20, true]], JSON.stringify(o));
  // bid fell back to ~cost: no fire-sale, orders unchanged
  assert.strictEqual(takeProfit(ms, orders, { TY: 20 }, win, () => 0.245), orders);
  // not a winner / nothing held → unchanged
  assert.strictEqual(takeProfit(ms, orders, { TY: 20 }, new Map(), () => 0.4), orders);
  assert.strictEqual(takeProfit(ms, orders, { TY: 2 }, win, () => 0.4), orders);
  console.log('take profit ok');
}

// 6) fill-cost calibration: bought NO @0.40, YES mid 60 min later 0.76 → NO worth 0.24 → 16¢ adverse
{
  const s = E.freshState(68); s.P.live = true; s.P.liveMarkoutC = 9;
  s.markets.M = P.newMarketState(mk('M', 'Will BTC close above $160k?', 'btc3'), model, now, 20);
  E.recordFill(s, { asset: 'MN', side: 'BUY', price: 0.40, size: 20 }, now);
  E.recordFill(s, { asset: 'zz', side: 'BUY', price: 0.5, size: 5 }, now); // not ours → ignored
  assert.strictEqual(s.fills.length, 1);
  s.markets.M.lastMid = 0.76;
  E.scoreFills(s, now + 30 * 60000); assert(!s.fills[0].done, 'waits 60 min');
  E.scoreFills(s, now + 61 * 60000);
  assert.strictEqual(s.fills[0].markoutC, 16);
  assert.strictEqual(s.P.liveMarkoutC, 10.4, '0.8·9 + 0.2·16');
  // a favourable fill pulls the estimate down, never below 1¢
  E.recordFill(s, { asset: 'MY', side: 'BUY', price: 0.20, size: 20 }, now); // YES bought 0.20, mid now 0.76 → −56¢
  E.scoreFills(s, now + 62 * 60000);
  assert(s.P.liveMarkoutC === 1, String(s.P.liveMarkoutC));
  // floor applied to the model, own higher value kept, paper untouched
  const m1 = E.applyMarkout({ markout: 0.3 }, { live: true, liveMarkoutC: 9 }); assert.strictEqual(m1.markout, 9);
  assert.strictEqual(E.applyMarkout(m1, { live: true, liveMarkoutC: 4 }).markout, 4, 'tracks the live value down to the model base');
  assert.strictEqual(E.applyMarkout({ markout: 12 }, { live: true, liveMarkoutC: 9 }).markout, 12);
  assert.strictEqual(E.applyMarkout({ markout: 0.3 }, { live: false, liveMarkoutC: 9 }).markout, 0.3);
  // the quote itself moves away from mid as fills get costlier
  const meta = mk('Q', 'Will BTC close above $170k?', 'btc4');
  const q0 = P.optimalQuote(meta, 40, 0.3, 0.3, 20, Object.assign({}, model, { markout: 0.3 }), 0, { allowOneSided: true });
  const q9 = P.optimalQuote(meta, 40, 0.3, 0.3, 20, Object.assign({}, model, { markout: 9 }), 0, { allowOneSided: true });
  assert(!q9 || q9.d > q0.d || q9.costDay > q0.costDay, `wider or costlier: ${JSON.stringify({ q0, q9 })}`);
  console.log('markout calibration ok');
}
