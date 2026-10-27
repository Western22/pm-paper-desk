// /api/paper — paper-trading ledger for the desk.
//
// Engine modes:
//   • GitHub Actions (PAPER_LEDGER_URL set): the 24/7 engine runs in Actions and force-pushes ledger.json to the
//     repo's `paper-state` branch; this route just serves it. Controls live in paper-config.json on GitHub.
//   • Vercel Blob (fallback): engine state in a private Blob, ticked by open desk tabs / any pinger.
//
//   GET  /api/paper                      ledger snapshot
//   GET  /api/paper?action=tick          advance the engine (Blob mode only)
//   POST /api/paper?action=start|stop|reset[&capital=]|rebalance|add&id=|remove&id=|params&k=v   (Blob mode; x-admin-key)
const E = require('../lib/paper-engine.js');
const { send } = require('./_lib.js');

const LEDGER_URL = process.env.PAPER_LEDGER_URL || '';
const REPO = process.env.PAPER_REPO || '';
const PATH = 'paper/state.json';
const TICK_GAP_MS = 12000;

async function githubLedger() {
  const bust = Math.floor(Date.now() / 30000); // ≤ 1 origin fetch / 30 s
  const r = await fetch(`${LEDGER_URL}?v=${bust}`, { headers: { 'user-agent': 'pm-liquidity-desk/1.0', accept: 'application/json' } });
  if (r.status === 404) return { ok: true, engine: 'github-actions', repo: REPO, running: false, booting: true, P: E.Core.DEFAULTS, totals: E.totals(E.freshState(200)), markets: [], log: [], eq: [], history: [], serverTime: Date.now() };
  if (!r.ok) throw new Error(`ledger fetch ${r.status}`);
  const j = await r.json();
  return Object.assign(j, { engine: 'github-actions', repo: j.repo || REPO, serverTime: Date.now() });
}

// ---------------- Blob fallback ----------------
const blob = () => require('@vercel/blob');
async function loadState() {
  try {
    const r = await blob().get(PATH, { access: 'private', useCache: false });
    if (r && r.statusCode === 200) { const s = JSON.parse(await new Response(r.stream).text()); if (s.v === 2) return s; }
  } catch (e) { if (!/not.?found|404/i.test(String(e && e.message))) throw e; }
  return E.freshState();
}
async function putJSON(path, obj) {
  await blob().put(path, JSON.stringify(obj), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
}

module.exports = async (req, res) => {
  const action = String(req.query.action || '');
  try {
    if (LEDGER_URL) {
      if (req.method === 'POST') return send(res, 409, { ok: false, error: `The engine runs on GitHub Actions — change it by editing paper-config.json in ${REPO || 'the repo'}.`, repo: REPO });
      return send(res, 200, Object.assign(await githubLedger(), action === 'tick' ? { ticked: 0, note: 'engine runs on GitHub Actions' } : {}), 's-maxage=20, stale-while-revalidate=60');
    }

    if (!action) return send(res, 200, E.publicView(await loadState(), { engine: 'vercel-blob' }), 'no-store');
    if (action === 'tick') {
      const s = await loadState();
      if (!s.running || Date.now() - s.lastTick < TICK_GAP_MS) return send(res, 200, E.publicView(s, { engine: 'vercel-blob', ticked: 0 }), 'no-store');
      await E.tickOnce(s); await putJSON(PATH, s);
      return send(res, 200, E.publicView(s, { engine: 'vercel-blob', ticked: 1 }), 'no-store');
    }
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!process.env.PAPER_ADMIN_KEY || key !== process.env.PAPER_ADMIN_KEY) return send(res, 401, { ok: false, error: 'admin key required' });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST required' });
    let s = await loadState(), extra = {};
    if (action === 'reset') {
      if (Object.keys(s.markets).length || s.eq.length) await putJSON(`paper/archive/${new Date().toISOString().replace(/[:.]/g, '-')}.json`, s);
      const cap = +req.query.capital > 0 ? +req.query.capital : s.P.capital;
      s = E.freshState(cap); E.log(s, `NEW PAPER ACCOUNT · bankroll $${cap} (previous ledger archived)`, 'q');
    } else if (action === 'rebalance' || action === 'autopick') extra = await E.rebalance(s);
    else if (action === 'start') {
      if (!Object.keys(s.markets).length) extra = await E.rebalance(s);
      s.running = true; s.startedAt = s.startedAt || Date.now(); s.lastTick = 0; for (const ms of Object.values(s.markets)) ms.lastT = Date.now();
      E.log(s, `▶ PAPER TRADING STARTED · bankroll $${s.P.capital}`, 'q');
    } else if (action === 'stop') { s.running = false; E.log(s, '⏸ paused', 'g'); }
    else if (action === 'remove') E.closeMarket(s, String(req.query.id || ''), 'manual');
    else if (action === 'add') {
      const id = String(req.query.id || '');
      const used = Object.values(s.markets).reduce((a, ms) => a + (ms.budget || 0), 0), free = s.P.capital - used;
      const m = (await E.scanMarkets(Math.max(10, Math.round(free)))).find(x => String(x.id) === id);
      if (!m) return send(res, 404, { ok: false, error: 'market not in current reward scan' });
      if (free < m.minSize * 0.98) return send(res, 400, { ok: false, error: `need ≥ $${m.minSize} free; $${free.toFixed(0)} unallocated` });
      if (!s.markets[id]) { s.markets[id] = E.Core.newMarketState(E.metaOf(m), await E.calibrated(m), Date.now(), Math.floor(free)); E.log(s, `ALLOCATE $${Math.floor(free)} → ${m.question.slice(0, 64)} · manual`, 'q'); }
    } else if (action === 'params') {
      for (const k of ['maxSize', 'eventGuardH', 'maxMarkets', 'gamma', 'gate', 'cooldownMin', 'rebalanceH', 'payoutFloor']) if (req.query[k] != null && isFinite(+req.query[k])) s.P[k] = +req.query[k];
    } else return send(res, 400, { ok: false, error: 'unknown action' });
    await putJSON(PATH, s);
    return send(res, 200, E.publicView(s, Object.assign({ engine: 'vercel-blob' }, extra)), 'no-store');
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
};
