// Peer-wallet tracker: for every market the desk holds, which wallets made the same trade (bought the same
// outcome recently / hold the same side) and how profitable are they — in this market and overall.
// Also scores the opposite side, so "sharp money disagrees with us" shows up as a warning.
// Public on-chain data only (Polymarket data-api); wallets are shown by address + auto pseudonym.
const { getJSON: defaultGet } = require('../api/_lib.js');

const DATA = 'https://data-api.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const short = w => (w ? w.slice(0, 6) + '…' + w.slice(-4) : '');

/** One wallet's record. Sources (all public):
 *  - leaderboard (all-time + 30-day): true P&L, volume, rank — the closed-positions list is sorted by
 *    biggest winner by default, so summing it overstates everyone; we never use that for P&L.
 *  - the 50 most recent closed positions (sorted by time): unbiased recent hit rate.
 *  - markets traded, portfolio value. */
async function walletRecord(get, w) {
  const lb = p => get(`${DATA}/v1/leaderboard?user=${w}&timePeriod=${p}&orderBy=PNL`).then(r => (Array.isArray(r) && r[0]) || null).catch(() => null);
  const [all, month, recent, traded, value] = await Promise.all([
    lb('ALL'), lb('MONTH'),
    get(`${DATA}/closed-positions?user=${w}&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`).catch(() => []),
    get(`${DATA}/traded?user=${w}`).catch(() => null),
    get(`${DATA}/value?user=${w}`).catch(() => []),
  ]);
  const cl = Array.isArray(recent) ? recent : [];
  const wins = cl.filter(p => +p.realizedPnl > 0).length, losses = cl.filter(p => +p.realizedPnl < 0).length;
  const pnl = all ? +all.pnl : null, vol = all ? +all.vol : null;
  const margin = pnl != null && vol > 0 ? pnl / vol : null;
  // style: huge volume at a thin margin = market maker / reward farmer (a competitor, not a signal)
  const style = vol == null ? 'unknown' : vol >= 1e6 && Math.abs(margin) < 0.005 ? 'market maker' : 'directional';
  return {
    pnl: pnl != null ? +pnl.toFixed(0) : null, vol: vol != null ? +vol.toFixed(0) : null, rank: all ? +all.rank : null,
    margin: margin != null ? +(margin * 100).toFixed(2) : null, // % of volume
    pnl30d: month ? +(+month.pnl).toFixed(0) : 0,
    recentWinRate: wins + losses ? +(wins / (wins + losses)).toFixed(2) : null, recentClosed: cl.length,
    recentRealized: +cl.reduce((a, p) => a + (+p.realizedPnl || 0), 0).toFixed(0),
    markets: traded && traded.traded != null ? +traded.traded : null,
    value: +((Array.isArray(value) && value[0] && +value[0].value) || 0).toFixed(0), style,
  };
}

/** "Sharp" = a directional trader who is profitable all-time AND this month, with a decent recent hit rate. */
const sharp = r => !!r && r.style === 'directional' && r.pnl > 10000 && r.pnl30d > 0 && r.recentClosed >= 20 && (r.recentWinRate ?? 0) >= 0.55;

/**
 * @param markets [{id, question, conditionId?, tokens:[yesId,noId], side: 0|1 (outcome we hold), avgPrice?}]
 * @returns { asOf, markets:[{ id, question, side, peers:[…], opposite:{…}, verdict }] }
 */
async function trackPeers(markets, { get = defaultGet, maxPeers = 8, days = 7, now = Date.now() } = {}) {
  const cache = new Map();
  const record = w => { if (!cache.has(w)) cache.set(w, walletRecord(get, w)); return cache.get(w); };
  const since = now / 1000 - days * 86400;

  const out = await pool(markets, 3, async m => {
    let cid = m.conditionId;
    if (!cid) { const g = await get(`${GAMMA}/markets/${m.id}`).catch(() => null); cid = g && g.conditionId; }
    if (!cid) return { id: m.id, question: m.question, error: 'no conditionId' };
    const [trades, holders] = await Promise.all([
      get(`${DATA}/trades?market=${cid}&limit=500&takerOnly=false`).catch(() => []),
      get(`${DATA}/holders?market=${cid}&limit=20`).catch(() => []),
    ]);
    // recent buyers of our outcome ("made the same trade"), by size bought
    const bought = new Map();
    for (const t of Array.isArray(trades) ? trades : []) {
      if (+t.timestamp < since || t.side !== 'BUY' || +t.outcomeIndex !== m.side) continue;
      const b = bought.get(t.proxyWallet) || { shares: 0, cost: 0, pseudonym: t.pseudonym, last: 0 };
      b.shares += +t.size; b.cost += +t.size * +t.price; b.last = Math.max(b.last, +t.timestamp);
      bought.set(t.proxyWallet, b);
    }
    const hold = side => ((Array.isArray(holders) ? holders : []).find(h => +((h.holders || [])[0] || {}).outcomeIndex === side) || { holders: [] }).holders;
    const ours = hold(m.side), theirs = hold(1 - m.side);
    // peers: recent same-side buyers first, then the biggest same-side holders
    const ids = [...new Set([...[...bought.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([w]) => w), ...ours.map(h => h.proxyWallet)])]
      .filter(Boolean).slice(0, maxPeers);
    const peers = (await pool(ids, 4, async w => {
      const [rec, posArr] = await Promise.all([record(w), get(`${DATA}/positions?user=${w}&market=${cid}&sizeThreshold=0`).catch(() => [])]);
      const p = (Array.isArray(posArr) ? posArr : []).find(x => +x.outcomeIndex === m.side) || null;
      const b = bought.get(w), h = ours.find(x => x.proxyWallet === w);
      return {
        wallet: w, short: short(w), pseudonym: (b && b.pseudonym) || (h && h.pseudonym) || '',
        boughtRecent: b ? { shares: +b.shares.toFixed(1), avg: +(b.cost / b.shares).toFixed(4), last: b.last } : null,
        position: p ? { size: +(+p.size).toFixed(1), avg: +(+p.avgPrice).toFixed(4), pnl: +(+p.cashPnl).toFixed(2), pct: +(+p.percentPnl).toFixed(1), cur: +p.curPrice } : null,
        record: rec, sharp: sharp(rec),
      };
    })).filter(Boolean);
    // opposite side: the top 5 holders' records, to spot sharp money betting against us
    const opp = (await pool(theirs.slice(0, 5).map(h => h.proxyWallet), 4, async w => ({ wallet: w, short: short(w), record: await record(w) }))).filter(Boolean);
    const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
    const sameSharp = peers.filter(p => p.sharp).length, oppSharp = opp.filter(o => sharp(o.record)).length;
    const verdict = sameSharp > oppSharp ? 'sharp money agrees' : oppSharp > sameSharp ? 'sharp money on the other side' : 'no edge from wallets';
    return {
      id: m.id, question: m.question, side: m.side === 0 ? 'YES' : 'NO', ours: m.ours || null, conditionId: cid,
      peers, peerPnl: +sum(peers, p => p.record && p.record.pnl).toFixed(0), sameSharp,
      makers: peers.filter(p => p.record && p.record.style === 'market maker').length,
      opposite: { holders: opp, pnl: +sum(opp, o => o.record && o.record.pnl).toFixed(0), sharp: oppSharp },
      verdict,
    };
  });
  return { asOf: new Date(now).toISOString(), days, markets: out.filter(Boolean) };
}

/** Desk markets → tracker input: only markets where we actually hold a side. */
function fromState(s) {
  return Object.values(s.markets).filter(ms => Math.abs(ms.inv) >= 1).map(ms => {
    const mid = ms.lastMid ?? ms.meta.mid;
    return {
      id: ms.meta.id, question: ms.meta.question, conditionId: ms.meta.conditionId,
      tokens: ms.meta.tokens.map(t => String(t.id)), side: ms.inv > 0 ? 0 : 1,
      ours: { shares: +Math.abs(ms.inv).toFixed(1), mark: +(ms.inv > 0 ? mid : 1 - mid).toFixed(4), tradingPnl: +(ms.cash + ms.inv * mid).toFixed(2), rewards: +(ms.reward || 0).toFixed(2) },
    };
  });
}

module.exports = { trackPeers, fromState, walletRecord, sharp };
