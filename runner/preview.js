// Live allocation preview: what would the engine fund with $200 right now (real CLOB data)?
const E = require('../lib/paper-engine.js');
(async () => {
  for (const frac of [1, 0.75, 0.5]) {
    const s = E.freshState(200); s.P.maxPerMarketFrac = frac;
    await E.allocate(s, 200);
    console.log(`\n=== maxPerMarketFrac ${frac} ===`);
    s.log.forEach(l => console.log(' ', l.t));
  }
})().catch(e => { console.error(e); process.exit(1); });
