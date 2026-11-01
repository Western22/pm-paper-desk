// One live scan of the underdog forward-test (no state saved): what would it bet on right now?
const U = require('../lib/underdog.js');
(async () => {
  const u = U.fresh();
  await U.scan(u, Date.now());
  for (const l of u.log) console.log(l.t);
})().catch(e => { console.error(e); process.exit(1); });
