/* Live paper trading — quotes against real Polymarket books, simulates fills when the live book
 * trades through a paper quote, accrues modelled liquidity rewards (with Polymarket's $1/day payout
 * floor) and enforces a fixed paper bankroll. No keys, no orders.
 *
 * Engine core (PaperCore) is DOM-free: used by /api/paper on Vercel and unit-tested in Node.
 */
(function (root) {
'use strict';
const Q = root.PMQ || (typeof require !== 'undefined' ? require('./engine.js') : null);

/* ------------------------------------------------------------------ core */
const excess = Q.excess, S = Q.S, qmin = Q.qmin;
const utcDay = t => new Date(t).toISOString().slice(0, 10);

/**
 * Best quote for a USDC `budget`, per minute of expected value, over three modes:
 *   two  — BUY YES @ mid−d and BUY NO @ 1−(mid+d): full score, costs ≈ (1 − 2d)·x
 *   yes  — BUY YES only: 1/c = 1/3 of the score, costs only (mid − d)·x      (mid ∈ [0.10, 0.90])
 *   no   — BUY NO only:  1/3 of the score, costs only (1 − mid − d)·x        (mid ∈ [0.10, 0.90])
 * One-sided quotes are far cheaper on skewed markets, letting a small bankroll cover more pools.
 * With `floor` > 0 a quote whose expected daily reward is below it earns nothing.
 */
function optimalQuote(mk, C, sigMinC, mid, budget, model, floor = 0, opts = {}) {
  const v = mk.v, rate = mk.rate, minSize = mk.minSize, maxShares = opts.maxShares || 1e9;
  const jumpPerMin = model.jumpsPerDay / 1440;
  const jumpC = model.jumpL * 1.6 * 100 * mid * (1 - mid);
  const inner = mid >= 0.1 && mid <= 0.9 && opts.allowOneSided !== false;
  let best = null, bestV = 0;
  for (let d = 0.5; d < v; d += 0.25) {
    const sd = S(v, d);
    const cross = (excess(sigMinC * 1.4, d) + jumpPerMin * excess(jumpC, d)) / 100;
    // taker-flow markout is only ever a cost here: spread capture is uncalibrated, so the paper book
    // never takes credit for it (edge must come from rewards)
    const flow = Math.max(0, (model.noise || 0) * Math.exp(-(model.kappa || 0.8) * d) * 0.35 * ((model.markout || 0) + (model.toxSlope ?? 0.7) * d - d) / 100);
    const modes = [{ mode: 'two', perShare: Math.max(1 - 2 * d / 100, 0.5), sides: 2, div: 1 }];
    if (inner) {
      modes.push({ mode: 'yes', perShare: Math.max(mid - d / 100, 0.01), sides: 1, div: 3 });
      modes.push({ mode: 'no', perShare: Math.max(1 - mid - d / 100, 0.01), sides: 1, div: 3 });
    }
    for (const md of modes) {
      const xMax = Math.min(maxShares, budget / md.perShare);
      if (!(xMax >= minSize)) continue;
      const sizes = [];
      for (let x = Math.max(minSize, 5); x <= xMax * 1.0001; x *= 1.25) sizes.push(x);
      if (sizes[sizes.length - 1] < xMax) sizes.push(xMax);
      for (const x of sizes) {
        const y = sd * x / md.div;
        const rew = rate / 1440 * (y / (y + Math.max(C, 1)));
        const qs = x / (x + Math.max(C, 1) / 0.35);
        const cost = md.sides * (x * cross + qs * x * flow);
        const rewDay = rew * 1440;
        const val = (rewDay >= floor ? rew : 0) - cost;
        if (val > bestV) { bestV = val; best = { d, x, mode: md.mode, edge: val, rewDay, costDay: cost * 1440, capUsed: x * md.perShare }; }
      }
    }
  }
  return best;
}

const DEFAULTS = { tickSec: 60, capital: 200, payoutFloor: 1, marketFloor: 0, maxSize: 1000, invCapFrac: 0.6, gamma: 0.9, gate: 2.6,
  cooldownMin: 20, eventGuardH: 12, maxMarkets: 12, maxPerMarketFrac: 0.75, rebalanceH: 6 };

function newMarketState(meta, model, now, budget = 0) {
  const sigSeed = model.volL / Math.sqrt(1440) * 100 * meta.mid * (1 - meta.mid) * 0.8; // calibrated |Δp| per minute, cents
  return { meta, model, budget, inv: 0, cash: 0, reward: 0, dayReward: 0, rewardPaid: 0, rewardForfeit: 0, day: utcDay(now),
    fills: 0, quote: null, lastMid: null, lastT: now, sigF: Math.max(sigSeed, 1e-4), sigS: Math.max(sigSeed, 1e-4), cool: 0,
    status: 'STARTING', quotedMs: 0, aliveMs: 0, lastC: null, lastShare: 0, edge: 0 };
}

/** USDC tied up in inventory (YES long marked at mid, NO long = short YES marked at 1 − mid). */
function locked(ms) { const mid = ms.lastMid ?? ms.meta.mid; return ms.inv > 0 ? ms.inv * mid : -ms.inv * (1 - mid); }
/** USDC collateral of the resting quote: BUY YES @ bid needs bid·size; BUY NO @ (1−ask) needs (1−ask)·size (sells of held YES need none). */
function collateral(ms) {
  const q = ms.quote; if (!q) return 0;
  return q.bid * Math.max(0, q.bs - Math.max(-ms.inv, 0)) + (1 - q.ask) * Math.max(0, q.as - Math.max(ms.inv, 0));
}

/** One tick for one market. `book` is the raw CLOB book. Returns event strings. */
function step(ms, book, now, P) {
  const ev = [];
  const mk = ms.meta;
  // 0) UTC-day epoch settlement: Polymarket pays each market's daily reward at midnight UTC, only if ≥ $1
  const today = utcDay(now);
  if (ms.day !== today) {
    if (ms.dayReward >= P.payoutFloor) { ms.rewardPaid += ms.dayReward; ev.push(`PAYOUT $${ms.dayReward.toFixed(2)} for ${ms.day}`); }
    else if (ms.dayReward > 0) { ms.rewardForfeit += ms.dayReward; ev.push(`FORFEIT $${ms.dayReward.toFixed(4)} for ${ms.day} (below $${P.payoutFloor} payout floor)`); }
    ms.dayReward = 0; ms.day = today;
  }
  const comp = book ? Q.competition(book, mk.v, mk.minSize) : null;
  const dtMin = Math.min(Math.max((now - ms.lastT) / 60000, 0), 2); // cap gaps at 2 min
  ms.lastT = now; ms.aliveMs += dtMin * 60000;
  if (!comp) { ms.status = 'NO BOOK'; ms.quote = null; return ev; }
  const mid = comp.mid;
  ms.lastC = comp.C;

  // 1) fills: did the live book trade through the resting paper quote?
  const q = ms.quote;
  if (q) {
    if (q.bs > 0 && comp.bestAsk != null && comp.bestAsk <= q.bid + 1e-9) {
      ms.cash -= q.bid * q.bs; ms.inv += q.bs; ms.fills++;
      ev.push(`FILL buy ${q.bs.toFixed(0)} YES @ ${q.bid.toFixed(3)} (ask traded to ${comp.bestAsk.toFixed(3)})`);
    }
    if (q.as > 0 && comp.bestBid != null && comp.bestBid >= q.ask - 1e-9) {
      ms.cash += q.ask * q.as; ms.inv -= q.as; ms.fills++;
      ev.push(`FILL sell ${q.as.toFixed(0)} YES @ ${q.ask.toFixed(3)} (bid traded to ${comp.bestBid.toFixed(3)})`);
    }
    // 2) reward accrual for the interval the quote was resting (scored vs current adjusted mid)
    const bs = q.bs >= mk.minSize ? q.bs : 0, as = q.as >= mk.minSize ? q.as : 0;
    const my = qmin(S(mk.v, (mid - q.bid) * 100) * bs, S(mk.v, (q.ask - mid) * 100) * as, mid);
    const share = my > 0 ? my / (my + comp.C) : 0;
    const r = mk.rate / 1440 * share * dtMin;
    ms.reward += r; ms.dayReward += r;
    ms.lastShare = share;
    if (bs > 0 || as > 0) ms.quotedMs += dtMin * 60000; // one-sided quotes earn (⅓ score) too
  }

  // 3) volatility EWMA (per tick → per minute)
  const perMin = Math.sqrt(60 / P.tickSec);
  let shock = false;
  if (ms.lastMid != null) {
    const d = Math.abs(mid - ms.lastMid) * 100 * perMin;
    const aF = 1 - Math.exp(-Math.LN2 * (P.tickSec / 60) / 5), aS = 1 - Math.exp(-Math.LN2 * (P.tickSec / 60) / 240);
    // a jump only matters if it's large vs the reward band; thin books tick by ½–1¢ without information
    shock = d > 4 * Math.max(ms.sigS, 0.02) && Math.abs(mid - ms.lastMid) * 100 >= Math.max(1.5, 0.4 * mk.v);
    ms.sigF += aF * (d - ms.sigF); ms.sigS += aS * (d - ms.sigS);
  }
  ms.lastMid = mid;

  // 4) guards
  const hoursLeft = mk.endTs ? (mk.endTs - now) / 3.6e6 : null;
  if (hoursLeft != null && hoursLeft < P.eventGuardH) {
    if (ms.status !== 'EVENT GUARD') ev.push(`EVENT GUARD — resolves in ${hoursLeft.toFixed(1)} h, quotes pulled`);
    ms.status = 'EVENT GUARD'; ms.quote = null; return ev;
  }
  // absolute floor: below ~0.3¢/min a 60 s requote keeps up, so a calm-vs-calmer ratio is no reason to pull
  if (shock || ms.sigF > Math.max(P.gate * ms.sigS, P.gateFloor ?? 0.3)) {
    if (ms.cool <= 0) ev.push(`GATE — fast vol ${ms.sigF.toFixed(3)}¢/min vs slow ${ms.sigS.toFixed(3)}¢/min, pulling for ${P.cooldownMin} min`);
    ms.cool = Math.ceil(P.cooldownMin * 60 / P.tickSec);
  }
  if (ms.cool > 0) { ms.cool--; ms.status = 'GATED'; ms.quote = null; return ev; }

  // 5) capital: this market's budget minus USDC already tied up in inventory
  const budget = ms.budget || P.maxSize;
  const free = Math.max(0, budget - locked(ms));
  const invCap = Math.max(mk.minSize, P.invCapFrac * budget / Math.max(Math.min(mid, 1 - mid), 0.05));
  const longYes = Math.max(ms.inv, 0), longNo = Math.max(-ms.inv, 0); // held shares can be SOLD with no new collateral

  // 6) quote — the $1 payout floor is account-level (settled by the engine), so no per-market floor here
  const best = optimalQuote(mk, comp.C, ms.sigS * 1.25, mid, free, ms.model, P.marketFloor ?? 0, { maxShares: P.maxSize, allowOneSided: P.oneSided !== false });
  const z = Math.max(-1, Math.min(1, ms.inv / invCap));
  if (!best && Math.abs(ms.inv) < mk.minSize) {
    const cheap = mk.minSize * Math.max(Math.min(mid, 1 - mid), 0.01);
    const st = free < cheap ? 'NO CAPITAL' : 'STANDBY';
    const why = st === 'NO CAPITAL' ? `NO CAPITAL — $${free.toFixed(2)} free < $${cheap.toFixed(2)} for min size ${mk.minSize}` : `STANDBY — no positive edge (C=${Math.round(comp.C).toLocaleString()})`;
    if (ms.status !== st) ev.push(why);
    ms.status = st; ms.quote = null; ms.edge = 0; return ev;
  }
  const mode = best ? best.mode : 'unwind';
  const d = best ? best.d : mk.v * 0.6;
  const x = best ? best.x : Math.max(mk.minSize, Math.abs(ms.inv));
  const tick = +(book.tick_size || mk.tick || 0.01);
  const centre = mid - P.gamma * z * (mk.v / 2) / 100;
  let bid = Math.floor((centre - d / 100) / tick + 1e-9) * tick;
  let ask = Math.ceil((centre + d / 100) / tick - 1e-9) * tick;
  if (comp.bestAsk != null && bid >= comp.bestAsk) bid = comp.bestAsk - tick; // post-only: never cross
  if (comp.bestBid != null && ask <= comp.bestBid) ask = comp.bestBid + tick;
  bid = Math.max(tick, Math.min(bid, 1 - tick)); ask = Math.max(tick, Math.min(ask, 1 - tick));
  const ok = n => (n >= mk.minSize ? n : 0);
  let bs = 0, as = 0;
  if (mode === 'two') {
    bs = x * Math.max(0, 1 - Math.max(z, 0)); as = x * Math.max(0, 1 + Math.min(z, 0));
    bs = bs < mk.minSize && z > 0.95 ? 0 : Math.max(bs, mk.minSize);
    as = as < mk.minSize && z < -0.95 ? 0 : Math.max(as, mk.minSize);
  } else if (mode === 'yes') {           // BUY YES only; offer held YES back for free (adds the other side's score)
    bs = ok(x * Math.max(0, 1 - Math.max(z, 0))) || (z <= 0.95 ? mk.minSize : 0); as = ok(Math.min(longYes, x));
  } else if (mode === 'no') {            // BUY NO only; offer held NO back (= BUY YES funded by NO shares)
    as = ok(x * Math.max(0, 1 + Math.min(z, 0))) || (z >= -0.95 ? mk.minSize : 0); bs = ok(Math.min(longNo, x));
  } else {                               // unwind only
    if (ms.inv > 0) as = Math.max(mk.minSize, ms.inv); else bs = Math.max(mk.minSize, -ms.inv);
  }
  // hard capital check: only legs not covered by held shares need USDC; shrink them to fit the free budget
  let collB = Math.max(0, bs - longNo), collA = Math.max(0, as - longYes);
  const need = bid * collB + (1 - ask) * collA;
  if (need > free + 1e-9) {
    const k = need > 0 ? free / need : 0;
    collB *= k; collA *= k;
    bs = ok(Math.min(bs, longNo) + collB); as = ok(Math.min(as, longYes) + collA);
    if (bs === 0 && as === 0) { ms.status = 'NO CAPITAL'; ms.quote = null; return ev; }
  }
  bs = Math.floor(bs); as = Math.floor(as);
  const nq = { bid: +bid.toFixed(4), ask: +ask.toFixed(4), bs, as, mode };
  const used = nq.bid * Math.max(0, bs - longNo) + (1 - nq.ask) * Math.max(0, as - longYes);
  if (!q || q.bid !== nq.bid || q.ask !== nq.ask || Math.abs(q.bs - bs) > 1e-6 || Math.abs(q.as - as) > 1e-6)
    ev.push(`${q ? 'REQUOTE' : 'POST'} ${mode.toUpperCase()} bid ${nq.bid.toFixed(3)}×${bs} / ask ${nq.ask.toFixed(3)}×${as} · mid ${(mid * 100).toFixed(1)}¢ · d ${d.toFixed(2)}¢ · uses $${used.toFixed(2)} of $${free.toFixed(2)} free`);
  ms.quote = nq; ms.status = best ? 'QUOTING' : 'UNWIND'; ms.edge = best ? best.edge * 1440 : 0;
  return ev;
}

function mtm(ms) { const mid = ms.lastMid ?? ms.meta.mid; return ms.cash + ms.inv * mid; }

/**
 * Greedy capital allocation: give $chunk at a time to whichever market gains the most expected
 * net $/day (reward above the payout floor − crossing/markout cost) from it. First dollars into a
 * market must cover its min size. Returns [{i, budget, best}] for markets that got capital.
 */
function allocateCapital(cands, capital, floor, maxMarkets, chunk = 5, maxPer = Infinity, seed = null) {
  // cands: [{mk, C, sig, mid, model}]
  const val = (c, b) => { const q = optimalQuote(c.mk, c.C, c.sig * 1.25, c.mid, b, c.model, floor, c.opts); return q ? q.edge * 1440 : 0; };
  // cheapest way into a market: one-sided on the cheap side when allowed, else a two-sided pair
  const entry = c => c.mk.minSize * (c.mid >= 0.1 && c.mid <= 0.9 && !(c.opts && c.opts.allowOneSided === false) ? Math.max(Math.min(c.mid, 1 - c.mid) - 0.005, 0.01) : 0.98);
  // `seed` pre-funds markets (e.g. one market at its two-sided threshold) before the greedy fills the rest —
  // the value curve jumps at mode thresholds, which pure $5-step greedy can't see
  const budget = cands.map((c, i) => (seed && seed[i]) || 0), cur = cands.map((c, i) => budget[i] ? val(c, budget[i]) : 0);
  let left = capital - budget.reduce((a, b) => a + b, 0);
  for (let guard = 0; guard < 2000 && left >= chunk; guard++) {
    let bi = -1, bg = 0, bc = 0;
    const funded = budget.filter(b => b > 0).length;
    cands.forEach((c, i) => {
      if (budget[i] === 0 && funded >= maxMarkets) return;
      const step = budget[i] === 0 ? Math.max(chunk, Math.ceil(entry(c) / chunk) * chunk) : chunk;
      if (step > left || budget[i] + step > maxPer) return; // per-market cap forces diversification
      const g = (val(c, budget[i] + step) - cur[i]) / step;
      if (g > bg) { bg = g; bi = i; bc = step; }
    });
    if (bi < 0) break;
    budget[bi] += bc; left -= bc; cur[bi] = val(cands[bi], budget[bi]);
  }
  const qAt = (c, b) => optimalQuote(c.mk, c.C, c.sig * 1.25, c.mid, b, c.model, floor, c.opts);
  return cands.map((c, i) => { const q = budget[i] ? qAt(c, budget[i]) : null; return { i, budget: budget[i], edgeDay: cur[i], rewDay: q ? q.rewDay : 0, mode: q ? q.mode : null }; }).filter(r => r.budget > 0);
}

const PaperCore = { optimalQuote, step, newMarketState, mtm, locked, collateral, allocateCapital, utcDay, DEFAULTS };
if (typeof module !== 'undefined' && module.exports) { module.exports = PaperCore; return; }
root.PMPaper = PaperCore;
/* ------------------------------------------------------------------ UI (client of /api/paper on Vercel) */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const KEYSTORE = 'ld.paper.adminKey';

const style = document.createElement('style');
style.textContent = `
#v-paper .pk{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:14px}
#v-paper .pill.run{border-color:var(--mint);color:var(--mint)} #v-paper .pill.stop{border-color:var(--amber);color:var(--amber)}
#v-paper .st{font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:5px;letter-spacing:.06em;white-space:nowrap}
#v-paper .st.QUOTING{background:rgba(61,255,168,.14);color:var(--mint)} #v-paper .st.GATED,#v-paper .st.UNWIND{background:rgba(255,181,71,.14);color:var(--amber)}
#v-paper .st.STANDBY,#v-paper .st.STARTING{background:rgba(120,150,200,.14);color:var(--tx2)} #v-paper .st.guard,#v-paper .st.nobook{background:rgba(255,93,115,.14);color:var(--red)}
#v-paper .plog{font-family:var(--mono);font-size:11px;line-height:1.55;background:rgba(3,5,10,.8);border:1px solid var(--line);border-radius:10px;padding:10px;height:260px;overflow:auto;white-space:pre-wrap;color:#cfe3ff}
#v-paper .plog .f{color:var(--red)} #v-paper .plog .g{color:var(--amber)} #v-paper .plog .q{color:var(--mint)}
@media (max-width:1100px){#v-paper .pk{grid-template-columns:repeat(3,1fr)}}
@media (max-width:640px){#v-paper .pk{grid-template-columns:1fr 1fr}}`;
document.head.appendChild(style);

let view = null, scanCache = null, driving = false;
const adminKey = () => { try { return localStorage.getItem(KEYSTORE) || ''; } catch (e) { return ''; } };

async function getJ(p, opt) { const r = await fetch(p, Object.assign({ cache: 'no-store' }, opt)); const j = await r.json().catch(() => ({ ok: false, error: r.status })); if (!r.ok || j.ok === false) throw new Error(j.error || r.status); return j; }

async function admin(action, extra = '') {
  if (view && view.engine === 'github-actions') {
    const url = `https://github.com/${view.repo}/edit/main/paper-config.json`;
    if (confirm('This paper account runs on GitHub Actions. Controls live in paper-config.json:\n\n• "running": true/false — pause or resume\n• "capital": bankroll in USDC\n• "resetId": bump the number to start a fresh account\n\nOpen the file on GitHub to edit it now?')) window.open(url, '_blank', 'noopener');
    return;
  }
  let key = adminKey();
  if (!key) {
    key = prompt('Paper-trading admin key (PAPER_ADMIN_KEY in your Vercel project → Settings → Environment Variables):') || '';
    if (!key) return;
    try { localStorage.setItem(KEYSTORE, key); } catch (e) { /* session only */ }
  }
  setBusy(true);
  try { view = await getJ(`/api/paper?action=${action}${extra}`, { method: 'POST', headers: { 'x-admin-key': key } }); }
  catch (e) {
    if (String(e.message).includes('admin key')) { try { localStorage.removeItem(KEYSTORE); } catch (x) { /* ignore */ } alert('Admin key rejected.'); }
    else alert(action + ' failed: ' + e.message);
  }
  setBusy(false); render();
}
function setBusy(b) { ['#ppStart', '#ppAuto', '#ppAdd', '#ppReset'].forEach(s => { const el = $(s); if (el) el.disabled = b; }); }

async function refresh() { try { view = await getJ('/api/paper'); render(); } catch (e) { $('#ppPace').textContent = 'server ledger unreachable: ' + e.message; } }

// Any open desk tab keeps the server engine ticking (throttled server-side, so many tabs are safe).
async function drive() {
  if (driving || !view || !view.running || document.hidden || view.engine === 'github-actions') return;
  if (Date.now() - (view.lastTick || 0) < (view.P.tickSec * 1000 - 1500)) return;
  driving = true;
  try { view = await getJ('/api/paper?action=tick'); render(); } catch (e) { /* next round */ }
  driving = false;
}

function stCls(s) { return s === 'EVENT GUARD' ? 'guard' : s === 'NO BOOK' ? 'nobook' : s; }

function render() {
  if (!$('#v-paper') || !view) return;
  const t = view.totals, runH = view.startedAt ? (Date.now() - view.startedAt) / 3.6e6 : 0;
  const gh = view.engine === 'github-actions';
  const stale = view.running && Date.now() - (view.lastTick || 0) > (gh ? 12 * 60000 : 150000);
  $('#ppState').className = 'pill ' + (view.running ? 'run' : 'stop');
  $('#ppState').innerHTML = view.booting ? '<span class="dot demo"></span>BOOTING · first GitHub Actions run starting'
    : view.running ? (stale ? '<span class="dot demo"></span>RUNNING · waiting for next run' : `<span class="dot"></span>LIVE PAPER · ${gh ? 'GitHub Actions 24/7' : 'server'}`) : '<span class="dot demo"></span>PAUSED';
  $('#ppStart').textContent = gh ? '⚙ Controls (GitHub)' : view.running ? '⏸ Pause' : '▶ Start paper trading';
  if ($('#ppEngine')) $('#ppEngine').innerHTML = gh ? `engine <a href="https://github.com/${esc(view.repo)}/actions" target="_blank" rel="noopener">${esc(view.repo)} · Actions</a> · ledger saved ${view.savedAt ? Math.round((Date.now() - view.savedAt) / 60000) + ' min ago' : '—'} · <a href="https://github.com/${esc(view.repo)}/blob/main/paper-config.json" target="_blank" rel="noopener">paper-config.json</a>` : '';
  ['#ppAuto', '#ppAdd', '#ppMarket', '#ppSize', '#ppGuard', '#ppForget'].forEach(s2 => { const el = $(s2); if (el) el.style.display = gh ? 'none' : ''; });
  const nowD = new Date(), nextUTC = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() + 1), hrs = (nextUTC - nowD) / 3.6e6;
  const k = [
    ['Equity (of $' + (t.capital || 0).toLocaleString() + ')', usd(t.equity), t.pnl >= 0 ? 'pos' : 'neg', `P&L ${t.pnl >= 0 ? '+' : ''}${usd(t.pnl)} · ${((t.pnl / (t.capital || 1)) * 100).toFixed(2)}%`],
    ['Rewards paid', usd(t.paid), 'pos', `forfeited (< $${view.P.payoutFloor}/day) ${usd(t.forfeit, 4)}`],
    ['Pending payout', usd(t.pending, 4), 'warn', `settles 00:00 UTC · in ${Math.floor(hrs)}h ${Math.round((hrs % 1) * 60)}m`],
    ['Trading P&L (MTM)', usd(t.trade), t.trade >= 0 ? 'pos' : 'neg', `${t.fills} paper fills`],
    ['Capital at work', usd(t.collateral + t.lockedInv), '', `quotes ${usd(t.collateral)} · inventory ${usd(t.lockedInv)} · idle ${usd(t.unallocated)}`],
    ['Two-sided uptime', Math.round(t.uptime * 100) + '%', '', `run ${runH < 1 ? Math.round(runH * 60) + ' min' : runH < 48 ? runH.toFixed(1) + ' h' : (runH / 24).toFixed(1) + ' d'}`]];
  $('#ppKpi').innerHTML = k.map(([l, v, c, s]) => `<div class="panel kpi"><label>${l}</label><div class="v ${c}" style="font-size:20px">${v}</div><div class="s">${s}</div></div>`).join('');
  const last = view.lastTick ? Math.round((Date.now() - view.lastTick) / 1000) + ' s ago' : 'never';
  const nextReb = view.lastRebalance ? Math.max(0, (view.lastRebalance + view.P.rebalanceH * 3.6e6 - Date.now()) / 3.6e6).toFixed(1) + ' h' : '—';
  $('#ppPace').textContent = `automated · last server tick ${last} · next rebalance in ${nextReb}` + (runH > 0.05 ? ` · reward pace ≈ ${usd(t.reward / runH * 24)}/day` : '') + ` · model edge of live quotes ≈ ${usd(t.edge)}/day`;
  $('#ppRows').innerHTML = view.markets.length ? view.markets.map(m => {
    const q = m.quote;
    return `<tr><td><div class="q" title="${esc(m.question)}">${esc(m.question)}</div></td><td><span class="st ${stCls(m.status)}">${m.status}</span></td>
      <td>${m.mid != null ? (m.mid * 100).toFixed(1) + '¢' : '—'}</td><td>${q ? q.bid.toFixed(2) + ' / ' + q.ask.toFixed(2) : '—'}</td><td>${q ? Math.round(q.bs) + ' / ' + Math.round(q.as) : '—'}</td>
      <td>${m.C != null ? Math.round(m.C).toLocaleString() : '—'}</td><td>${((m.share || 0) * 100).toFixed(2)}%</td><td>${usd(m.budget, 0)}</td><td>${Math.round(m.inv)}</td>
      <td class="warn">${usd(m.pending, 4)}</td><td class="pos">${usd(m.paid)}</td><td class="${m.mtm >= 0 ? 'pos' : 'neg'}">${usd(m.mtm)}</td><td><button class="btn" data-rm="${esc(m.id)}" style="padding:3px 8px" title="close (admin)">✕</button></td></tr>`;
  }).join('') : '<tr><td colspan="13" class="dimmer" style="text-align:center;padding:24px">No markets funded yet — the allocator runs on start and every few hours.</td></tr>';
  const hb = $('#ppHist');
  if (hb) hb.innerHTML = (view.history || []).slice().reverse().map(h => `<tr><td>${h.day}</td><td>${usd(h.equity)}</td><td class="pos">${usd(h.paid)}</td><td class="neg">${usd(h.forfeit, 4)}</td><td class="${h.trade >= 0 ? 'pos' : 'neg'}">${usd(h.trade)}</td><td>${h.fills}</td><td>${h.markets}</td></tr>`).join('') || '<tr><td colspan="7" class="dimmer" style="text-align:center">first daily snapshot after the first tick</td></tr>';
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (confirm('Remove this market from the paper book?')) admin('remove', '&id=' + encodeURIComponent(b.dataset.rm)); });
  const lg = $('#ppLog');
  lg.innerHTML = view.log.map(l => `<span class="${l.cls}">${l.ts} ${esc(l.t)}</span>`).join('\n');
  lg.scrollTop = lg.scrollHeight;
  if (scanCache) {
    const sel = $('#ppMarket'), cur = sel.value;
    sel.innerHTML = '<option value="">add a market…</option>' + scanCache.markets.filter(m => m.C != null).map(m => `<option value="${esc(m.id)}">${esc(m.question.slice(0, 70))} · ${usd(m.rate, 0)}/d · safe ${m.safePassed}/6</option>`).join('');
    sel.value = cur;
  }
  if (document.activeElement !== $('#ppSize')) $('#ppSize').value = view.P.maxSize;
  if (document.activeElement !== $('#ppGuard')) $('#ppGuard').value = view.P.eventGuardH;
}

function drawEq() {
  const cv = $('#ppEq'); if (!cv || !cv.clientWidth || !view) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = 220;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.font = '11px JetBrains Mono, monospace';
  const pts = view.eq; const x0 = 64, x1 = w - 10, y0 = 10, y1 = h - 20;
  c.fillStyle = '#5e6a80';
  if (pts.length < 2) { c.fillText('equity curve appears after the first server ticks', x0, h / 2); return; }
  // plot P&L vs the starting bankroll (green) and cumulative rewards (amber)
  pts.forEach(p => { if (p.pnl == null) p.pnl = p.eq - (view.totals.capital || 0); });
  let lo = Math.min(0, ...pts.map(p => Math.min(p.pnl, p.rw))), hi = Math.max(0, ...pts.map(p => Math.max(p.pnl, p.rw)));
  if (hi - lo < 0.01) { hi += 0.005; lo -= 0.005; }
  const ta = pts[0].t, tb = pts[pts.length - 1].t || ta + 1;
  const X = t => x0 + (t - ta) / Math.max(tb - ta, 1) * (x1 - x0), Y = v => y1 - (v - lo) / (hi - lo) * (y1 - y0);
  c.strokeStyle = 'rgba(120,150,200,.14)'; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, y = Y(v); c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); c.fillText(usd(v, Math.abs(hi - lo) < 1 ? 3 : 2), x0 - 6, y); }
  const line = (k, col, wd) => { c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(X(p.t), Y(p[k])) : c.moveTo(X(p.t), Y(p[k]))); c.strokeStyle = col; c.lineWidth = wd; c.stroke(); };
  c.strokeStyle = 'rgba(230,237,247,.3)'; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x1, Y(0)); c.stroke(); c.setLineDash([]);
  line('rw', '#ffb547', 1.4); line('pnl', '#3dffa8', 2.2);
  const l = pts[pts.length - 1]; c.fillStyle = '#3dffa8'; c.beginPath(); c.arc(X(l.t), Y(l.pnl), 4 + 1.5 * Math.sin(performance.now() / 250), 0, 6.28); c.fill();
}

function mount() {
  $('#ppStart').onclick = () => admin(view && view.running ? 'stop' : 'start');
  $('#ppAuto').onclick = () => admin('autopick');
  $('#ppAdd').onclick = () => { const id = $('#ppMarket').value; if (id) admin('add', '&id=' + encodeURIComponent(id)); };
  $('#ppReset').onclick = () => {
    const cap = prompt('Start a NEW paper account with bankroll (USDC). The current ledger is archived.', String((view && view.totals.capital) || 200));
    if (cap && +cap > 0) admin('reset', '&capital=' + Math.round(+cap));
  };
  $('#ppSize').onchange = e => admin('params', '&maxSize=' + Math.max(10, +e.target.value || 1000));
  $('#ppGuard').onchange = e => admin('params', '&eventGuardH=' + Math.max(0, +e.target.value || 12));
  $('#ppForget').onclick = () => { try { localStorage.removeItem(KEYSTORE); } catch (e) { /* ignore */ } alert('Admin key forgotten on this browser.'); };
  fetch('/api/scan?n=80&size=1000', { cache: 'no-store' }).then(r => r.json()).then(j => { if (j.ok) { scanCache = j; render(); } }).catch(() => {});
  refresh();
  setInterval(refresh, 5000);
  setInterval(drive, 3000);
  setInterval(drawEq, 250);
}
mount();
})(typeof window !== 'undefined' ? window : globalThis);
