// Live allocation preview: what would the engine fund with $200 right now (real CLOB data)?
const E = require('../lib/paper-engine.js');
(async () => {
  const s = E.freshState(200);
  await E.allocate(s, 200);
  s.log.forEach(l => console.log(' ', l.t));
})().catch(e => { console.error(e); process.exit(1); });
