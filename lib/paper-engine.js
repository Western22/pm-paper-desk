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
const cls = e => /^(FILL|FORFEIT|TOXIC)/.test(e) ? 'f' : /^(GATE|EVENT|STANDBY|NO CAPITAL|SIBLING)/.test(e) ? 'g' : /^(POST|REQUOTE|PAYOUT)/.test(e) ? 'q' : '';

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
  // deep scan: every reward market — the thinnest competition sits in small pools the top-120 list never reaches
  await scan({ query: { n: '3000', size: String(size), deep: '1' } }, res);
  if (!res.body || !res.body.ok) throw new Error('scan failed: ' + (res.body && res.body.error));
  return res.body.markets;
}
async function calibrated(m) {
  let hist = null;
  try { hist = (await getJSON(`${CLOB}/prices-history?market=${m.tokens[0].id}&interval=1w&fidelity=60`, {}, 8000)).history; } catch (e) { /* preset */ }
  const env = Q.calibrate(Object.assign({ toxSlope: 0.7 }, Q.PRESETS.politics), { history: hist, comp: { mid: m.mid, C: m.C }, rate: m.rate, v: m.v, minSize: m.minSize, tick: m.tick });
  return { volL: env.volL, jumpsPerDay: env.jumpsPerDay, jumpL: env.jumpL, noise: env.noise, kappa: env.kappa, markout: env.markout, toxSlope: env.toxSlope ?? 0.7, calibratedFrom: hist ? hist.length : 0 };
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Start (00:00 UTC) of the last calendar date named in a question ("… on October 27, 2026?"), or null. */
function questionDayMs(q, now = Date.now()) {
  const re = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gi;
  let m, last = null;
  while ((m = re.exec(String(q || '')))) last = m;
  if (!last) return null;
  const yNow = new Date(now).getUTCFullYear();
  let t = Date.UTC(last[3] ? +last[3] : yNow, MONTHS.indexOf(last[1].toLowerCase()), +last[2]);
  if (!last[3] && t < now - 200 * 864e5) t = Date.UTC(yNow + 1, MONTHS.indexOf(last[1].toLowerCase()), +last[2]);
  return t;
}
function metaOf(m) {
  const qd = questionDayMs(m.question);
  const end = m.hoursToEnd != null ? Date.now() + m.hoursToEnd * 3.6e6 : null;
  // the event guard keys off endTs: for dated questions the event starts at 00:00 UTC of that date
  return { id: m.id, conditionId: m.conditionId, question: m.question, tokens: m.tokens, v: m.v, minSize: m.minSize, rate: m.rate, tick: m.tick || 0.01, mid: m.mid,
    endTs: qd != null && end != null ? Math.min(end, qd) : end, eventSlug: m.eventSlug };
}

/** Allocate `free` USDC across safe, affordable candidates not already held. */
async function allocate(s, free) {
  const held = new Set(Object.keys(s.markets));
  const slots = Math.max(0, s.P.maxMarkets - held.size);
  if (free < 5 || slots === 0) return { added: 0, candidates: 0 };
  const all = await scanMarkets(Math.round(Math.min(free, s.P.maxSize)));
  const minH = Math.max(24, s.P.eventGuardH + 12);
  const minSafe = s.P.minSafe ?? 3; // empty books fail the tight-spread check by definition, so 3/6 lets them in
  const now = Date.now(), perEvent = {};
  Object.values(s.markets).forEach(ms => { const e = ms.meta.eventSlug; if (e) perEvent[e] = (perEvent[e] || 0) + 1; });
  const safe = all.filter(m => {
    if (held.has(String(m.id)) || (s.blacklist && s.blacklist[m.id] > now) || m.C == null || (m.safePassed || 0) < minSafe || m.hoursToEnd == null) return false;
    if (m.mid < 0.15 || m.mid > 0.85 || m.minSize * Math.min(m.mid, 1 - m.mid) > free) return false;
    // empty books often mean the answer is already known: a date in the question that has passed (or starts
    // within the guard window) is stale/in-play → skip. Use the question's date as the event time.
    const qd = questionDayMs(m.question, now);
    const evH = Math.min(m.hoursToEnd, qd != null ? (qd - now) / 3.6e6 : Infinity);
    return evH >= minH;
  }).sort((a, b) => (b.refDaily || 0) - (a.refDaily || 0))
    .filter(m => { const e = m.eventSlug; if (!e) return true; perEvent[e] = (perEvent[e] || 0) + 1; return perEvent[e] <= (s.P.maxPerEvent || 2); }) // correlated dates of one event
    .slice(0, s.P.candidates || 40);
  const cands = await Promise.all(safe.map(async m => {
    const model = await calibrated(m);
    const sig = model.volL / Math.sqrt(1440) * 100 * m.mid * (1 - m.mid) * 0.8;
    // a book with ~no competing quotes today attracts rivals: plan as if one rival quotes min size ~1¢ wide
    const C = Math.max(m.C, (s.P.rivalFrac ?? 0.5) * m.minSize);
    return { m, model, mk: metaOf(m), C, sig, mid: m.mid, opts: { maxShares: s.P.maxSize, allowOneSided: s.P.oneSided !== false } };
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

/** A shock / toxic print in one market moves its siblings (same event: date ladders, brackets) next —
 *  step them aside for siblingCoolMin. Returns the ids that were cooled. */
function siblingPull(s, id, now, why) {
  const src = s.markets[id]; const ev = src && src.meta.eventSlug; if (!ev) return [];
  const hit = [];
  for (const [k, ms] of Object.entries(s.markets)) {
    if (k === id || ms.meta.eventSlug !== ev) continue;
    ms.coolUntil = Math.max(ms.coolUntil || 0, now + (s.P.siblingCoolMin ?? 10) * 60000);
    ms.quote = null; ms.status = 'GATED'; hit.push(k);
    log(s, `${tag(ms)} SIBLING — ${why} in "${src.meta.question.slice(0, 40)}", pulling for ${s.P.siblingCoolMin ?? 10} min`, 'g');
  }
  return hit;
}

/** Market resolved at YES price px (1 or 0): held shares pay out, then the market is closed. */
function settleResolved(s, id, px) {
  const ms = s.markets[id]; if (!ms) return;
  ms.lastMid = px; // inv > 0 = long YES pays px/share; inv < 0 = long NO pays (1 − px)/share, already netted in cash
  closeMarket(s, id, `resolved ${px === 1 ? 'YES' : 'NO'} · ${ms.inv.toFixed(0)} YES-equiv shares settled at $${px}`);
}

/** Per-market stop: trading loss net of rewards beyond stopFrac × budget → flatten, close, blacklist 24 h. */
function riskCheck(s, now = Date.now()) {
  const lim = s.P.stopFrac ?? 0.3;
  for (const [id, ms] of Object.entries(s.markets)) {
    const net = Core.mtm(ms) + ms.reward;
    if (net < -lim * (ms.budget || 0)) {
      s.blacklist = s.blacklist || {};
      s.blacklist[ms.meta.id || id] = now + 864e5;
      closeMarket(s, id, `STOP-LOSS: trading $${Core.mtm(ms).toFixed(2)} + rewards $${ms.reward.toFixed(2)} < −${Math.round(lim * 100)}% of $${ms.budget} · blacklisted 24 h`);
    }
  }
  if (s.blacklist) for (const k of Object.keys(s.blacklist)) if (s.blacklist[k] < now) delete s.blacklist[k];
}

/** Gamma lookup by YES token (includes closed markets): conditionId + resolution. */
async function marketInfo(tokenId) {
  const arr = await getJSON(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&closed=true`, {}, 8000).catch(() => []);
  const arr2 = arr && arr.length ? arr : await getJSON(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`, {}, 8000).catch(() => []);
  const m = (arr2 || [])[0]; if (!m) return null;
  let px = null;
  try { const op = JSON.parse(m.outcomePrices || '[]').map(Number); if (m.closed && m.umaResolutionStatus === 'resolved' && (op[0] === 1 || op[0] === 0)) px = op[0]; } catch (e) { /* unparsable */ }
  return { conditionId: m.conditionId, closed: !!m.closed, acceptingOrders: m.acceptingOrders !== false, px };
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
  // live: the bankroll is the operator's hard cap (real P&L lives in the wallet, not in this state)
  const bankroll = s.P.live ? s.P.capital : Math.max(0, s.P.capital + (s.closed || 0) + (s.closedRewards || 0));
  const res = await allocate(s, (s.P.live ? bankroll : Math.min(bankroll, t.equity)) - used);
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

/** opts.getBook(ms) → cached book (live WebSocket) or undefined to fall back to HTTP;
 *  opts.background → run rebalances without blocking the tick (fast quoting loop). */
async function tickOnce(s, opts = {}) {
  const reb = () => {
    if (!opts.background) return rebalance(s);
    if (s._rebalancing) return Promise.resolve();
    s._rebalancing = true;
    rebalance(s).catch(e => log(s, 'REBALANCE failed: ' + (e.message || e), 'f')).finally(() => { s._rebalancing = false; if (opts.onRebalance) opts.onRebalance(); });
    return Promise.resolve();
  };
  const now = Date.now();
  let notable = settle(s, Core.utcDay(now));
  for (const ms of Object.values(s.markets)) ms.day = Core.utcDay(now); // settlement is account-level; keep step() from settling per market
  if (!Object.keys(s.markets).length && now - (s.lastRebalance || 0) > 15 * 60000) { await reb(); notable = true; }
  const triggered = [];
  await Promise.all(Object.entries(s.markets).map(async ([id, ms]) => {
    let book = null, bookErr = null;
    try { book = (opts.getBook && opts.getBook(ms)) || await getJSON(`${CLOB}/book?token_id=${ms.meta.tokens[0].id}`, {}, 8000); }
    catch (e) { bookErr = e; }
    // missing book (404) usually means the market closed: check resolution every 10 min, pay out if resolved
    if (!book || !ms.meta.conditionId) {
      if (!ms.infoAt || now - ms.infoAt > 10 * 60000) {
        ms.infoAt = now;
        const info = await marketInfo(ms.meta.tokens[0].id);
        if (info) { ms.meta.conditionId = ms.meta.conditionId || info.conditionId; if (info.px != null) { settleResolved(s, id, info.px); notable = true; return; } }
        if (bookErr) log(s, `${tag(ms)} no book (${bookErr.message || bookErr}) · ${info && info.closed ? 'market closed, awaiting resolution' : 'retrying'}`, 'f');
      }
    }
    // public taker trades → realistic fills (a taker at our price fills us even without a trade-through)
    let trades = null;
    if (book && !s.P.live && ms.meta.conditionId && ms.quote) {
      try { trades = await getJSON(`https://data-api.polymarket.com/trades?market=${ms.meta.conditionId}&limit=100&takerOnly=true`, {}, 8000); }
      catch (e) { /* fills fall back to trade-through */ }
    }
    for (const e of Core.step(ms, book, now, s.P, Array.isArray(trades) ? trades : null)) {
      log(s, `${tag(ms)} ${e}`, cls(e)); if (/^(FILL|PAYOUT|FORFEIT)/.test(e)) notable = true;
      if (/^(GATE — jump|TOXIC)/.test(e)) triggered.push([id, e.split(' — ')[0].toLowerCase()]);
    }
  }));
  for (const [id, why] of triggered) siblingPull(s, id, now, why);
  if (!s.P.live) riskCheck(s, now); // live: loss limits run on real wallet P&L in bot/live_runner.py
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
  // idle money (standby / guarded / unfunded, no inventory) is redeployed after 1 h instead of waiting for the 6 h cycle
  const idle = Object.values(s.markets).some(ms => ['EVENT GUARD', 'STANDBY', 'NO CAPITAL', 'NO BOOK'].includes(ms.status) && Math.abs(ms.inv) < 1);
  const due = s.P.rebalanceH > 0 && now - (s.lastRebalance || 0) > s.P.rebalanceH * 3.6e6;
  if (due || (idle && now - (s.lastRebalance || 0) > 3.6e6)) {
    try { await reb(); notable = true; } catch (e) { log(s, 'REBALANCE failed: ' + (e.message || e), 'f'); }
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

module.exports = { siblingPull, settleResolved, riskCheck, marketInfo, questionDayMs, freshState, log, totals, tickOnce, rebalance, allocate, closeMarket, publicView, scanMarkets, calibrated, metaOf, Core };
