// "Every pick is No" on sports props (totals / O/U, spread, BTTS, regulation time): is the NO side of a single
// leg underpriced? Uses the resolved-market sample from favorite_backtest.json (no look-ahead entries).
// A combo multiplies the per-leg result: per-leg return r → k-leg combo ≈ (1+r)^k − 1 (if legs independent).
const d = require('./favorite_backtest.json');
const PROP = /\b(o\/u|over\/under|total|spread|both teams to score|btts|regulation|reg\.? time|\(-?\d+(\.\d)?\))/i;
for (const h of [7, 3, 1]) {
  const r = d.rows.filter(x => x.d === h && PROP.test(x.q) && x.p > 0.02 && x.p < 0.98);
  const buckets = [[0, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 1]]; // NO price bands
  console.log(`\nEntry ${h} day(s) before end · ${r.length} sports-prop legs`);
  console.log('  NO price    legs   avg NO price   NO won   return/leg   w/ 1¢ cost   → 4-leg combo   → 8-leg combo');
  for (const [lo, hi] of [...buckets, [0, 1]]) {
    const v = r.map(x => ({ price: 1 - x.p, won: !x.yesWon })).filter(x => x.price >= lo && x.price < hi);
    if (!v.length) continue;
    const n = v.length, avg = v.reduce((a, x) => a + x.price, 0) / n, w = v.filter(x => x.won).length / n;
    const roi = v.reduce((a, x) => a + (x.won ? 1 / x.price : 0), 0) / n - 1;
    const roi1 = v.reduce((a, x) => a + (x.won ? 1 / Math.min(0.99, x.price + 0.01) : 0), 0) / n - 1;
    const c = k => ((Math.pow(1 + roi1, k) - 1) * 100).toFixed(0) + '%';
    const label = lo === 0 && hi === 1 ? 'all' : `${Math.round(lo * 100)}–${Math.round(hi * 100)}¢`;
    console.log(`  ${label.padEnd(9)} ${String(n).padStart(6)}   ${(avg * 100).toFixed(1).padStart(10)}¢   ${(w * 100).toFixed(1).padStart(5)}%   ${(roi * 100).toFixed(1).padStart(8)}%   ${(roi1 * 100).toFixed(1).padStart(9)}%   ${c(4).padStart(12)}   ${c(8).padStart(12)}`);
  }
}
