#!/usr/bin/env node
// 24/7 paper-trading runner for GitHub Actions.
//   • ticks the engine every P.tickSec (60 s) against live Polymarket books
//   • persists state/state.json + state/ledger.json to the `paper-state` branch (single force-pushed commit)
//   • re-reads paper-config.json from main every few minutes (running / capital / reset)
//   • exits cleanly before the job limit; the next queued workflow run resumes from the saved state
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const E = require('../lib/paper-engine.js');
const Peers = require('../lib/peers.js');
let peersBusy = false, lastPeers = 0;

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE = path.join(STATE_DIR, 'state.json');
const LEDGER = path.join(STATE_DIR, 'ledger.json');
const MAX_MS = (+process.env.RUN_MINUTES || 345) * 60000;   // GitHub job limit is 360 min
const SAVE_MS = (+process.env.SAVE_MINUTES || 5) * 60000;
const PUSH = process.env.NO_PUSH !== '1';
const t0 = Date.now();
let stopping = false;

const sh = (cmd, cwd = STATE_DIR) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readConfig() {
  // latest config on main (so edits apply without waiting for the next run); fall back to the checked-out copy
  try { if (PUSH) { sh('git fetch -q origin main', ROOT); return JSON.parse(sh('git show origin/main:paper-config.json', ROOT)); } } catch (e) { /* offline / first run */ }
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'paper-config.json'), 'utf8'));
}

function loadState(cfg) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* first run */ }
  const capital = +cfg.capital || 200;
  if (!s || s.v !== 2 || (cfg.resetId || 0) !== (s.resetId || 0)) {
    s = E.freshState(capital, { resetId: cfg.resetId || 0 });
    E.log(s, `NEW PAPER ACCOUNT · bankroll $${capital} · engine: GitHub Actions`, 'q');
  }
  return s;
}

let BOUNDS = {};
try { BOUNDS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agent-bounds.json'), 'utf8')); } catch (e) { /* no bounds file → nothing tunable */ }
/** Only keys listed in agent-bounds.json are tunable, and only inside their [min, max]. */
function applyConfig(s, cfg) {
  for (const [k, b] of Object.entries(BOUNDS)) {
    if (k.startsWith('_') || cfg[k] == null || !isFinite(+cfg[k])) continue;
    const v = Math.min(b.max, Math.max(b.min, +cfg[k]));
    if (v !== +cfg[k]) E.log(s, `CONFIG ${k}=${cfg[k]} outside [${b.min}, ${b.max}] → clamped to ${v}`, 'f');
    if (s.P[k] !== v) { if (s.P[k] != null) E.log(s, `CONFIG ${k}: ${s.P[k]} → ${v}`, 'q'); s.P[k] = v; }
  }
  if (process.env.TICK_SEC) s.P.tickSec = +process.env.TICK_SEC; // tests only
  const want = cfg.running !== false;
  if (want && !s.running) { s.running = true; s.startedAt = s.startedAt || Date.now(); s.lastTick = 0; for (const ms of Object.values(s.markets)) ms.lastT = Date.now();
    E.log(s, `▶ AUTOMATED PAPER TRADING · bankroll $${s.P.capital} · tick ${s.P.tickSec}s · rebalance every ${s.P.rebalanceH} h`, 'q'); }
  if (!want && s.running) { s.running = false; E.log(s, '⏸ paused via paper-config.json', 'g'); }
}

let lastSave = 0, committed = false;
function save(s, why) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const repo = process.env.GITHUB_REPOSITORY || '';
  fs.writeFileSync(STATE, JSON.stringify(s));
  fs.writeFileSync(LEDGER, JSON.stringify(E.publicView(s, { engine: 'github-actions', repo, runId: process.env.GITHUB_RUN_ID || null, savedAt: Date.now() })));
  lastSave = Date.now();
  if (!PUSH) return;
  try {
    sh('git add -A');
    let hasHead = true; try { sh('git rev-parse -q --verify HEAD'); } catch (e) { hasHead = false; }
    const msg = `ledger ${new Date().toISOString().slice(0, 16)}Z · ${why}`;
    sh(hasHead ? `git commit -q --amend -m "${msg}"` : `git commit -q -m "${msg}"`); // one commit, force-pushed: repo stays tiny
    sh('git push -q -f origin HEAD:paper-state');
    committed = true;
  } catch (e) { console.error('push failed:', String(e.stderr || e.message).slice(0, 300)); }
}

async function main() {
  let cfg = readConfig();
  const s = loadState(cfg);
  applyConfig(s, cfg);
  console.log(`runner up · bankroll $${s.P.capital} · ${Object.keys(s.markets).length} markets · running=${s.running}`);
  save(s, 'start');
  let lastCfg = Date.now();
  while (!stopping && Date.now() - t0 < MAX_MS) {
    const started = Date.now();
    let notable = false;
    if (s.running) {
      try { notable = await E.tickOnce(s); } catch (e) { E.log(s, 'tick error: ' + (e.message || e), 'f'); }
      const t = E.totals(s);
      console.log(`${new Date().toISOString().slice(11, 19)} eq $${t.equity.toFixed(2)} pnl ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)} pending $${t.pending.toFixed(4)} paid $${t.paid.toFixed(2)} fills ${t.fills} · ${Object.values(s.markets).map(m => m.status).join(',')}`);
    }
    if (Date.now() - lastCfg > 5 * 60000) {
      lastCfg = Date.now();
      try {
        const c2 = readConfig();
        if ((c2.resetId || 0) !== (s.resetId || 0)) { save(s, 'pre-reset'); console.log('reset requested → restarting fresh'); return 're-exec'; }
        cfg = c2; applyConfig(s, cfg);
      } catch (e) { console.error('config read failed', e.message); }
    }
    // peer wallets: every peersH (3 h) in the background — never delays a tick; published as state/peers.json
    if (s.running && !peersBusy && Date.now() - lastPeers > (s.P.peersH || 3) * 3.6e6) {
      peersBusy = true; lastPeers = Date.now();
      Peers.trackPeers(Peers.fromState(s))
        .then(r => { fs.writeFileSync(path.join(STATE_DIR, 'peers.json'), JSON.stringify(r)); E.applyPeerVerdicts(s, r); E.log(s, `PEERS — ${r.markets.length} positions: ${r.markets.filter(m => /other side/.test(m.verdict)).length} with sharp money on the other side`, 'q'); })
        .catch(e => E.log(s, 'PEERS failed: ' + (e.message || e), 'f'))
        .finally(() => { peersBusy = false; });
    }
    if (notable || Date.now() - lastSave > SAVE_MS) save(s, notable ? 'event' : 'periodic');
    await sleep(Math.max(1000, s.P.tickSec * 1000 - (Date.now() - started)));
  }
  save(s, 'shutdown');
  console.log(`runner exiting after ${((Date.now() - t0) / 60000).toFixed(0)} min · committed=${committed}`);
  return 'done';
}

module.exports = { applyConfig };
if (require.main !== module) return;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; });
main().then(async r => {
  if (r === 're-exec') { fs.rmSync(STATE, { force: true }); const cfg = readConfig(); const s = loadState(cfg); applyConfig(s, cfg); save(s, 'reset'); }
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
