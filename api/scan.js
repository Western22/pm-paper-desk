// GET /api/scan?n=60&size=1000&q=&tag=
// Pulls live reward markets from the Polymarket CLOB, prices each book's competing
// reward score inside the band and ranks markets by expected reward yield.
const Q = require('../engine.js');
const Safety = require('../safety.js');
const { CLOB, getJSON, pool, send } = require('./_lib.js');

function activeRate(cfgs, today) {
  let r = 0, end = null;
  for (const c of cfgs || []) {
    const s = c.start_date || '0000', e = c.end_date || '9999';
    if (s <= today && today <= e && +c.rate_per_day > 0) { r += +c.rate_per_day; if (!end || e < end) end = e; }
  }
  return { rate: r, rewardEnd: end };
}

/** CLOB end dates look like "2026-10-24 23:05:00+00" — normalise to ISO before parsing. */
function parseEnd(s) {
  if (!s) return NaN;
  let t = String(s).trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(t)) t += ':00';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
  return Date.parse(t);
}

async function fetchRewardMarkets({ q, tag, pages }) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < pages; i++) {
    const u = new URL(CLOB + '/rewards/markets/multi');
    u.searchParams.set('order_by', 'rate_per_day');
    u.searchParams.set('position', 'DESC');
    u.searchParams.set('page_size', '250');
    if (q) u.searchParams.set('q', q);
    if (tag) u.searchParams.set('tag_slug', tag);
    if (cursor) u.searchParams.set('next_cursor', cursor);
    const j = await getJSON(u.toString());
    out.push(...(j.data || []));
    cursor = j.next_cursor;
    if (!cursor || cursor === 'LTE=') break;
  }
  return out;
}

async function fetchBooks(tokenIds) {
  const books = {};
  // batch endpoint first, per-token fallback
  for (let i = 0; i < tokenIds.length; i += 25) {
    const chunk = tokenIds.slice(i, i + 25);
    try {
      const arr = await getJSON(CLOB + '/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk.map(t => ({ token_id: t }))) });
      for (const b of arr || []) if (b && b.asset_id) books[b.asset_id] = b;
    } catch (e) { /* fall through */ }
  }
  const missing = tokenIds.filter(t => !books[t]);
  await pool(missing, 10, async t => { books[t] = await getJSON(`${CLOB}/book?token_id=${t}`); });
  return books;
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    const n = Math.min(Math.max(parseInt(req.query.n || '60', 10) || 60, 5), 120);
    const size = Math.min(Math.max(+req.query.size || 1000, 10), 1e6);
    const q = (req.query.q || '').toString().slice(0, 80);
    const tag = (req.query.tag || '').toString().slice(0, 40);
    const today = new Date().toISOString().slice(0, 10);

    const raw = await fetchRewardMarkets({ q, tag, pages: 2 });
    const live = raw
      .map(m => ({ m, ...activeRate(m.rewards_config, today) }))
      .filter(x => x.rate > 0 && x.m.tokens && x.m.tokens.length >= 2)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, n);

    const yesIds = live.map(x => x.m.tokens[0].token_id);
    const books = await fetchBooks(yesIds);

    const now = Date.now();
    const rows = live.map(({ m, rate, rewardEnd }) => {
      const yes = m.tokens[0], no = m.tokens[1];
      const v = +m.rewards_max_spread || 3, minSize = +m.rewards_min_size || 0;
      const book = books[yes.token_id];
      const comp = book ? Q.competition(book, v, minSize) : null;
      const C = comp ? comp.C : null;
      const x = Math.max(size, minSize);
      const est = C != null ? Q.rewardEstimate({ rate, v, C, x, d: 1 }) : null;
      const mid = comp ? comp.mid : +yes.price;
      const chgC = Math.abs(+m.one_day_price_change || 0) * 100;
      const turnover = comp ? (+m.volume_24hr || 0) / Math.max((comp.depthB + comp.depthA) * mid, 50) : 0;
      const endMs = parseEnd(m.end_date);
      const hoursToEnd = isFinite(endMs) ? (endMs - now) / 3.6e6 : null;
      const inner = mid >= 0.1 && mid <= 0.9;
      // Heuristic edge score: reward APR haircut for realised move, flow turnover, extremes and imminent resolution.
      // in-play / past-start markets (end_date is often kick-off) carry jump risk the APR ignores
      const timeHaircut = hoursToEnd == null ? 1 : hoursToEnd < 6 ? 0.25 : hoursToEnd < 24 ? 0.5 : 1;
      const score = est ? est.apr / (1 + chgC / v) / (1 + turnover / 25) * (inner ? 1 : 0.4) * timeHaircut : 0;
      const assets = [...new Set((m.rewards_config || []).filter(c => +c.rate_per_day > 0).map(c => c.asset_address))];
      return {
        id: m.market_id, conditionId: m.condition_id, question: m.question, slug: m.market_slug, eventSlug: m.event_slug,
        image: m.image, rate, rewardEnd, v, minSize, end: m.end_date, hoursToEnd,
        vol24: +m.volume_24hr || 0, chg24: +m.one_day_price_change || 0, competitiveness: m.market_competitiveness,
        tokens: [{ id: yes.token_id, outcome: yes.outcome, price: +yes.price }, { id: no.token_id, outcome: no.outcome, price: +no.price }],
        mid, spread: comp ? comp.spread : +m.spread, tick: book ? +(book.tick_size || 0.01) : 0.01,
        C, qb: comp ? comp.qb : null, qa: comp ? comp.qa : null, depth: comp ? comp.depthA + comp.depthB : null,
        refSize: x, refDaily: est ? est.daily : null, refShare: est ? est.share : null, refAPR: est ? est.apr : null,
        turnover, score, assets,
      };
    }).sort((a, b) => b.score - a.score);
    for (const r of rows) { const a = Safety.assess(r); r.safety = a.safety; r.safePassed = a.passed; }
    const safest = Safety.pickSafest(rows);

    send(res, 200, { ok: true, asOf: new Date().toISOString(), ms: Date.now() - t0, scanned: raw.length, count: rows.length, refSize: size, safest, markets: rows });
  } catch (e) {
    send(res, 502, { ok: false, error: String(e && e.message || e) });
  }
};
