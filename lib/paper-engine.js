// Shared paper-trading engine: state transitions only, storage-agnostic.
// Used by the GitHub Actions runner (runner/run.js) and the Vercel API (api/paper.js).
const Core = require('../paper.js');
const Q = require('../engine.js');
const { CLOB, getJSON } = require('../api/_lib.js');

function freshState(capital, extra = {}) {
  const P = Object.assign({}, Core.DEFAULTS);
  if (capital) P.capital = capital;
  return Object.assign({ v: 2, running: false, startedAt: null, lastTick: 0, lastRebalance: 0, P, markets: {}, log: [], eq: [], closed: 0, closedRewards: 0, history: [] }, extra);
}

function log(s, t, cls = '') {
  s.log.push({ ts: new Date().toISOString().slice(5, 16).replace('T', ' '), t, cls });
  if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
}
const tag = ms => '[' + ms.meta.question.slice(0, 28) + ']';
const cls = e => /^(FILL|FORFEIT)/.test(e) ? 'f' : /^(GATE|EVENT|STANDBY|NO CAPITAL)/.test(e) ? 'g' : /^(POST|REQUOTE|PAYOUT)/.test(e) ? 'q' : '';

function totals(s) {
  let pending = s.closedPending || 0, paid = s.closedRewards || 0, forfeit = 0, trade = s.closed || 0, fills = 0, quoted = 0, alive = 0, edge = 0, lockedInv = 0, coll = 0, budget = 0;
  for (const ms of Object.values(s.markets)) {
    pending += ms.dayReward; paid += ms.rewardPaid; forfeit += ms.rewardForfeit; trade += Core.mtm(ms); fills += ms.fills;
    quoted += ms.quotedMs; alive += ms.aliveMs; lockedInv += Core.locked(ms); coll += Core.collateral(ms); budget += ms.budget || 0;
    if (ms.status === 'QUOTING') edge += ms.edge;
  }
  forfeit += s.closedForfeit || 0;
  const capital = s.P.capital;
  const equity = capital + paid + trade; // pending rewards shown separately (paid at 00:00 UTC if ≥ $1)
  return { capital, equity, equityInclPending: equity + pending, pnl: equity - capital, paid, pending, forfeit, trade, fills,
    uptime: alive ? quoted / alive : 0, edge, lockedInv, collateral: coll, allocated: budget, unallocated: Math.max(0, capital - budget),
    reward: paid + pending };
}

async function scanMarkets(size) {
  const scan = require('../api/scan.js');
  const res = { headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
  await scan({ query: { n: '120', size: String(size) } }, res); // widest scan: small pools often have small min sizes
  if (!res.body || !res.body.ok) throw new Error('scan failed: ' + (res.body && res.body.error));
  return res.body.markets;
}
async function calibrated(m) {
  let hist = null;
  try { hist = (await getJSON(`${CLOB}/prices-history?market=${m.tokens[0].id}&interval=1w&fidelity=60`, {}, 8000)).history; } catch (e) { /* preset */ }
  const env = Q.calibrate(Object.assign({ toxSlope: 0.7 }, Q.PRESETS.politics), { history: hist, comp: { mid: m.mid, C: m.C }, rate: m.rate, v: m.v, minSize: m.minSize, tick: m.tick });
  return { volL: env.volL, jumpsPerDay: env.jumpsPerDay, jumpL: env.jumpL, noise: env.noise, kappa: env.kappa, markout: env.markout, toxSlope: env.toxSlope ?? 0.7, calibratedFrom: hist ? hist.length : 0 };
}
function metaOf(m) {
  return { id: m.id, question: m.question, tokens: m.tokens, v: m.v, minSize: m.minSize, rate: m.rate, tick: m.tick || 0.01, mid: m.mid,
    endTs: m.hoursToEnd != null ? Date.now() + m.hoursToEnd * 3.6e6 : null, eventSlug: m.eventSlug };
}

/** Allocate `free` USDC across safe, affordable candidates not already held. */
async function allocate(s, free) {
  const held = new Set(Object.keys(s.markets));
  const slots = Math.max(0, s.P.maxMarkets - held.size);
  if (free < 5 || slots === 0) return { added: 0, candidates: 0 };
  const all = await scanMarkets(Math.round(Math.min(free, s.P.maxSize)));
  const minH = Math.max(24, s.P.eventGuardH + 12);
  const safe = all.filter(m => !held.has(String(m.id)) && m.C != null && (m.safePassed || 0) >= 5 && m.hoursToEnd != null && m.hoursToEnd >= minH
    && m.mid >= 0.15 && m.mid <= 0.85 && m.minSize <= free).slice(0, 24);
  const cands = await Promise.all(safe.map(async m => {
    const model = await calibrated(m);
    const sig = model.volL / Math.sqrt(1440) * 100 * m.mid * (1 - m.mid) * 0.8;
    return { m, model, mk: metaOf(m), C: m.C, sig, mid: m.mid, opts: { maxShares: s.P.maxSize, allowOneSided: s.P.oneSided !== false } };
  }));
  // Max-profit search: run the greedy marginal-$ allocator under several per-market caps (no cap → heavy
  // concentration … ¼ of bankroll → wide spread) and keep the plan with the highest expected net $/day.
  // The $1 floor is account-level: a plan whose total expected reward can't clear it forfeits its rewards.
  const floorNeed = s.P.payoutFloor * 1.25;
  const heldRew = Object.values(s.markets).reduce((a, ms) => a + (ms.expRewDay || 0), 0);
  const sum = (pl, k) => pl.reduce((a, p) => a + p[k], 0);
  const value = pl => heldRew + sum(pl, 'rewDay') >= floorNeed ? sum(pl, 'edgeDay') : sum(pl, 'edgeDay') - sum(pl, 'rewDay');
  const K = Math.floor(free);
  const fracs = [...new Set([1, s.P.maxPerMarketFrac || 0.75, 0.5, 0.34, 0.25])];
  const tries = fracs.map(f => { const cap = f >= 1 ? Infinity : Math.max(10, Math.floor(f * s.P.capital)); return { name: f >= 1 ? 'greedy' : '≤$' + cap, pl: Core.allocateCapital(cands, K, 0, slots, 5, cap) }; });
  // seeded plans: fund each of the best markets two-sided at its threshold (and at the whole budget), greedy the rest
  const solo = cands.map((c, i) => ({ i, v: (Core.optimalQuote(c.mk, c.C, c.sig * 1.25, c.mid, K, c.model, 0, c.opts) || { edge: 0 }).edge })).sort((a, b) => b.v - a.v).slice(0, 6);
  for (const { i } of solo) {
    const two = Math.ceil(cands[i].mk.minSize * 0.99 / 5) * 5;
    for (const b0 of [...new Set([two, K])]) {
      if (b0 > K) continue;
      const seed = cands.map((_, j) => (j === i ? b0 : 0));
      tries.push({ name: `seed ${String(cands[i].m.question).slice(0, 18)} $${b0}`, pl: Core.allocateCapital(cands, K, 0, slots, 5, Infinity, seed) });
    }
  }
  tries.forEach(t => { t.v = value(t.pl); });
  tries.sort((a, b) => (b.v - a.v) || (b.pl.length - a.pl.length)); // most profit; ties → more markets
  const plan = tries[0].pl;
  log(s, `ALLOCATOR: searched ${tries.length} plans · best "${tries[0].name}" ${plan.length} mkts ≈ $${tries[0].v.toFixed(2)}/day · runner-up ${tries[1] ? `"${tries[1].name}" ${tries[1].pl.length} mkts ≈ $${tries[1].v.toFixed(2)}/day` : '—'}`, 'q');
  for (const p of plan) {
    const c = cands[p.i];
    s.markets[c.m.id] = Core.newMarketState(c.mk, c.model, Date.now(), p.budget);
    s.markets[c.m.id].expRewDay = p.rewDay;
    log(s, `ALLOCATE $${p.budget} ${(p.mode || '').toUpperCase()} → ${c.m.question.slice(0, 60)} · exp. reward ≈ $${p.rewDay.toFixed(2)}/day, net ≈ $${p.edgeDay.toFixed(2)}/day · pool $${c.m.rate}/day · min size ${c.m.minSize} · C ${Math.round(c.C).toLocaleString()}`, 'q');
  }
  log(s, `ALLOCATOR: ${all.length} reward markets → ${safe.length} safe & affordable → funded ${plan.length} with $${plan.reduce((a, p) => a + p.budget, 0)} of $${Math.floor(free)} free`, 'q');
  return { added: plan.length, candidates: safe.length };
}

function closeMarket(s, id, why) {
  const ms = s.markets[id]; if (!ms) return;
  // flatten inventory at mid; today's pending reward stays in the account's pending pot until the UTC settlement
  s.closedPending = (s.closedPending || 0) + ms.dayReward; ms.dayReward = 0;
  s.closed = (s.closed || 0) + Core.mtm(ms);
  s.closedRewards = (s.closedRewards || 0) + ms.rewardPaid;
  s.closedForfeit = (s.closedForfeit || 0) + ms.rewardForfeit;
  log(s, `CLOSE ${ms.meta.question.slice(0, 60)} · ${why} · trading $${Core.mtm(ms).toFixed(2)} · rewards paid $${ms.rewardPaid.toFixed(2)}`, 'g');
  delete s.markets[id];
}

/** Close idle markets (no inventory) that are guarded / standing down / unfunded, then re-allocate free capital. */
async function rebalance(s) {
  s.lastRebalance = Date.now();
  for (const [id, ms] of Object.entries(s.markets)) {
    const idle = ['EVENT GUARD', 'STANDBY', 'NO CAPITAL', 'NO BOOK'].includes(ms.status) && Math.abs(ms.inv) < 1;
    if (idle) closeMarket(s, id, 'rebalance: ' + ms.status.toLowerCase());
  }
  const used = Object.values(s.markets).reduce((a, ms) => a + (ms.budget || 0), 0);
  // bankroll = starting capital + realised P&L, so profits are recycled and losses shrink the book
  const t = totals(s);
  const bankroll = Math.max(0, s.P.capital + (s.closed || 0) + (s.closedRewards || 0));
  const res = await allocate(s, Math.min(bankroll, t.equity) - used);
  log(s, `REBALANCE done · ${Object.keys(s.markets).length} markets live`, 'g');
  return res;
}

/** One engine tick across all markets; returns true if something notable happened (fill/payout/allocation). */
/** Account-level epoch settlement at 00:00 UTC: Polymarket pays an address's daily total only if it is ≥ the floor. */
function settle(s, today) {
  if (!s.day) { s.day = today; return false; }
  if (s.day === today) return false;
  const total = Object.values(s.markets).reduce((a, ms) => a + ms.dayReward, 0) + (s.closedPending || 0);
  if (total >= s.P.payoutFloor) {
    for (const ms of Object.values(s.markets)) ms.rewardPaid += ms.dayReward;
    s.closedRewards = (s.closedRewards || 0) + (s.closedPending || 0);
    log(s, `PAYOUT $${total.toFixed(2)} for ${s.day} (account total ≥ $${s.P.payoutFloor})`, 'q');
  } else if (total > 0) {
    for (const ms of Object.values(s.markets)) ms.rewardForfeit += ms.dayReward;
    s.closedForfeit = (s.closedForfeit || 0) + (s.closedPending || 0);
    log(s, `FORFEIT $${total.toFixed(4)} for ${s.day} — account total below the $${s.P.payoutFloor} payout floor`, 'f');
  }
  for (const ms of Object.values(s.markets)) { ms.dayReward = 0; ms.day = today; }
  s.closedPending = 0; s.day = today;
  return true;
}

async function tickOnce(s) {
  const now = Date.now();
  let notable = settle(s, Core.utcDay(now));
  for (const ms of Object.values(s.markets)) ms.day = Core.utcDay(now); // settlement is account-level; keep step() from settling per market
  if (!Object.keys(s.markets).length && now - (s.lastRebalance || 0) > 15 * 60000) { await rebalance(s); notable = true; }
  await Promise.all(Object.values(s.markets).map(async ms => {
    let book = null;
    try { book = await getJSON(`${CLOB}/book?token_id=${ms.meta.tokens[0].id}`, {}, 8000); }
    catch (e) { log(s, `${tag(ms)} book error: ${e.message || e}`, 'f'); }
    for (const e of Core.step(ms, book, now, s.P)) { log(s, `${tag(ms)} ${e}`, cls(e)); if (/^(FILL|PAYOUT|FORFEIT)/.test(e)) notable = true; }
  }));
  const t = totals(s);
  s.eq.push({ t: now, eq: +t.equityInclPending.toFixed(4), rw: +t.reward.toFixed(4), pnl: +t.pnl.toFixed(4) });
  if (s.eq.length > 3000) s.eq = s.eq.filter((_, i) => i % 2 === 0 || i > s.eq.length - 400);
  s.lastTick = now;
  const day = Core.utcDay(now);
  if (!s.history.length || s.history[s.history.length - 1].day !== day) {
    s.history.push({ day, equity: +t.equity.toFixed(2), paid: +t.paid.toFixed(2), forfeit: +t.forfeit.toFixed(4), trade: +t.trade.toFixed(2), fills: t.fills, markets: Object.keys(s.markets).length });
    if (s.history.length > 120) s.history.shift();
    notable = true;
  }
  if (s.P.rebalanceH > 0 && now - (s.lastRebalance || 0) > s.P.rebalanceH * 3.6e6) {
    try { await rebalance(s); notable = true; } catch (e) { log(s, 'REBALANCE failed: ' + (e.message || e), 'f'); }
  }
  return notable;
}

function publicView(s, extra = {}) {
  return { ok: true, running: s.running, startedAt: s.startedAt, lastTick: s.lastTick, lastRebalance: s.lastRebalance, P: s.P, totals: totals(s),
    markets: Object.entries(s.markets).map(([id, ms]) => ({ id, question: ms.meta.question, eventSlug: ms.meta.eventSlug, status: ms.status,
      budget: ms.budget, mid: ms.lastMid, quote: ms.quote, C: ms.lastC, share: ms.lastShare, inv: ms.inv, locked: Core.locked(ms), collateral: Core.collateral(ms),
      pending: ms.dayReward, paid: ms.rewardPaid, forfeit: ms.rewardForfeit, reward: ms.reward, mtm: Core.mtm(ms), fills: ms.fills, edge: ms.edge, endTs: ms.meta.endTs, minSize: ms.meta.minSize, rate: ms.meta.rate })),
    log: s.log.slice(-220), eq: s.eq, history: s.history, serverTime: Date.now(), ...extra };
}

module.exports = { freshState, log, totals, tickOnce, rebalance, allocate, closeMarket, publicView, scanMarkets, calibrated, metaOf, Core };
