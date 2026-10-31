// How many reward markets still have positive expected edge if each fill costs X¢/share (adverse move after fill)?
// Real fills on 30 Oct averaged ~9¢/share (share-weighted) — vs ~0.3–1¢ the model assumed.
const E = require('../lib/paper-engine.js');
const Core = E.Core;
(async () => {
  const all = await E.scanMarkets(20);
  const ms = all.filter(m => m.C != null && m.mid >= 0.15 && m.mid <= 0.85 && !E.isHeadline(m.question)).sort((a, b) => (b.refDaily || 0) - (a.refDaily || 0)).slice(0, 40);
  const models = await Promise.all(ms.map(m => E.calibrated(m)));
  console.log(`${all.length} reward markets · ${ms.length} candidates after filters (top 40 by reward)`);
  console.log('markout¢  positive  avg d(¢ from mid)  avg size  sum reward/day  sum cost/day');
  for (const mo of [null, 2, 5, 9, 15]) {
    let n = 0, dd = 0, xx = 0, rew = 0, cost = 0;
    ms.forEach((m, i) => {
      const model = Object.assign({}, models[i], mo == null ? {} : { markout: Math.max(models[i].markout, mo) });
      const sig = model.volL / Math.sqrt(1440) * 100 * m.mid * (1 - m.mid) * 0.8;
      const q = Core.optimalQuote(E.metaOf(m), Math.max(m.C, 0.5 * m.minSize), sig * 1.25, m.mid, 20, model, 0, { maxShares: 1000, allowOneSided: true });
      if (q && q.edge > 0) { n++; dd += q.d; xx += q.x; rew += q.rewDay; cost += q.costDay; }
    });
    console.log(`${String(mo == null ? 'model' : mo).padEnd(9)} ${String(n).padStart(8)}  ${(n ? dd / n : 0).toFixed(2).padStart(17)}  ${(n ? xx / n : 0).toFixed(0).padStart(8)}  ${rew.toFixed(2).padStart(14)}  ${cost.toFixed(2).padStart(12)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
