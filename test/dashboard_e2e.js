// End-to-end: dry-run the live stack, open its private dashboard headlessly, check the panels fill in.
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
const PORT = 8766;
const env = Object.assign({}, process.env, { LIVE: '0', RUN_SEC: '170', DASH_PORT: String(PORT), LIVE_STATE: path.join(__dirname, '..', 'state', 'dash-test-state.json') });
const bot = spawn('python3', [path.join(__dirname, '..', 'bot', 'live_runner.py')], { env });
let out = ''; bot.stdout.on('data', d => { out += d; }); bot.stderr.on('data', d => { out += d; });
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(5000);
  const st0 = await fetch(`http://127.0.0.1:${PORT}/status`).then(r => r.json());
  console.log('status endpoint up · mode', st0.mode, '· engineAge', st0.engineAgeSec);
  await wait(110000); // first market scan + a few ticks
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.waitForTimeout(4000);
  const txt = id => p.textContent('#' + id);
  const nOrders = await p.$$eval('#orders tr', r => r.length), nMk = await p.$$eval('#markets tr', r => r.length), nEv = await p.$$eval('#events li', r => r.length);
  console.log(`mode "${await txt('mode')}" · capital "${await txt('cap')}" · markets·orders "${await txt('mk')}" · paper "${await txt('paper')}" "${await txt('paper2')}"`);
  console.log(`rows: orders ${nOrders} · markets ${nMk} · events ${nEv} · page errors ${errors.length}`);
  const st = await fetch(`http://127.0.0.1:${PORT}/status`).then(r => r.json());
  console.log('secret check:', JSON.stringify(st).includes('PRIVATE') || JSON.stringify(st).includes('0x' + 'a'.repeat(64)) ? 'LEAK' : 'no key material in /status');
  const nf = await fetch(`http://127.0.0.1:${PORT}/../etc/passwd`).then(r => r.status);
  console.log('path traversal →', nf);
  await b.close();
  await new Promise(r => bot.on('exit', r));
  console.log('bot exited cleanly ·', (out.match(/stats: .*/) || [''])[0]);
})().catch(e => { console.error('ERR', e.message, out.slice(-800)); bot.kill(); process.exit(1); });
