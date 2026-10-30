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
for (const q of ['Will BTC close above $120k on Dec 31?', 'Will the Fed cut rates in December?', 'Lakers vs Celtics: who wins?'])
  assert(!E.isHeadline(q), q);

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
