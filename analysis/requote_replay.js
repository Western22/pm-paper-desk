// Replay the server's noisy market through the live engine path with its real book.
const E = require('../lib/paper-engine.js');
const { getJSON } = require('../api/_lib.js');
(async () => {
  const res = { headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
  await require('../api/scan.js')({ query: { n: '20', q: 'oil export tax' } }, res);
  const row = res.body.markets.find(x => /oil export tax/i.test(x.question));
  console.log('market', row && row.question);
  const toks = row.tokens.map(t => t.id);
  const book = await getJSON(`https://clob.polymarket.com/book?token_id=${toks[0]}`);
  const m = { id: row.id, question: row.question, conditionId: row.conditionId, endDate: new Date(Date.now() + (row.hoursToEnd || 500) * 3.6e6).toISOString() };
  const rd = { rewards_max_spread: row.v, rewards_min_size: row.minSize, rewards_config: [{ rate_per_day: row.rate }] };
  const meta = { id: String(m.id), question: m.question, conditionId: m.conditionId, tokens: toks.map(id => ({ id })), v: +rd.rewards_max_spread, minSize: +rd.rewards_min_size, rate: +rd.rewards_config[0].rate_per_day, tick: +book.tick_size || 0.01, mid: row.mid, endTs: Date.parse(m.endDate) };
  console.log('meta', { v: meta.v, minSize: meta.minSize, rate: meta.rate, tick: meta.tick }, 'book top', book.bids.slice(-2), book.asks.slice(-2));
  const s = E.freshState(50); s.P.live = true; s.P.tickSec = 5; s.lastRebalance = Date.now();
  const model = { volL: 0.05, jumpsPerDay: 0.1, jumpL: 0.1, noise: 0.4, kappa: 0.8, markout: 0.3, toxSlope: 0.7 };
  s.markets[meta.id] = E.Core.newMarketState(meta, model, Date.now(), 10);
  for (let i = 0; i < 4; i++) {
    const before = JSON.stringify(s.markets[meta.id].quote);
    await E.tickOnce(s, { getBook: () => book, background: true });
    const ms = s.markets[meta.id];
    console.log(i, ms.status, 'before', before, '→ after', JSON.stringify(ms.quote));
    await new Promise(res => setTimeout(res, 1000));
  }
  console.log(s.log.map(l => l.t).filter(t => /REQUOTE|POST/.test(t)).join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
