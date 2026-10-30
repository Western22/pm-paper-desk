// Backtest: "buy the likely side at 70–90¢ and hold to resolution" on real resolved Polymarket markets.
// Entry is at a fixed time before each market's SCHEDULED end (known in advance, no look-ahead); markets that
// were already closed at that time are skipped (you couldn't have bought then). Price = last traded/mid price
// from CLOB prices-history; results are also shown with a 1¢ entry cost (crossing the spread).
//   node analysis/favorite_backtest.js [maxMarkets=6000]
const fs = require('fs');
const { getJSON } = require('../api/_lib.js');
const MAX = +(process.argv[2] || 6000);
const H = [7, 3, 1]; // days before scheduled end
const now = Date.now();

async function markets() {
  // the API returns ≤100 per page and caps the offset, and recent days are dominated by thousands of
  // short-lived markets — so sample evenly: up to PER_WEEK markets ending in each of the last 52 weeks.
  const out = [], seen = new Set(), PER_WEEK = Math.ceil(MAX / 52);
  for (let w = 1; w <= 52; w++) {
    const max = new Date(now - (w - 1) * 7 * 864e5 - 864e5).toISOString(), min = new Date(now - w * 7 * 864e5 - 864e5).toISOString();
    let got = 0;
    for (let off = 0; got < PER_WEEK && off < 2000; off += 100) {
      let page;
      try { page = await getJSON(`https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=${off}&order=volumeNum&ascending=false&volume_num_min=10000&end_date_min=${min}&end_date_max=${max}`, {}, 30000); } catch (e) { break; }
      if (!page.length) break;
      for (const m of page) {
        if (seen.has(m.id) || /up-or-down|updown/i.test(m.slug || '')) continue; // skip 15m/1h crypto coin-flips
        let op, tk; try { op = JSON.parse(m.outcomePrices || '[]').map(Number); tk = JSON.parse(m.clobTokenIds || '[]'); } catch (e) { continue; }
        if (op.length !== 2 || tk.length !== 2 || !(op.includes(1) && op.includes(0))) continue; // clean binary resolution only
        seen.add(m.id); got++;
        out.push({ id: m.id, q: m.question, end: Date.parse(m.endDate), closed: Date.parse(String(m.closedTime || '').replace(' ', 'T').replace('+00', 'Z')) || null, yes: tk[0], yesWon: op[0] === 1, vol: +m.volume || 0 });
      }
    }
    process.stderr.write(`\rmarkets ${out.length} (week ${w})`);
  }
  return out;
}

async function entries(m) {
  const t0 = Math.floor((m.end - 7 * 864e5 - 6 * 3.6e6) / 1000), t1 = Math.floor((m.end - 864e5 + 3.6e6) / 1000);
  const h = await getJSON(`https://clob.polymarket.com/prices-history?market=${m.yes}&startTs=${t0}&endTs=${t1}&fidelity=60`, {}, 20000);
  const pts = (h.history || []).map(p => ({ t: p.t * 1000, p: +p.p })).sort((a, b) => a.t - b.t);
  const res = {};
  for (const d of H) {
    const at = m.end - d * 864e5;
    if (m.closed && m.closed <= at) continue; // already resolved: not buyable
    const before = pts.filter(x => x.t <= at && at - x.t <= 6 * 3.6e6); // a price from the last 6 h
    if (before.length) res[d] = before[before.length - 1].p;
  }
  return res;
}

(async () => {
  const ms = await markets();
  const rows = []; let i = 0, fail = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < ms.length) {
      const m = ms[i++];
      try { const e = await entries(m); for (const [d, p] of Object.entries(e)) rows.push({ d: +d, p, yesWon: m.yesWon, q: m.q }); } catch (e) { fail++; }
      if (i % 100 === 0) process.stderr.write(`\rhistory ${i}/${ms.length}`);
    }
  }));
  process.stderr.write('\n');
  fs.writeFileSync('analysis/favorite_backtest.json', JSON.stringify({ at: new Date().toISOString(), markets: ms.length, fail, rows }));
  // favourite side: YES if p ≥ .5 else NO at 1 − p
  const buckets = [[0.50, 0.60], [0.60, 0.70], [0.70, 0.80], [0.80, 0.90], [0.90, 0.95], [0.95, 0.99]];
  console.log(`${ms.length} resolved binary markets (vol ≥ $10k, ended last ~13 months) · history failures ${fail}\n`);
  for (const d of H) {
    console.log(`Entry ${d} day(s) before scheduled end`);
    console.log('  price band   trades  avg price  won %   ROI/trade  ROI w/ 1¢ cost  95% CI on won %');
    for (const [lo, hi] of buckets) {
      const r = rows.filter(x => x.d === d).map(x => ({ price: x.p >= 0.5 ? x.p : 1 - x.p, won: x.p >= 0.5 ? x.yesWon : !x.yesWon })).filter(x => x.price >= lo && x.price < hi);
      if (!r.length) continue;
      const n = r.length, avg = r.reduce((a, x) => a + x.price, 0) / n, w = r.filter(x => x.won).length / n;
      const roi = r.reduce((a, x) => a + (x.won ? 1 / x.price : 0), 0) / n - 1;
      const roi1 = r.reduce((a, x) => a + (x.won ? 1 / Math.min(0.999, x.price + 0.01) : 0), 0) / n - 1;
      const se = Math.sqrt(w * (1 - w) / n);
      console.log(`  ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}¢`.padEnd(14) + `${String(n).padStart(6)}  ${(avg * 100).toFixed(1).padStart(8)}¢  ${(w * 100).toFixed(1).padStart(5)}%  ${(roi * 100).toFixed(1).padStart(8)}%  ${(roi1 * 100).toFixed(1).padStart(12)}%   ${((w - 1.96 * se) * 100).toFixed(1)}–${((w + 1.96 * se) * 100).toFixed(1)}%`);
    }
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
