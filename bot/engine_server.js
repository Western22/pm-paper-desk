#!/usr/bin/env node
// Low-latency live engine: one persistent process, books streamed over Polymarket's market WebSocket.
//
//   node bot/engine_server.js <state.json>
//
// stdin  (JSON lines): {"type":"positions","pos":{tokenId:shares}}   {"type":"config","capital":50,"params":{...}}
// stdout (JSON lines): {"type":"orders","t":ms,"orders":[...],"markets":[...],"log":[...]}   — every TICK_MS
//                      {"type":"pull","t":ms,"market":id,"tokens":[yes,no],"reason":"..."}  — immediately on an adverse move
//                      {"type":"info","t":ms,"msg":"..."}
// Same engine as the paper trader (lib/paper-engine.js + paper.js); no keys here — execution is in live_runner.py.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const E = require(path.join(__dirname, '..', 'lib', 'paper-engine.js'));
const Q = require(path.join(__dirname, '..', 'engine.js'));
const Core = require(path.join(__dirname, '..', 'paper.js'));
const { ordersFor, exitOnly } = require(path.join(__dirname, 'decide.js'));

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const TICK_MS = +(process.env.TICK_MS || 5000);      // requote cadence (engine EWMAs are scaled to this)
const BOOK_STALE_MS = 30000;                          // older than this → fall back to HTTP /book
const statePath = process.argv[2] || path.join(__dirname, 'run', 'live-state.json');

const out = o => process.stdout.write(JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\n');
const info = msg => out({ type: 'info', msg });

let s;
try { s = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { s = E.freshState(50); s.running = true; s.startedAt = Date.now(); }
s.P.live = true;
s.P.tickSec = TICK_MS / 1000;
let pos = {}, posAt = 0;

// ---------------------------------------------------------------- order books from the WebSocket
const books = new Map(); // yes token → { bids: Map(price→size), asks: Map, tick, at }
const byToken = () => { const m = new Map(); for (const [id, ms] of Object.entries(s.markets)) m.set(String(ms.meta.tokens[0].id), id); return m; };
const byAnyToken = () => { const m = new Map(); for (const [id, ms] of Object.entries(s.markets)) ms.meta.tokens.forEach(t => m.set(String(t.id), id)); return m; };
let tokenIdx = byToken(), anyIdx = byAnyToken();
const MIN_REQUOTE_MS = +(process.env.MIN_REQUOTE_MS || 1000); // event-driven requotes, at most once per second

/** Pull one market now (and its same-event siblings): executor cancels on receipt; engine stays out until coolUntil. */
function pull(id, reason, coolMin, big = false) {
  const ms = s.markets[id]; if (!ms) return;
  const now = Date.now();
  // a big jump is news: the market and its whole event stay out for hours, not minutes
  if (big) coolMin = Math.max(coolMin, s.P.eventCoolMin ?? 360);
  out({ type: 'pull', market: id, tokens: ms.meta.tokens.map(t => String(t.id)), reason });
  ms.quote = null; ms.status = 'GATED'; ms.coolUntil = Math.max(ms.coolUntil || 0, now + coolMin * 60000);
  E.log(s, `[${ms.meta.question.slice(0, 28)}] PULL — ${reason}${big ? ` · event out for ${Math.round(coolMin / 60)} h` : ''}`, 'g');
  for (const sib of E.siblingPull(s, id, now, reason, big ? coolMin : undefined)) {
    out({ type: 'pull', market: sib, tokens: s.markets[sib].meta.tokens.map(t => String(t.id)), reason: `sibling: ${reason}` });
  }
}
let kickTimer = null, lastTickAt = 0;
/** Re-run the engine soon after a book change / fill (debounced) instead of waiting for the next 5 s tick. */
function kick() {
  if (kickTimer) return;
  const wait = Math.max(0, MIN_REQUOTE_MS - (Date.now() - lastTickAt));
  kickTimer = setTimeout(() => { kickTimer = null; tick(); }, Math.max(wait, 150));
}

function asBook(b) {
  const lv = (m, desc) => [...m.entries()].filter(([, z]) => z > 0).sort((a, c) => desc ? c[0] - a[0] : a[0] - c[0]).map(([p, z]) => ({ price: String(p), size: String(z) }));
  return { tick_size: String(b.tick || 0.01), bids: lv(b.bids, true), asks: lv(b.asks, false) };
}
function getBook(ms) {
  const b = books.get(String(ms.meta.tokens[0].id));
  return b && Date.now() - b.at < BOOK_STALE_MS ? asBook(b) : undefined;
}

/** Fast path: on every book change, pull a market's orders at once if the mid ran away from where we quoted. */
function dangerCheck(tok) {
  const id = tokenIdx.get(tok); const ms = id && s.markets[id]; const b = books.get(tok);
  if (!ms || !ms.quote || !b || ms.lastMid == null) return;
  // same size-adjusted mid as the engine and Polymarket's reward scoring (dust orders don't move it)
  const comp = Q.competition(asBook(b), ms.meta.v, ms.meta.minSize); if (!comp) return;
  const bb = comp.bestBid ?? 0, ba = comp.bestAsk ?? 1;
  const mid = comp.mid, move = Math.abs(mid - ms.lastMid) * 100;
  const lim = Math.max(1.5, 0.4 * ms.meta.v); // same jump threshold as the engine's shock gate
  const crossed = (ms.quote.bs > 0 && ba <= ms.quote.bid - 1e-9) || (ms.quote.as > 0 && bb >= ms.quote.ask + 1e-9);
  const big = crossed || move >= (s.P.bigJumpC ?? 4);
  if (move >= lim || crossed) pull(id, crossed ? 'book crossed our quote' : `mid jumped ${move.toFixed(1)}¢`, s.P.cooldownMin || 20, big);
  else kick(); // a competitor changed the book: re-optimise our quote now (hysteresis keeps queue if not worth it)
}

let ws = null, wsBackoff = 1000, subscribed = new Set();
function connect() {
  if (typeof WebSocket !== 'function') { info('no global WebSocket (need Node ≥ 22) — using HTTP books'); return; }
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    wsBackoff = 1000; subscribed = new Set(anyIdx.keys());
    ws.send(JSON.stringify({ assets_ids: [...subscribed], type: 'market', custom_feature_enabled: true }));
    info(`ws open · ${subscribed.size} books`);
  };
  ws.onmessage = ev => {
    const raw = String(ev.data); if (raw === 'PONG') return;
    let msgs; try { msgs = JSON.parse(raw); } catch (e) { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      const et = m.event_type || m.type;
      if (et === 'book') {
        const b = { bids: new Map(), asks: new Map(), tick: (books.get(m.asset_id) || {}).tick || 0.01, at: Date.now() };
        for (const l of m.bids || []) b.bids.set(+l.price, +l.size);
        for (const l of m.asks || []) b.asks.set(+l.price, +l.size);
        books.set(m.asset_id, b); dangerCheck(m.asset_id);
      } else if (et === 'price_change') {
        const touched = new Set();
        for (const c of m.price_changes || []) {
          const b = books.get(c.asset_id); if (!b) continue;
          (c.side === 'BUY' ? b.bids : b.asks).set(+c.price, +c.size); b.at = Date.now(); touched.add(c.asset_id);
        }
        touched.forEach(dangerCheck);
      } else if (et === 'tick_size_change') {
        const b = books.get(m.asset_id); if (b) b.tick = +m.new_tick_size;
      } else if (et === 'last_trade_price') {
        const id = anyIdx.get(String(m.asset_id)); const ms = id && s.markets[id];
        const why = ms && Core.toxicTrade(ms, { asset: m.asset_id, side: m.side, price: m.price, size: m.size }, s.P);
        if (why) pull(id, 'toxic: ' + why, s.P.toxicCoolMin ?? 5);
      } else if (et === 'market_resolved') {
        const tok = (m.assets_ids || m.asset_ids || []).map(String).find(x => tokenIdx.has(x));
        if (tok) { const id = tokenIdx.get(tok); out({ type: 'pull', market: id, tokens: s.markets[id].meta.tokens.map(t => String(t.id)), reason: 'market resolved' }); }
      }
    }
  };
  ws.onclose = () => { info(`ws closed · reconnect in ${wsBackoff / 1000}s`); setTimeout(connect, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 30000); };
  ws.onerror = () => { /* onclose follows */ };
}
function resubscribe() {
  tokenIdx = byToken(); anyIdx = byAnyToken();
  if (!ws || ws.readyState !== 1) return;
  const want = new Set(anyIdx.keys());
  const add = [...want].filter(x => !subscribed.has(x)), del = [...subscribed].filter(x => !want.has(x));
  if (add.length) ws.send(JSON.stringify({ assets_ids: add, operation: 'subscribe', custom_feature_enabled: true }));
  if (del.length) { ws.send(JSON.stringify({ assets_ids: del, operation: 'unsubscribe' })); del.forEach(x => books.delete(x)); }
  subscribed = want;
  if (add.length || del.length) info(`ws resubscribed +${add.length} −${del.length}`);
}
setInterval(() => { if (ws && ws.readyState === 1) ws.send('PING'); }, 10000);

// ---------------------------------------------------------------- inputs from the executor
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch (e) { return; }
  if (m.type === 'positions') {
    pos = m.pos || {}; posAt = Date.now();
    if (m.losers) E.markLosers(s, m.losers, posAt);
    if (m.kick) kick(); // kick: a fill just happened
  }
  if (m.type === 'config') {
    if (m.capital) {
      if (+m.capital > (s.P.capital || 0) + 1) s.lastRebalance = 0; // raised cap → allocate the new money now
      s.P.capital = +m.capital;
    }
    for (const [k, v] of Object.entries(m.params || {})) if (v != null && isFinite(+v)) s.P[k] = +v;
  }
}).on('close', () => process.exit(0));

// ---------------------------------------------------------------- fixed-cadence engine tick
let busy = false, lastSave = 0;
async function tick() {
  if (busy) { kick(); return; } busy = true;
  const t0 = Date.now(), logStart = s.log.length; lastTickAt = t0;
  try {
    for (const ms of Object.values(s.markets)) {
      const [yes, no] = ms.meta.tokens.map(t => String(t.id));
      ms.inv = (+pos[yes] || 0) - (+pos[no] || 0);
    }
    await E.tickOnce(s, { getBook, background: true, onRebalance: resubscribe });
    resubscribe();
    const orders = [];
    // no orders until the executor has reported real positions (never quote blind on inventory)
    if (posAt) for (const [id, ms] of Object.entries(s.markets)) {
      const [yes, no] = ms.meta.tokens.map(t => String(t.id));
      const yesHeld = +pos[yes] || 0, noHeld = +pos[no] || 0;
      const o = exitOnly(s, id, ms, ordersFor(ms, yesHeld, noHeld), yesHeld, noHeld);
      orders.push(...o);
    }
    const markets = Object.values(s.markets).map(ms => ({ id: ms.meta.id, q: ms.meta.question.slice(0, 60), status: ms.status, inv: ms.inv, mid: ms.lastMid, ws: !!getBook(ms), tokens: ms.meta.tokens.map(t => String(t.id)) }));
    out({ type: 'orders', orders, markets, log: s.log.slice(Math.min(logStart, s.log.length)).map(l => l.t), engineMs: Date.now() - t0 });
    if (Date.now() - lastSave > 30000) { lastSave = Date.now(); s.log = s.log.slice(-500); fs.writeFileSync(statePath, JSON.stringify(Object.assign({}, s, { _rebalancing: undefined }))); }
  } catch (e) {
    info('tick error: ' + (e && e.message || e));
  } finally { busy = false; }
}

fs.mkdirSync(path.dirname(statePath), { recursive: true });
connect();
setInterval(tick, TICK_MS);
tick();
