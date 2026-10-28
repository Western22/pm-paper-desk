// Headless check of the Wallets tab: serves the repo statically, injects state/peers.json for the GitHub URL.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const srv = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('{}'); }
  res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(f));
}).listen(8765, async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/raw.githubusercontent.com/**/peers.json*', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(path.join(root, 'state', 'peers.json')) }));
  await p.goto('http://localhost:8765/#wallets');
  await p.click('#tabs button[data-v="wallets"]');
  await p.waitForFunction(() => document.querySelectorAll('#wlBody .panel').length > 0, null, { timeout: 15000 });
  const n = await p.$$eval('#wlBody .panel', x => x.length), rows = await p.$$eval('#wlBody tbody tr', x => x.length);
  const first = await p.$eval('#wlBody .panel .pill', x => x.textContent);
  await p.screenshot({ path: path.join(root, 'state', 'wallets.png'), fullPage: false });
  console.log(`panels ${n} · rows ${rows} · first verdict "${first}" · ${await p.textContent('#wlAsOf')} · page errors ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 3));
  await b.close(); srv.close();
});
