// Backtest: copy "top traders" with a delay. No look-ahead in WHO is followed: wallets are picked only on
// their September record (closed positions), then their October buys are copied at the price available
// 0 / 1 / 5 / 30 minutes later (+1¢ to cross the spread), exited when they sell (same delay, −1¢) or at
// resolution (1 / 0). Unresolved positions are marked at the latest price.
//   NODE_USE_ENV_PROXY=1 node analysis/copy_backtest.js
const fs = require('fs');
const { getJSON } = require('../api/_lib.js');
const DATA = 'https://data-api.polymarket.com', CLOB = 'https://clob.polymarket.com', GAMMA = 'https://gamma-api.polymarket.com';
const T = s => Date.parse(s) / 1000;
const PRIOR = [T('2026-09-01T00:00:00Z'), T('2026-10-01T00:00:00Z')];
const TEST = [T('2026-10-01T00:00:00Z'), T('2026-10-25T00:00:00Z')];
const DELAYS = [0, 60, 300, 1800]; // seconds
const MAX_WALLETS = 40, BUYS_PER_WALLET = 30, MIN_USD = 20;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const pool = async (items, n, fn) => { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } })); return out; };

async function candidates() {
  const seen = new Map();
  for (const p of ['ALL', 'MONTH', 'WEEK']) {
    for (const off of [0, 50]) {
      const r = await getJSON(`${DATA}/v1/leaderboard?timePeriod=${p}&orderBy=PNL&limit=50&offset=${off}`, {}, 20000).catch(() => []);
      for (const x of r || []) if (!seen.has(x.proxyWallet)) seen.set(x.proxyWallet, x.userName || x.proxyWallet.slice(0, 8));
    }
  }
  return [...seen.entries()].map(([w, name]) => ({ w, name }));
}

/** September record from closed positions (sorted newest first). */
async function prior(c) {
  let n = 0, pnl = 0, wins = 0;
  for (let off = 0; off < 1500; off += 50) {
    const r = await getJSON(`${DATA}/closed-positions?user=${c.w}&limit=50&offset=${off}&sortBy=TIMESTAMP&sortDirection=DESC`, {}, 20000);
    if (!r || !r.length) break;
    for (const p of r) {
      const t = +p.timestamp;
      if (t >= PRIOR[0] && t < PRIOR[1]) { n++; pnl += +p.realizedPnl || 0; if ((+p.realizedPnl || 0) > 0) wins++; }
    }
    if (+r[r.length - 1].timestamp < PRIOR[0]) break;
  }
  return Object.assign(c, { pn: n, ppnl: pnl, pwin: n ? wins / n : 0 });
}

async function trades(c) {
  const out = [];
  for (let off = 0; off < 3000; off += 500) {
    const r = await getJSON(`${DATA}/trades?user=${c.w}&limit=500&offset=${off}&takerOnly=false`, {}, 20000).catch(() => []);
    if (!r || !r.length) break;
    out.push(...r.filter(x => +x.timestamp >= TEST[0] && +x.timestamp < TEST[1]));
    if (+r[r.length - 1].timestamp < TEST[0]) break;
  }
  return out;
}

const hist = async (asset, t0, t1, fid = 1) => ((await getJSON(`${CLOB}/prices-history?market=${asset}&startTs=${Math.floor(t0)}&endTs=${Math.floor(t1)}&fidelity=${fid}`, {}, 20000)).history || []).map(p => ({ t: +p.t, p: +p.p }));
const at = (h, t) => { const x = h.find(p => p.t >= t); return x ? x.p : null; };

const resCache = new Map();
async function resolution(asset) {
  if (resCache.has(asset)) return resCache.get(asset);
  const r = await getJSON(`${GAMMA}/markets?clob_token_ids=${asset}&closed=true`, {}, 20000).catch(() => []);
  let v = null;
  const m = (r || [])[0];
  if (m) {
    try {
      const tk = JSON.parse(m.clobTokenIds), op = JSON.parse(m.outcomePrices).map(Number), i = tk.indexOf(asset);
      if (i >= 0 && (op[i] === 0 || op[i] === 1)) v = op[i];
    } catch (e) { /* unresolved */ }
  }
  resCache.set(asset, v);
  return v;
}

(async () => {
  const cands = await candidates();
  log(`candidates ${cands.length}`);
  await pool(cands, 6, prior);
  const good = cands.filter(c => c.pn >= 10 && c.ppnl > 0 && c.pwin >= 0.55).sort((a, b) => b.ppnl - a.ppnl);
  log(`profitable in September (≥10 closes, P&L>0, ≥55% won): ${good.length}`);
  const used = [];
  for (const c of good) {
    if (used.length >= MAX_WALLETS) break;
    const tr = await trades(c);
    if (!tr.length) continue;
    // market makers trade both sides of the same token all the time: skip them (their buys aren't predictions)
    const by = new Map(); tr.forEach(x => { const k = x.asset; const v = by.get(k) || { b: 0, s: 0 }; v[x.side === 'BUY' ? 'b' : 's']++; by.set(k, v); });
    const twoWay = [...by.values()].filter(v => v.b >= 2 && v.s >= 2).length / Math.max(1, by.size);
    if (twoWay > 0.3) { log(`  skip ${c.name}: market-maker style (${(twoWay * 100).toFixed(0)}% two-way)`); continue; }
    const buys = tr.filter(x => x.side === 'BUY' && +x.size * +x.price >= MIN_USD && +x.price > 0.02 && +x.price < 0.98).sort((a, b) => a.timestamp - b.timestamp);
    const step = Math.max(1, Math.floor(buys.length / BUYS_PER_WALLET));
    c.buys = buys.filter((_, i) => i % step === 0).slice(0, BUYS_PER_WALLET);
    c.sells = tr.filter(x => x.side === 'SELL');
    if (c.buys.length) used.push(c);
    log(`  use ${c.name}: Sept ${c.pn} closes, $${Math.round(c.ppnl)} · Oct buys ${buys.length} (sampled ${c.buys.length})`);
  }
  const jobs = used.flatMap(c => c.buys.map(b => ({ c, b })));
  log(`copying ${jobs.length} buys from ${used.length} wallets…`);
  let done = 0;
  const rows = (await pool(jobs, 6, async ({ c, b }) => {
    const t = +b.timestamp, asset = b.asset;
    const h = await hist(asset, t - 120, t + 2 * 3600);
    const sell = c.sells.filter(s => s.asset === asset && +s.timestamp > t).sort((x, y) => x.timestamp - y.timestamp)[0];
    let hs = null, res = null, last = null;
    if (sell) hs = await hist(asset, +sell.timestamp - 120, +sell.timestamp + 2 * 3600);
    else {
      res = await resolution(asset);
      if (res == null) { const hl = await hist(asset, Date.now() / 1000 - 86400, Date.now() / 1000, 60); last = hl.length ? hl[hl.length - 1].p : null; }
    }
    if (++done % 100 === 0) log(`  ${done}/${jobs.length}`);
    const out = { wallet: c.name, title: b.title, theirPrice: +b.price, exitBy: sell ? 'they sold' : res != null ? 'resolved' : 'open (marked)', r: {} };
    for (const d of DELAYS) {
      const entry = d === 0 ? +b.price : at(h, t + d);
      let exit;
      if (sell) exit = d === 0 ? +sell.price : at(hs, +sell.timestamp + d);
      else exit = res != null ? res : last;
      if (entry == null || exit == null) continue;
      const e = d === 0 ? entry : Math.min(0.99, entry + 0.01), x = sell && d > 0 ? Math.max(0, exit - 0.01) : exit;
      out.r[d] = x / e - 1;
    }
    return out;
  })).filter(Boolean);
  fs.writeFileSync('analysis/copy_backtest.json', JSON.stringify({ at: new Date().toISOString(), wallets: used.map(c => ({ name: c.name, w: c.w, pn: c.pn, ppnl: c.ppnl, pwin: c.pwin })), rows }));
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log(`\nCopying ${used.length} wallets picked on their September record · ${rows.length} October buys\n`);
  console.log('delay      trades  avg return  median   won %   $10/trade total   (exit: they sold / resolved / open)');
  for (const d of DELAYS) {
    const r = rows.filter(x => x.r[d] != null), v = r.map(x => x.r[d]);
    if (!v.length) continue;
    const avg = v.reduce((a, b) => a + b, 0) / v.length, won = v.filter(x => x > 0).length / v.length;
    const ex = k => r.filter(x => x.exitBy.startsWith(k)).length;
    console.log(`${(d === 0 ? 'their fill' : d < 60 ? d + ' s' : d / 60 + ' min').padEnd(10)} ${String(v.length).padStart(6)}  ${(avg * 100).toFixed(1).padStart(9)}%  ${(med(v) * 100).toFixed(1).padStart(6)}%  ${(won * 100).toFixed(0).padStart(5)}%  ${('$' + (avg * 10 * v.length).toFixed(0)).padStart(16)}   (${ex('they')} / ${ex('resolved')} / ${ex('open')})`);
  }
})().catch(e => { console.error(e); process.exit(1); });
