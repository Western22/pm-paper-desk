// Paper forward-test of the underdog edge (analysis/underdog.js: 10–40¢ sports underdogs bought ~1 day before
// the scheduled end returned +11…+19% per bet over a year of resolved markets).
// Every 30 min: find sports markets ending in 18–30 h whose underdog side has a REAL ask (from the CLOB book)
// of 10–40¢ with a ≤4¢ spread and ≥$1 on offer, "buy" $1 at that ask, hold to resolution, settle from gamma.
// No orders are ever sent — this only records what the strategy would have done at executable prices.
const { getJSON } = require('../api/_lib.js');
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const CFG = { stake: 1, lo: 0.10, hi: 0.40, maxSpread: 0.04, minH: 18, maxH: 30, minVol: 10000, maxNewPerRun: 25, scanMin: 30 };

function fresh() { return { v: 1, startedAt: Date.now(), cfg: CFG, bets: [], lastScan: 0, log: [] }; }
const note = (u, t) => { u.log.push({ ts: Date.now(), t }); if (u.log.length > 300) u.log.splice(0, u.log.length - 300); };

/** The underdog side's executable ask from the YES book (unified: NO ask = 1 − YES bid). */
function pickSide(book) {
  const bids = (book.bids || []).map(l => ({ p: +l.price, z: +l.size })).sort((a, b) => b.p - a.p);
  const asks = (book.asks || []).map(l => ({ p: +l.price, z: +l.size })).sort((a, b) => a.p - b.p);
  if (!bids.length || !asks.length) return null;
  const bb = bids[0], ba = asks[0], mid = (bb.p + ba.p) / 2, spread = +(ba.p - bb.p).toFixed(4);
  if (mid < 0.5) return { side: 'YES', ask: ba.p, depthUsd: ba.p * ba.z, spread, mid };
  return { side: 'NO', ask: +(1 - bb.p).toFixed(4), depthUsd: (1 - bb.p) * bb.z, spread, mid };
}

async function scan(u, now) {
  const min = new Date(now + CFG.minH * 3.6e6).toISOString(), max = new Date(now + CFG.maxH * 3.6e6).toISOString();
  const seen = new Set(u.bets.map(b => b.id));
  const cands = [];
  for (let off = 0; off < 500; off += 100) {
    const page = await getJSON(`${GAMMA}/markets?active=true&closed=false&limit=100&offset=${off}&order=volumeNum&ascending=false&volume_num_min=${CFG.minVol}&end_date_min=${min}&end_date_max=${max}`, {}, 30000).catch(() => []);
    if (!page || !page.length) break;
    for (const m of page) {
      if (!m.sportsMarketType || !m.acceptingOrders || seen.has(String(m.id))) continue;
      if (m.gameStartTime && Date.parse(String(m.gameStartTime).replace(' ', 'T').replace('+00', 'Z')) < now) continue; // already playing
      let tk; try { tk = JSON.parse(m.clobTokenIds || '[]'); } catch (e) { continue; }
      if (tk.length === 2) cands.push({ m, tk });
    }
  }
  let added = 0, checked = 0;
  for (const { m, tk } of cands) {
    if (added >= CFG.maxNewPerRun) break;
    checked++;
    const book = await getJSON(`${CLOB}/book?token_id=${tk[0]}`, {}, 10000).catch(() => null);
    const s = book && pickSide(book);
    if (!s || s.ask < CFG.lo || s.ask >= CFG.hi || s.spread > CFG.maxSpread || s.depthUsd < CFG.stake) continue;
    const bet = { id: String(m.id), q: m.question, type: m.sportsMarketType, side: s.side, token: s.side === 'YES' ? tk[0] : tk[1],
      price: s.ask, shares: +(CFG.stake / s.ask).toFixed(4), stake: CFG.stake, spread: s.spread, at: now, end: Date.parse(m.endDate), status: 'open' };
    u.bets.push(bet); added++;
    note(u, `BET $${CFG.stake} ${s.side} @ ${s.ask} · ${m.question.slice(0, 70)} (${m.sportsMarketType}, spread ${(s.spread * 100).toFixed(1)}¢)`);
  }
  note(u, `SCAN ${cands.length} sports markets ending in ${CFG.minH}–${CFG.maxH} h · checked ${checked} books · ${added} new bets`);
}

async function settle(u, now) {
  for (const b of u.bets.filter(x => x.status === 'open' && now > x.end - 3.6e6)) {
    const r = await getJSON(`${GAMMA}/markets?clob_token_ids=${b.token}&closed=true`, {}, 15000).catch(() => []);
    const m = (r || [])[0]; if (!m) continue;
    let tk, op; try { tk = JSON.parse(m.clobTokenIds); op = JSON.parse(m.outcomePrices).map(Number); } catch (e) { continue; }
    const i = tk.indexOf(b.token); if (i < 0) continue;
    if (op[i] === 1 || op[i] === 0) {
      b.status = op[i] === 1 ? 'won' : 'lost'; b.payout = +(b.shares * op[i]).toFixed(4); b.pnl = +(b.payout - b.stake).toFixed(4); b.settledAt = now;
      note(u, `${b.status === 'won' ? 'WON' : 'LOST'} ${b.pnl >= 0 ? '+' : '−'}$${Math.abs(b.pnl).toFixed(2)} · ${b.side} @ ${b.price} · ${b.q.slice(0, 60)}`);
    } else if (now > b.end + 7 * 864e5) { b.status = 'void'; b.pnl = 0; note(u, `VOID (no clean 0/1 resolution) · ${b.q.slice(0, 60)}`); }
  }
}

function summary(u) {
  const done = u.bets.filter(b => b.status === 'won' || b.status === 'lost');
  const staked = done.reduce((a, b) => a + b.stake, 0), pnl = done.reduce((a, b) => a + b.pnl, 0);
  let streak = 0, worst = 0, eq = 0, peak = 0, dd = 0; const curve = [];
  for (const b of done.slice().sort((x, y) => x.settledAt - y.settledAt)) {
    streak = b.status === 'lost' ? streak + 1 : 0; worst = Math.max(worst, streak);
    eq += b.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ t: b.settledAt, eq: +eq.toFixed(2) });
  }
  const won = done.filter(b => b.status === 'won').length;
  return { bets: u.bets.length, open: u.bets.filter(b => b.status === 'open').length, settled: done.length, won, winRate: done.length ? won / done.length : null,
    avgPrice: done.length ? done.reduce((a, b) => a + b.price, 0) / done.length : null, staked, pnl: +pnl.toFixed(2), roi: staked ? pnl / staked : null,
    expectedWinRate: done.length ? done.reduce((a, b) => a + b.price, 0) / done.length : null, worstStreak: worst, maxDrawdown: +dd.toFixed(2), curve };
}

async function step(u, now = Date.now()) {
  await settle(u, now);
  if (now - (u.lastScan || 0) >= CFG.scanMin * 60000) { u.lastScan = now; await scan(u, now); }
  return u;
}
function publicView(u) { return { asOf: Date.now(), startedAt: u.startedAt, cfg: CFG, summary: summary(u), bets: u.bets.slice(-300).reverse(), log: u.log.slice(-80).reverse() }; }

module.exports = { fresh, step, settle, scan, pickSide, summary, publicView, CFG };
