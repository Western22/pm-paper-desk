// Sanity check: competitor count on a known-crowded market (Bank of Brazil) and on one of the new picks.
const fs = require('fs');
const E = require('../lib/paper-engine.js');
const { getJSON } = require('../api/_lib.js');
(async () => {
  const s = E.freshState(200); E.learnMakers(s, JSON.parse(fs.readFileSync('state/peers.json', 'utf8')));
  const mm = new Set(s.mmWallets);
  for (const [name, q] of [['Bank of Brazil', 'cid:0xa2e6fc242fe66e20bb680da04d2e2c425a7a02843e85b5966917bad8f3989703'], ['Government shutdown by Dec 31', 'slug']]) {
    let cid = q.startsWith('cid:') ? q.slice(4) : null;
    if (!cid) { const r = await getJSON('https://gamma-api.polymarket.com/markets?limit=5&closed=false&question=' + encodeURIComponent('Government shutdown by December 31?')); cid = r[0] && r[0].conditionId; }
    const tr = await getJSON(`https://data-api.polymarket.com/trades?market=${cid}&limit=300&takerOnly=false`);
    const c = E.competitorsFromTrades(tr, mm);
    const span = tr.length ? ((tr[0].timestamp - tr[tr.length - 1].timestamp) / 3600).toFixed(1) : 0;
    console.log(`${name}: ${tr.length} trades over ${span} h → ${c.length} competitors (${c.filter(w => mm.has(w)).length} known MMs)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
