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
const cls = e => /^(FILL|FORFEIT|TOXIC)/.test(e) ? 'f' : /^(GATE|EVENT|STANDBY|NO CAPITAL|SIBLING|SHARP)/.test(e) ? 'g' : /^(POST|REQUOTE|PAYOUT)/.test(e) ? 'q' : '';

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

/** Operator wants diversification: with P.spreadFrac > 0 keep only plans where no market gets more than that
 *  share of capital (min $10). Falls back to all plans if none qualifies. */
function spreadOnly(tries, P) {
  if (!(P.spreadFrac > 0)) return tries;
  const cap = Math.max(10, Math.floor(P.spreadFrac * P.capital));
  const keep = tries.filter(t => t.pl.every(p => p.budget <= cap));
  return keep.length ? keep : tries;
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
    if (s.P.headlineFilter !== 0 && isHeadline(m.question)) return false;
    if (m.eventSlug && s.eventCool && s.eventCool[m.eventSlug] > now) return false; // event just jumped
    // empty books often mean the answer is already known: a date in the question that has passed (or starts
    // within the guard window) is stale/in-play → skip. Use the question's date as the event time.
    const qd = questionDayMs(m.question, now);
    const evH = Math.min(m.hoursToEnd, qd != null ? (qd - now) / 3.6e6 : Infinity);
    return evH >= minH;
  }).sort((a, b) => (b.refDaily || 0) - (a.refDaily || 0))
    .filter(m => { const e = m.eventSlug; if (!e) return true; perEvent[e] = (perEvent[e] || 0) + 1; return perEvent[e] <= (s.P.maxPerEvent || 2); }) // correlated dates of one event
    .slice(0, s.P.candidates || 40);
  const mmSet = new Set(s.mmWallets || []);
  const cands = await Promise.all(safe.map(async m => {
    const model = applyMarkout(await calibrated(m), s.P);
    const sig = model.volL / Math.sqrt(1440) * 100 * m.mid * (1 - m.mid) * 0.8;
    // a book with ~no competing quotes today attracts rivals: plan as if one rival quotes min size ~1¢ wide
    const C = Math.max(m.C, (s.P.rivalFrac ?? 0.5) * m.minSize);
    return { m, model, mk: metaOf(m), C, sig, mid: m.mid, opts: { maxShares: s.P.maxSize, allowOneSided: s.P.oneSided !== false } };
  }));
  // rival market makers already trading a market will compete for its pool: plan with a crowded C.
  // 6 lookups at a time (40 at once gets rate-limited); a failed lookup is "unknown", never "no rivals".
  let unknown = 0, ci = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (ci < cands.length) {
      const c = cands[ci++];
      if (!c.m.conditionId) { unknown++; continue; }
      try {
        const tr = await getJSON(`https://data-api.polymarket.com/trades?market=${c.m.conditionId}&limit=300&takerOnly=false`, {}, 8000);
        c.m.competitors = competitorsFromTrades(tr, mmSet).length;
        c.C = crowdedC(c.C, c.m.competitors, s.P);
      } catch (e) { unknown++; c.m.competitors = null; c.C = crowdedC(c.C, 2, s.P); } // unknown → assume a couple of rivals
    }
  }));
  // Max-profit search: run the greedy marginal-$ allocator under several per-market caps (no cap → heavy
  // concentration … ¼ of bankroll → wide spread) and keep the plan with the highest expected net $/day.
  // The $1 floor is account-level: a plan whose total expected reward can't clear it forfeits its rewards.
  const floorNeed = s.P.payoutFloor * 1.25;
  const heldRew = Object.values(s.markets).reduce((a, ms) => a + (ms.expRewDay || 0), 0);
  const sum = (pl, k) => pl.reduce((a, p) => a + p[k], 0);
  const value = pl => heldRew + sum(pl, 'rewDay') >= floorNeed ? sum(pl, 'edgeDay') : sum(pl, 'edgeDay') - sum(pl, 'rewDay');
  const K = Math.floor(free);
  const fracs = [...new Set([1, s.P.maxPerMarketFrac || 0.75, 0.5, 0.34, 0.25, ...(s.P.spreadFrac > 0 ? [s.P.spreadFrac] : [])])];
  let tries = fracs.map(f => { const cap = f >= 1 ? Infinity : Math.max(10, Math.floor(f * s.P.capital)); return { name: f >= 1 ? 'greedy' : '≤$' + cap, pl: Core.allocateCapital(cands, K, 0, slots, 5, cap) }; });
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
  tries = spreadOnly(tries, s.P);
  tries.forEach(t => { t.v = value(t.pl); });
  tries.sort((a, b) => (b.v - a.v) || (b.pl.length - a.pl.length)); // most profit; ties → more markets
  const plan = tries[0].pl;
  log(s, `ALLOCATOR: searched ${tries.length} plans · best "${tries[0].name}" ${plan.length} mkts ≈ $${tries[0].v.toFixed(2)}/day · runner-up ${tries[1] ? `"${tries[1].name}" ${tries[1].pl.length} mkts ≈ $${tries[1].v.toFixed(2)}/day` : '—'}`, 'q');
  for (const p of plan) {
    const c = cands[p.i];
    s.markets[c.m.id] = Core.newMarketState(c.mk, c.model, Date.now(), p.budget);
    s.markets[c.m.id].expRewDay = p.rewDay;
    log(s, `ALLOCATE $${p.budget} ${(p.mode || '').toUpperCase()} → ${c.m.question.slice(0, 60)} · exp. reward ≈ $${p.rewDay.toFixed(2)}/day, net ≈ $${p.edgeDay.toFixed(2)}/day · pool $${c.m.rate}/day · min size ${c.m.minSize} · C ${Math.round(c.C).toLocaleString()} · rival makers ${c.m.competitors == null ? '?' : c.m.competitors}`, 'q');
  }
  log(s, `ALLOCATOR: rival makers per candidate: ${cands.map(c => c.m.competitors == null ? '?' : c.m.competitors).join(' ')}${unknown ? ` (${unknown} lookups failed)` : ''}`, 'q');
  log(s, `ALLOCATOR: ${all.length} reward markets → ${safe.length} safe & affordable → funded ${plan.length} with $${plan.reduce((a, p) => a + p.budget, 0)} of $${Math.floor(free)} free`, 'q');
  return { added: plan.length, candidates: safe.length };
}

function closeMarket(s, id, why) {
  const ms = s.markets[id]; if (!ms) return;
  if (ms.avoid) endSharpEpisode(s, ms, Date.now(), 'closed: ' + why);
  // flatten inventory at mid; today's pending reward stays in the account's pending pot until the UTC settlement
  s.closedPending = (s.closedPending || 0) + ms.dayReward; ms.dayReward = 0;
  s.closed = (s.closed || 0) + Core.mtm(ms);
  s.closedRewards = (s.closedRewards || 0) + ms.rewardPaid;
  s.closedForfeit = (s.closedForfeit || 0) + ms.rewardForfeit;
  log(s, `CLOSE ${ms.meta.question.slice(0, 60)} · ${why} · trading $${Core.mtm(ms).toFixed(2)} · rewards paid $${ms.rewardPaid.toFixed(2)}`, 'g');
  delete s.markets[id];
}

/** A shock / toxic print in one market moves its siblings (same event: date ladders, brackets) next —
 *  step them aside for siblingCoolMin, or for `coolMin` when given (a big jump: the whole event stays out,
 *  and no new market of that event is allocated meanwhile). Returns the ids that were cooled. */
function siblingPull(s, id, now, why, coolMin) {
  const src = s.markets[id]; const ev = src && src.meta.eventSlug; if (!ev) return [];
  const min = coolMin ?? s.P.siblingCoolMin ?? 10;
  if (coolMin) { s.eventCool = s.eventCool || {}; s.eventCool[ev] = Math.max(s.eventCool[ev] || 0, now + coolMin * 60000); }
  const hit = [];
  for (const [k, ms] of Object.entries(s.markets)) {
    if (k === id || ms.meta.eventSlug !== ev) continue;
    ms.coolUntil = Math.max(ms.coolUntil || 0, now + min * 60000);
    ms.quote = null; ms.status = 'GATED'; hit.push(k);
    log(s, `${tag(ms)} SIBLING — ${why} in "${src.meta.question.slice(0, 40)}", pulling for ${min} min`, 'g');
  }
  return hit;
}

// Headline-driven questions (conflict, flights, court rulings, launches by a date) jump 20–50¢ on one news item:
// a reward maker holding inventory there just gets run over. Skipped when allocating; held ones go exit-only.
const HEADLINE = /\b(wars?|strikes?|attacks?|invade|invasion|ceasefire|missiles?|military|troops|nuclear|sanctions?|coup|hamas|hezbollah|houthis?|gaza|israel|iran|ukraine|russia|airlines?|flights?|airspace|courts?|ruling|rules?|strike down|indict(ed|ment)?|arrest(ed)?|convicted|sentenced|impeach(ed|ment)?|released?|launch(es|ed)?|announce[sd]?)\b/i;
// scheduled decisions / data releases gap the price at a known moment (ECB, 30 Oct: −16¢ on our NO)
const DECISION = /\b(fed|fomc|ecb|boe|boj|pboc|central bank|rate (cut|hike|decision)|cuts? rates|hikes? rates|interest rates?|deposit (facility )?rate|cpi|inflation|jobs report|payrolls|unemployment rate|gdp|elections?|vote|referendum|primary|poll)\b/i;
const isHeadline = q => HEADLINE.test(String(q || '')) || DECISION.test(String(q || ''));

/** Live fill-cost calibration. The engine plans with a per-share "markout" (how far the price moves against a
 *  maker right after a fill). The model's guess (~0.3–1¢) was far below reality (30 Oct: ~9¢/share), so every
 *  real fill is scored 60 min later against the token's mid and folded into s.P.liveMarkoutC (EWMA, 1–25¢),
 *  which then floors every market's model.markout — wider, smaller, fewer quotes where fills are toxic. */
function recordFill(s, f, now = Date.now()) {
  const tok = String(f.asset);
  const id = Object.keys(s.markets).find(k => s.markets[k].meta.tokens.some(t => String(t.id) === tok));
  if (!id || !(f.price > 0)) return;
  s.fills = (s.fills || []).concat({ id, yes: String(s.markets[id].meta.tokens[0].id) === tok, side: String(f.side).toUpperCase(), price: +f.price, size: +f.size || 0, t: now }).slice(-200);
}
function scoreFills(s, now = Date.now(), horizonMin = 60) {
  for (const f of s.fills || []) {
    if (f.done || now - f.t < horizonMin * 60000) continue;
    f.done = true;
    const ms = s.markets[f.id]; if (!ms || ms.lastMid == null) continue; // market gone: no clean read
    const mid = f.yes ? ms.lastMid : 1 - ms.lastMid;
    f.markoutC = +((f.side === 'BUY' ? f.price - mid : mid - f.price) * 100).toFixed(2);
    const old = s.P.liveMarkoutC ?? 9;
    s.P.liveMarkoutC = +Math.min(25, Math.max(1, 0.8 * old + 0.2 * f.markoutC)).toFixed(2);
    log(s, `${tag(ms)} MARKOUT ${f.markoutC >= 0 ? '−' : '+'}${Math.abs(f.markoutC).toFixed(1)}¢/share 60 min after our ${f.side} @ ${f.price} → planning fill cost ${s.P.liveMarkoutC}¢`, f.markoutC > 0 ? 'f' : 'g');
  }
}
/** Floor every model's markout at the live-calibrated fill cost (keeps the market's own value if higher). */
function applyMarkout(model, P) {
  if (!P.live || !(P.liveMarkoutC > 0)) return model;
  if (model.markout0 == null) model.markout0 = model.markout || 0;
  model.markout = Math.max(model.markout0, P.liveMarkoutC);
  return model;
}

/** Executor reports tokens whose position is losing (≥$1, or price ≥15% below cost): that market stops buying
 *  for 24 h (exit-only: held shares are still offered back) and is blacklisted from re-allocation. */
function markLosers(s, tokens, now = Date.now()) {
  const bad = new Set((tokens || []).map(String));
  for (const [id, ms] of Object.entries(s.markets)) {
    if (!ms.meta.tokens.some(t => bad.has(String(t.id))) || ms.lossCoolUntil > now) continue;
    ms.lossCoolUntil = now + 864e5;
    s.blacklist = s.blacklist || {}; s.blacklist[ms.meta.id || id] = now + 864e5;
    log(s, `${tag(ms)} LOSS COOL-DOWN — position losing: no new buys for 24 h, held shares offered back, no re-entry`, 'f');
  }
}

/** Why a market may only sell what it holds right now (null = trade normally). */
function exitOnlyReason(s, ms, now = Date.now()) {
  if (ms.lossCoolUntil > now) return 'loss cool-down';
  if (s.P.headlineFilter !== 0 && isHeadline(ms.meta.question)) return 'headline market';
  return null;
}

/** Competitors in a market from its recent trades: wallets we know are market makers (from peer reports)
 *  plus unknown wallets behaving like one — ≥4 trades in the window on both the buy and the sell side. */
function competitorsFromTrades(trades, mmSet, now = Date.now(), days = 3) {
  const since = now / 1000 - days * 86400, by = new Map();
  for (const t of Array.isArray(trades) ? trades : []) {
    if (+t.timestamp < since || !t.proxyWallet) continue;
    const w = by.get(t.proxyWallet) || { n: 0, buy: 0, sell: 0 };
    w.n++; if (t.side === 'BUY') w.buy++; else w.sell++;
    by.set(t.proxyWallet, w);
  }
  // maker-like: ≥6 trades, buying AND selling in a balanced way (an active directional trader is one-sided)
  const makerLike = x => x.n >= 6 && Math.min(x.buy, x.sell) >= 0.4 * Math.max(x.buy, x.sell);
  return [...by.entries()].filter(([w, x]) => (mmSet && mmSet.has(w)) || makerLike(x)).map(([w]) => w);
}
/** Expected competition once rival market makers show up: each one adds mmPenalty × today's C. */
const crowdedC = (C, n, P) => C * (1 + (P.mmPenalty ?? 0.5) * Math.min(n || 0, P.mmCap ?? 6)); // capped: past ~6 rivals the pool is just crowded
/** Remember wallets the peer report classified as market makers (our direct competitors). */
function learnMakers(s, report) {
  const set = new Set(s.mmWallets || []);
  for (const m of (report && report.markets) || []) {
    for (const p of [...(m.peers || []), ...((m.opposite && m.opposite.holders) || [])]) if (p && p.record && p.record.style === 'market maker') set.add(p.wallet);
  }
  s.mmWallets = [...set].slice(-1000);
}

/** Hour-of-day scoreboard: reward and trading P&L per UTC hour, weekdays and weekends kept apart (14 days). */
const hourKey = t => { const d = new Date(t), we = d.getUTCDay() === 0 || d.getUTCDay() === 6; return (we ? 'we' : 'wd') + String(d.getUTCHours()).padStart(2, '0'); };
function recordHour(s, t, { reward = 0, trade = 0 }) {
  if (!isFinite(reward) || !isFinite(trade)) return;
  const k = hourKey(t), day = new Date(t).toISOString().slice(0, 10);
  s.hourly = s.hourly || {};
  const b = s.hourly[k] = s.hourly[k] || {};
  const x = b[day] = b[day] || { r: 0, tr: 0 };
  x.r += reward; x.tr += trade;
  const days = Object.keys(b).sort(); while (days.length > 14) delete b[days.shift()];
}
/** Size multiplier for the current hour: with ≥3 days of history, an hour whose trading loss outweighs its
 *  rewards gets hourCut (½) of the budget; everything else trades at full size. */
function hourMult(s, now = Date.now()) {
  const b = (s.hourly || {})[hourKey(now)]; if (!b) return 1;
  const days = Object.values(b); if (days.length < 3) return 1;
  const net = days.reduce((a, x) => a + x.r + x.tr, 0);
  return net < 0 ? (s.P && s.P.hourCut != null ? s.P.hourCut : 0.5) : 1;
}

/** Peer-wallet report → per-market flags: "sharp money on the other side" makes the engine stop adding to
 *  the side we hold until the next report (2 report cycles max); any other verdict lifts the flag. */
function applyPeerVerdicts(s, report, now = Date.now()) {
  const ttl = 2 * (s.P.peersH || 3) * 3.6e6;
  for (const m of (report && report.markets) || []) {
    const ms = s.markets[m.id]; if (!ms || m.error) continue;
    if (/other side/.test(m.verdict || '')) {
      if (!ms.avoid) log(s, `${tag(ms)} SHARP FLAG — ${m.opposite ? m.opposite.sharp : '?'} sharp wallets vs ${m.sameSharp} on our ${m.side}: stop adding ${m.side}`, 'g');
      const mid = ms.lastMid ?? ms.meta.mid;
      ms.avoid = ms.avoid && ms.avoid.side === m.side
        ? Object.assign(ms.avoid, { until: now + ttl, sharpAgainst: m.opposite ? m.opposite.sharp : null })
        : { side: m.side, until: now + ttl, sharpAgainst: m.opposite ? m.opposite.sharp : null, t0: now, mid0: mid, mtm0: Core.mtm(ms) };
    } else if (ms.avoid) { log(s, `${tag(ms)} SHARP FLAG lifted — ${m.verdict}`, 'q'); endSharpEpisode(s, ms, now, 'lifted'); }
  }
}

/** Scorecard: did the price move the way the sharp wallets bet after we flagged? (YES avoided → mid falling = right) */
function endSharpEpisode(s, ms, now, why) {
  const a = ms.avoid; if (!a || a.t0 == null) { delete ms.avoid; return; }
  const mid1 = ms.lastMid ?? ms.meta.mid, move = (mid1 - a.mid0) * 100 * (a.side === 'YES' ? -1 : 1); // + = sharp were right
  s.sharpEpisodes = s.sharpEpisodes || [];
  s.sharpEpisodes.push({ q: ms.meta.question.slice(0, 80), side: a.side, t0: a.t0, t1: now, why, mid0: +a.mid0.toFixed(4), mid1: +mid1.toFixed(4),
    moveC: +move.toFixed(2), sharpRight: move > 0, tradingDelta: +(Core.mtm(ms) - a.mtm0).toFixed(2) });
  if (s.sharpEpisodes.length > 200) s.sharpEpisodes.shift();
  delete ms.avoid;
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

/** Rebalance on the 6 h cycle, after 1 h when money is idle in a stood-down market, and (live) every 30 min while
 *  ≥$10 of the cap isn't given to any market — new deposit, raised cap, closed market. A full scan is too heavy
 *  to run more often than that. */
function needsRebalance(s, now, idle) {
  const since = now - (s.lastRebalance || 0);
  const due = s.P.rebalanceH > 0 && since > s.P.rebalanceH * 3.6e6;
  const unalloc = s.P.live ? s.P.capital - Object.values(s.markets).reduce((a, ms) => a + (ms.budget || 0), 0) : 0;
  return due || (unalloc >= 10 && since > 30 * 60000) || (idle && since > 3.6e6);
}

/** Close idle markets (no inventory) that are guarded / standing down / unfunded, then re-allocate free capital. */
async function rebalance(s) {
  s.lastRebalance = Date.now();
  for (const [id, ms] of Object.entries(s.markets)) {
    const idle = ['EVENT GUARD', 'STANDBY', 'NO CAPITAL', 'NO BOOK', 'SHARP'].includes(ms.status) && Math.abs(ms.inv) < 1;
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
  s.P.hourMultNow = hourMult(s, now);
  if (s.P.live) { scoreFills(s, now); for (const ms of Object.values(s.markets)) applyMarkout(ms.model, s.P); }
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
  if (s._lastTot) recordHour(s, now, { reward: t.reward - s._lastTot.reward, trade: t.trade - s._lastTot.trade });
  s._lastTot = { reward: t.reward, trade: t.trade };
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
  const idle = Object.values(s.markets).some(ms => ['EVENT GUARD', 'STANDBY', 'NO CAPITAL', 'NO BOOK', 'SHARP'].includes(ms.status) && Math.abs(ms.inv) < 1);
  if (needsRebalance(s, now, idle)) {
    try { await reb(); notable = true; } catch (e) { log(s, 'REBALANCE failed: ' + (e.message || e), 'f'); }
  }
  return notable;
}

function publicView(s, extra = {}) {
  return { ok: true, running: s.running, startedAt: s.startedAt, lastTick: s.lastTick, lastRebalance: s.lastRebalance, P: s.P, totals: totals(s),
    markets: Object.entries(s.markets).map(([id, ms]) => ({ id, question: ms.meta.question, eventSlug: ms.meta.eventSlug, status: ms.status,
      budget: ms.budget, mid: ms.lastMid, quote: ms.quote, C: ms.lastC, share: ms.lastShare, inv: ms.inv, locked: Core.locked(ms), collateral: Core.collateral(ms),
      pending: ms.dayReward, paid: ms.rewardPaid, forfeit: ms.rewardForfeit, reward: ms.reward, mtm: Core.mtm(ms), fills: ms.fills, edge: ms.edge, endTs: ms.meta.endTs, minSize: ms.meta.minSize, rate: ms.meta.rate, avoid: ms.avoid ? { side: ms.avoid.side, since: ms.avoid.t0, mid0: ms.avoid.mid0 } : null })),
    sharpEpisodes: (s.sharpEpisodes || []).slice(-50),
    hourly: Object.fromEntries(Object.entries(s.hourly || {}).map(([k, b]) => { const d = Object.values(b); return [k, { days: d.length, reward: +d.reduce((a, x) => a + x.r, 0).toFixed(2), trade: +d.reduce((a, x) => a + x.tr, 0).toFixed(2) }]; })),
    mmKnown: (s.mmWallets || []).length,
    log: s.log.slice(-220), eq: s.eq, history: s.history, serverTime: Date.now(), ...extra };
}

module.exports = { recordFill, scoreFills, applyMarkout, isHeadline, markLosers, exitOnlyReason, needsRebalance, spreadOnly, competitorsFromTrades, crowdedC, learnMakers, recordHour, hourMult, hourKey, applyPeerVerdicts, siblingPull, settleResolved, riskCheck, marketInfo, questionDayMs, freshState, log, totals, tickOnce, rebalance, allocate, closeMarket, publicView, scanMarkets, calibrated, metaOf, Core };
