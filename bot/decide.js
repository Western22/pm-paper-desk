#!/usr/bin/env node
// Live decision step: runs the SAME engine as the paper trader (lib/paper-engine.js + paper.js) for one tick,
// with real wallet positions as inventory, and prints the orders that should be resting.
//
//   echo '{"positions":{"<tokenId>":12.5},"capital":100,"params":{"maxMarkets":8}}' | node bot/decide.js live-state.json
//
// Output (stdout, one JSON line): { orders:[{market,question,token,side,price,size,leg}], markets:[...], log:[...] }
// No network writes, no keys: execution happens in bot/live_runner.py.
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'lib', 'paper-engine.js'));

const MIN_ORDER = 5; // CLOB minimum order size (shares); reward scoring additionally needs ≥ the market's min size

function readStdin() { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) { return {}; } }

/** Map one engine quote to CLOB orders, using held shares first (selling held YES/NO needs no new USDC). */
function ordersFor(ms, yesHeld, noHeld) {
  const q = ms.quote; if (!q) return [];
  const [yes, no] = ms.meta.tokens.map(t => String(t.id));
  const out = [];
  const add = (token, side, price, size, leg) => {
    size = Math.floor(size);
    if (size >= MIN_ORDER && price > 0 && price < 1) out.push({ market: ms.meta.id, question: ms.meta.question, token, side, price: +price.toFixed(4), size, leg });
  };
  // bid leg = buy YES exposure @ bid: sell held NO @ (1 − bid) first, the rest BUY YES @ bid
  const sellNo = Math.min(q.bs, noHeld);
  add(no, 'SELL', 1 - q.bid, sellNo, 'bid');
  add(yes, 'BUY', q.bid, q.bs - sellNo, 'bid');
  // ask leg = sell YES exposure @ ask: sell held YES @ ask first, the rest BUY NO @ (1 − ask)
  const sellYes = Math.min(q.as, yesHeld);
  add(yes, 'SELL', q.ask, sellYes, 'ask');
  add(no, 'BUY', 1 - q.ask, q.as - sellYes, 'ask');
  return out;
}

/** Exit-only markets (loss cool-down / headline): drop every BUY, keep offering held shares back. If the quote
 *  had no sell leg, offer held shares at the quote's ask (YES) / 1 − bid (NO). A flat exit-only market is closed. */
function exitOnly(s, id, ms, orders, yesHeld, noHeld, E = require(path.join(__dirname, '..', 'lib', 'paper-engine.js'))) {
  const why = E.exitOnlyReason(s, ms);
  if (!why) return orders;
  const out = orders.filter(o => o.side === 'SELL');
  const [yes, no] = ms.meta.tokens.map(t => String(t.id));
  const q = ms.quote;
  if (q && yesHeld >= MIN_ORDER && !out.some(o => o.token === yes)) out.push({ market: ms.meta.id, question: ms.meta.question, token: yes, side: 'SELL', price: +q.ask.toFixed(4), size: Math.floor(yesHeld), leg: 'exit' });
  if (q && noHeld >= MIN_ORDER && !out.some(o => o.token === no)) out.push({ market: ms.meta.id, question: ms.meta.question, token: no, side: 'SELL', price: +(1 - q.bid).toFixed(4), size: Math.floor(noHeld), leg: 'exit' });
  if (ms.status !== 'GATED') ms.status = 'EXIT ONLY';
  if (yesHeld < MIN_ORDER && noHeld < MIN_ORDER) E.closeMarket(s, id, why);
  return out;
}

/** Take profit: a held token trading above cost (`winners`: token → avg cost) is sold NOW at the live best
 *  bid — a marketable order (taker: true), not a resting ask — whenever that bid is ≥ cost + `minC` ¢ (default
 *  2¢, env TAKE_PROFIT_C): any gain is banked before it can turn into a loss. Buys of that token are dropped so
 *  the exit isn't immediately undone. */
function takeProfit(ms, orders, held, winners, bestBid, minC = +(process.env.TAKE_PROFIT_C || 2), minUsd = +(process.env.TAKE_PROFIT_USD || 1)) {
  let out = orders;
  for (const t of ms.meta.tokens.map(x => String(x.id))) {
    const avg = winners && winners.get(t), n = Math.floor(held[t] || 0), bid = bestBid(t);
    if (!avg || n < MIN_ORDER || !(bid > 0)) continue;
    const per = bid - avg; // gain per share if sold to the best bid now
    // fire on ≥ minC ¢/share, or on a ≥ $minUsd total gain (big positions) as long as it's ≥ 1¢/share
    const hit = per >= minC / 100 - 1e-9 || (per >= 0.01 - 1e-9 && per * n >= minUsd - 1e-9);
    if (!hit) continue;
    out = out.filter(o => o.token !== t);
    out.push({ market: ms.meta.id, question: ms.meta.question, token: t, side: 'SELL', price: +bid.toFixed(4), size: n, leg: 'take-profit', taker: true });
  }
  return out;
}

/** Sell-immediately: rewards come from RESTING orders, not from holding shares, and every fill so far drifted
 *  10–27¢ against us within hours. So shares bought by a fill (`flat`: token → fill info, set by the engine on a
 *  BUY fill) are sold at once to the live best bid (taker), and that token's buys are dropped until it's flat.
 *  Cost: the spread (~1–3¢/share) instead of the drift. */
function flattenOrders(ms, orders, held, flat, bestBid) {
  let out = orders;
  for (const t of ms.meta.tokens.map(x => String(x.id))) {
    const n = Math.floor(held[t] || 0), bid = bestBid(t);
    if (!flat || !flat.has(t) || n < MIN_ORDER || !(bid > 0)) continue;
    out = out.filter(o => o.token !== t);
    out.push({ market: ms.meta.id, question: ms.meta.question, token: t, side: 'SELL', price: +bid.toFixed(4), size: n, leg: 'flatten', taker: true });
  }
  return out;
}

/** The live book with OUR resting quote taken out. Polymarket's book per YES token is unified (our NO buys show
 *  up as YES asks), so without this the engine sees its own order as competition and — in a thin book where
 *  ours is the best bid — as a "mid jump" the moment it posts, and pulls itself (31 Oct: every new market
 *  self-pulled 3–22¢ seconds after POST and sat out 6 h). `b`: { bids: Map(price→size), asks: Map, ... }. */
function withoutOurs(b, q) {
  if (!b || !q) return b;
  const cut = (m, price, size) => {
    if (!(size > 0)) return m;
    const out = new Map(m);
    for (const [p, z] of m) if (Math.abs(p - price) < 1e-6) { const left = z - size; if (left > 1e-9) out.set(p, left); else out.delete(p); }
    return out;
  };
  return Object.assign({}, b, { bids: cut(b.bids, q.bid, q.bs), asks: cut(b.asks, q.ask, q.as) });
}

async function main() {
  const statePath = process.argv[2] || 'live-state.json';
  const input = readStdin();
  const pos = input.positions || {};
  let s;
  try { s = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { s = E.freshState(input.capital || 50); s.running = true; s.startedAt = Date.now(); }
  s.P.live = true;
  if (input.capital) s.P.capital = +input.capital;
  for (const [k, v] of Object.entries(input.params || {})) if (v != null && isFinite(+v)) s.P[k] = +v;
  const logStart = s.log.length;

  // real inventory: YES − NO shares held by the wallet
  for (const ms of Object.values(s.markets)) {
    const [yes, no] = ms.meta.tokens.map(t => String(t.id));
    ms.inv = (+pos[yes] || 0) - (+pos[no] || 0);
  }
  await E.tickOnce(s);

  const orders = [];
  for (const ms of Object.values(s.markets)) {
    const [yes, no] = ms.meta.tokens.map(t => String(t.id));
    orders.push(...ordersFor(ms, +pos[yes] || 0, +pos[no] || 0));
  }
  s.log = s.log.slice(-500);
  fs.writeFileSync(statePath, JSON.stringify(s));
  const markets = Object.values(s.markets).map(ms => ({ id: ms.meta.id, question: ms.meta.question, status: ms.status, budget: ms.budget, inv: ms.inv, mid: ms.lastMid, minSize: ms.meta.minSize, conditionId: ms.meta.conditionId, tokens: ms.meta.tokens.map(t => String(t.id)) }));
  process.stdout.write(JSON.stringify({ orders, markets, log: s.log.slice(Math.min(logStart, s.log.length)).map(l => l.t) }) + '\n');
}
if (require.main === module) main().catch(e => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) }) + '\n'); process.exit(1); });

module.exports = { ordersFor, exitOnly, takeProfit, flattenOrders, withoutOurs };
