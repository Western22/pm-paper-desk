// Single underdog bets: buy the side priced under 50¢ (YES if YES < 0.5, else NO) at a fixed time before the
// scheduled end, hold to resolution. Same 10,116-market sample as favorite_backtest (no look-ahead entries).
// Reports by price band and category, with 1¢/2¢ entry costs, a bootstrap 95% CI, a split-half stability check
// and the losing streaks / drawdown a flat $1-per-bet bettor would have lived through.
const d = require('./favorite_backtest.json');
const CAT = [
  ['sports', /\b(vs\.?|o\/u|spread|win on 20|fc\b|nba|nfl|nhl|mlb|ufc|premier league|champions league|game \d|map \d|both teams|total (goals|points|kills)|set \d|grand prix|open division)\b/i],
  ['crypto', /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|crypto)\b/i],
  ['politics', /\b(trump|biden|election|senate|house|president|governor|minister|party|vote|parliament|fed|ecb|rate)\b/i],
];
const cat = q => (CAT.find(([, re]) => re.test(q)) || ['other'])[0];
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
function stats(v, cost) {
  const ret = v.map(x => (x.won ? 1 / Math.min(0.99, x.price + cost) : 0) - 1);
  const n = ret.length, mean = ret.reduce((a, b) => a + b, 0) / n;
  // bootstrap CI of the mean
  const B = 1000, ms = [];
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += ret[Math.floor(rnd() * n)]; ms.push(s / n); }
  ms.sort((a, b) => a - b);
  // streaks / drawdown in sample order, $1 per bet
  let streak = 0, worst = 0, eq = 0, peak = 0, dd = 0;
  for (const r of ret) { streak = r < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, mean, lo: ms[Math.floor(B * 0.025)], hi: ms[Math.floor(B * 0.975)], won: v.filter(x => x.won).length / n, worst, dd };
}
const pct = x => (x * 100).toFixed(1).padStart(6) + '%';
for (const h of [3, 1]) {
  const legs = d.rows.filter(x => x.d === h && x.p > 0.02 && x.p < 0.98).map(x => {
    const yesDog = x.p < 0.5;
    return { price: yesDog ? x.p : 1 - x.p, won: yesDog ? x.yesWon : !x.yesWon, cat: cat(x.q), half: hash(x.q) & 1 };
  });
  console.log(`\n=== Underdog, entry ${h} day(s) before end · ${legs.length} markets ===`);
  console.log('band        bets   won    price   return(1¢)  95% CI            return(2¢)  half A   half B   worst streak  max drawdown');
  for (const [lo, hi] of [[0.03, 0.10], [0.10, 0.20], [0.20, 0.30], [0.30, 0.40], [0.40, 0.50], [0.10, 0.40]]) {
    const v = legs.filter(x => x.price >= lo && x.price < hi); if (v.length < 20) continue;
    const s1 = stats(v, 0.01), s2 = stats(v, 0.02), a = stats(v.filter(x => !x.half), 0.01), b = stats(v.filter(x => x.half), 0.01);
    const avg = v.reduce((t, x) => t + x.price, 0) / v.length;
    console.log(`${(Math.round(lo * 100) + '–' + Math.round(hi * 100) + '¢').padEnd(10)} ${String(s1.n).padStart(5)} ${pct(s1.won)} ${(avg * 100).toFixed(1).padStart(5)}¢ ${pct(s1.mean)}   [${pct(s1.lo)}, ${pct(s1.hi)}]  ${pct(s2.mean)}  ${pct(a.mean)}  ${pct(b.mean)}  ${String(s1.worst).padStart(8)}      $${s1.dd.toFixed(0)} on $1 bets`);
  }
  console.log('by category, 10–40¢ underdogs:');
  for (const c of ['sports', 'politics', 'crypto', 'other']) {
    const v = legs.filter(x => x.cat === c && x.price >= 0.10 && x.price < 0.40); if (v.length < 20) continue;
    const s = stats(v, 0.01);
    console.log(`  ${c.padEnd(9)} ${String(s.n).padStart(5)} bets · won ${pct(s.won)} · return ${pct(s.mean)} [${pct(s.lo)}, ${pct(s.hi)}] · worst streak ${s.worst}`);
  }
}
