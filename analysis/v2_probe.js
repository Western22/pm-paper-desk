// Check the JS v1→v2 data-API layer: trades by market, leaderboard, holders.
const { getJSON, toV2 } = require('../api/_lib.js');
(async () => {
  const cid = '0xefa17dee3af09f69f9ddf245b969aa4efbe7c71cdf06ee49d694408bc33e2ed2';
  console.log(toV2(`https://data-api.polymarket.com/trades?market=${cid}&limit=5`));
  const tr = await getJSON(`https://data-api.polymarket.com/trades?market=${cid}&limit=5&takerOnly=false`);
  console.log('trades', tr.length, Object.entries(tr[0]).filter(([k]) => ['proxyWallet', 'side', 'outcomeIndex', 'size', 'price', 'timestamp', 'asset'].includes(k)).map(([k, v]) => k + '=' + String(v).slice(0, 12)).join(' '));
  const lb = await getJSON('https://data-api.polymarket.com/v1/leaderboard?timePeriod=MONTH&orderBy=PNL&limit=2');
  console.log('leaderboard', lb.length, lb[0].proxyWallet, Math.round(lb[0].pnl), Math.round(lb[0].vol));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
