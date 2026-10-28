// Live peer-wallet report for the paper account's current positions.
//   git show origin/paper-state:state.json > state/state.json && node analysis/peers_live.js state/state.json
const fs = require('fs');
const { trackPeers, fromState } = require('../lib/peers.js');
const s = JSON.parse(fs.readFileSync(process.argv[2] || 'state/state.json', 'utf8'));
const usd = x => (x >= 0 ? '+$' : '−$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
(async () => {
  const t0 = Date.now();
  const r = await trackPeers(fromState(s));
  fs.writeFileSync('state/peers.json', JSON.stringify(r));
  for (const m of r.markets) {
    if (m.error) { console.log(`\n${m.question.slice(0, 70)} — ${m.error}`); continue; }
    const o = m.ours || {};
    console.log(`\n■ ${m.question.slice(0, 66)} · we hold ${o.shares} ${m.side} @ mark ${o.mark} · our trading ${usd(o.tradingPnl || 0)}, rewards ${usd(o.rewards || 0)}`);
    console.log(`  → ${m.verdict} · same side: ${m.sameSharp} sharp / ${m.makers} market makers of ${m.peers.length} · opposite top-5: ${m.opposite.sharp} sharp`);
    for (const p of m.peers) {
      const r2 = p.record || {};
      console.log(`   ${p.sharp ? '★' : r2.style === 'market maker' ? 'M' : ' '} ${p.short} ${(p.pseudonym || '').padEnd(20).slice(0, 20)} ` +
        `${p.boughtRecent ? `bought ${p.boughtRecent.shares} @${p.boughtRecent.avg}` : 'holder'} ` +
        `| here: ${p.position ? `${usd(p.position.pnl)} (${p.position.pct}%)` : 'exited'} ` +
        `| all-time ${r2.pnl != null ? usd(r2.pnl) : '—'} on $${r2.vol != null ? (r2.vol / 1e6).toFixed(1) + 'M' : '—'} (${r2.margin ?? '—'}%) · 30d ${usd(r2.pnl30d || 0)} · last ${r2.recentClosed} closes ${r2.recentWinRate != null ? Math.round(r2.recentWinRate * 100) + '%' : '—'} won`);
    }
  }
  console.log(`\n${r.markets.length} markets in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
})().catch(e => { console.error(e); process.exit(1); });
