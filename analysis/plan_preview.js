// Live allocation preview with competitor crowding: node analysis/plan_preview.js [peers.json]
const fs = require('fs');
const E = require('../lib/paper-engine.js');
(async () => {
  const s = E.freshState(200);
  try { E.learnMakers(s, JSON.parse(fs.readFileSync(process.argv[2] || 'state/peers.json', 'utf8'))); } catch (e) { /* no report */ }
  console.log('known market-maker wallets:', (s.mmWallets || []).length);
  await E.allocate(s, 200);
  s.log.forEach(l => console.log(' ', l.t));
})().catch(e => { console.error(e); process.exit(1); });
