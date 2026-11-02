// Writes state/underdog.json from one live scan (for the headless UI check).
const fs = require('fs');
const U = require('../lib/underdog.js');
(async () => { const u = U.fresh(); await U.scan(u, Date.now()); fs.mkdirSync('state', { recursive: true }); fs.writeFileSync('state/underdog.json', JSON.stringify(U.publicView(u))); console.log('fixture', u.bets.length, 'bets'); })();
