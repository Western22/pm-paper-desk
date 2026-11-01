// Headless check of the Underdog tab: serves the repo statically, injects state/underdog.json for the GitHub URL.
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
}).listen(8767, async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/raw.githubusercontent.com/**/underdog.json*', r => r.fulfill({ contentType: 'application/json', body: fs.readFileSync(path.join(root, 'state', 'underdog.json')) }));
  await p.goto('http://localhost:8767/#underdog');
  await p.click('#tabs button[data-v="underdog"]');
  await p.waitForFunction(() => document.querySelectorAll('#udRows tr').length > 0 && document.getElementById('udCount').textContent !== '—', null, { timeout: 15000 });
  console.log(`rows ${await p.$$eval('#udRows tr', x => x.length)} · settled·open "${await p.textContent('#udCount')}" · P&L "${await p.textContent('#udPnl')}" · log lines ${await p.$$eval('#udLog div', x => x.length)} · page errors ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 3));
  await b.close(); srv.close();
});
