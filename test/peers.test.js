// Peer-wallet tracker on mocked data-api responses.
const assert = require('assert');
const { trackPeers, fromState, sharp } = require('../lib/peers.js');
const now = Date.UTC(2026, 9, 28, 12);
const ts = now / 1000 - 3600;
const W = { a: '0xaaaa000000000000000000000000000000000001', b: '0xbbbb000000000000000000000000000000000002', c: '0xcccc000000000000000000000000000000000003', o: '0xdddd000000000000000000000000000000000004', mm: '0xeeee000000000000000000000000000000000005' };
const lbAll = { [W.a]: { pnl: 52000, vol: 900000, rank: 900 }, [W.b]: { pnl: -300, vol: 4000, rank: 99999 }, [W.c]: { pnl: 0, vol: 10 }, [W.o]: { pnl: 80000, vol: 400000, rank: 300 }, [W.mm]: { pnl: 120000, vol: 260e6, rank: 1611 } };
const lbMonth = { [W.a]: { pnl: 1500 }, [W.o]: { pnl: 900 }, [W.mm]: { pnl: 4000 } };
const recent = w => (w === W.a || w === W.o || w === W.mm) ? Array.from({ length: 40 }, (_, i) => ({ realizedPnl: i < 26 ? 50 : -40 })) : [{ realizedPnl: -30 }];
const who = url => url.match(/user=(0x[0-9a-f]+)/)[1];
const calls = [];
const get = async url => {
  calls.push(url);
  if (url.includes('/trades?')) return [
    { proxyWallet: W.a, side: 'BUY', outcomeIndex: 0, size: 100, price: 0.4, timestamp: ts, pseudonym: 'Alpha' },
    { proxyWallet: W.mm, side: 'BUY', outcomeIndex: 0, size: 60, price: 0.41, timestamp: ts, pseudonym: 'Maker' },
    { proxyWallet: W.b, side: 'BUY', outcomeIndex: 0, size: 10, price: 0.42, timestamp: ts, pseudonym: 'Beta' },
    { proxyWallet: W.o, side: 'BUY', outcomeIndex: 1, size: 500, price: 0.6, timestamp: ts }, // other side: not a peer
    { proxyWallet: W.c, side: 'BUY', outcomeIndex: 0, size: 999, price: 0.3, timestamp: ts - 30 * 86400 }, // too old
  ];
  if (url.includes('/holders?')) return [
    { token: 'Y', holders: [{ proxyWallet: W.c, outcomeIndex: 0, amount: 900, pseudonym: 'Gamma' }] },
    { token: 'N', holders: [{ proxyWallet: W.o, outcomeIndex: 1, amount: 5000 }] },
  ];
  if (url.includes('/v1/leaderboard')) { const m = (url.includes('timePeriod=ALL') ? lbAll : lbMonth)[who(url)]; return m ? [m] : []; }
  if (url.includes('/closed-positions?')) { assert(url.includes('sortBy=TIMESTAMP'), 'recent closes must be time-sorted (default sort is biggest winners)'); return recent(who(url)); }
  if (url.includes('/positions?')) return [{ outcomeIndex: 0, size: 100, avgPrice: 0.4, cashPnl: 5, percentPnl: 12.5, curPrice: 0.45 }];
  if (url.includes('/traded?')) return { traded: 321 };
  if (url.includes('/value?')) return [{ value: 1234 }];
  throw new Error('unexpected ' + url);
};
(async () => {
  const r = await trackPeers([{ id: 'm1', question: 'Q?', conditionId: '0xcid', side: 0 }], { get, now });
  const m = r.markets[0];
  assert.deepStrictEqual(m.peers.map(p => p.pseudonym), ['Alpha', 'Maker', 'Beta', 'Gamma'], 'recent same-side buyers by size, then holders; old trades + other side excluded');
  const [a, mm, b] = m.peers;
  assert.strictEqual(a.boughtRecent.avg, 0.4); assert.strictEqual(a.position.pnl, 5);
  assert.strictEqual(a.record.pnl, 52000); assert.strictEqual(a.record.recentWinRate, 0.65); assert.strictEqual(a.record.style, 'directional');
  assert(a.sharp, 'Alpha: profitable all-time + month, 65% recent hit rate');
  assert.strictEqual(mm.record.style, 'market maker'); assert(!mm.sharp, 'a $260M-volume reward farmer is a competitor, not a signal');
  assert(!b.sharp, 'Beta is losing');
  assert.strictEqual(m.makers, 1); assert.strictEqual(m.sameSharp, 1); assert.strictEqual(m.opposite.sharp, 1);
  assert.strictEqual(m.verdict, 'no edge from wallets', 'one sharp wallet on each side');
  assert(!sharp({ style: 'directional', pnl: 50000, pnl30d: -10, recentClosed: 40, recentWinRate: 0.7 }), 'losing this month → not sharp');
  // state → input: only held sides; YES for long YES, NO for short YES; marks and our trading P&L
  const st = { markets: {
    x: { inv: 20, cash: -8, reward: 3, lastMid: 0.45, meta: { id: 'x', question: 'X', tokens: [{ id: 1 }, { id: 2 }] } },
    y: { inv: -10, cash: 3, lastMid: 0.4, meta: { id: 'y', question: 'Y', tokens: [{ id: 3 }, { id: 4 }] } },
    z: { inv: 0.2, cash: 0, meta: { id: 'z', question: 'Z', tokens: [{ id: 5 }, { id: 6 }] } } } };
  const inp = fromState(st);
  assert.deepStrictEqual(inp.map(i => [i.id, i.side, i.ours.mark, i.ours.tradingPnl]), [['x', 0, 0.45, 1], ['y', 1, 0.6, -1]]);
  console.log('peers ok');
})().catch(e => { console.error(e); process.exit(1); });
