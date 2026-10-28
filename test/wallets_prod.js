// Production check of the Wallets tab against the real published report.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.goto('https://pm-liquidity-desk.vercel.app/#wallets', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.click('#tabs button[data-v="wallets"]');
  await p.waitForFunction(() => document.querySelectorAll('#wlBody .panel').length > 0 || /unavailable/.test(document.querySelector('#wlAsOf').textContent), null, { timeout: 30000 });
  const verdicts = await p.$$eval('#wlBody .panel .pill', x => x.map(e => e.textContent));
  console.log(await p.textContent('#wlAsOf'), '·', verdicts.length, 'panels ·', verdicts.filter(v => /other side/.test(v)).length, 'warnings · page errors', errors.length);
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
