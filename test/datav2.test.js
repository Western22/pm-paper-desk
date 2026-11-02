// Data API v1 → v2 translation (v1 retired Nov 2026: 410).
const assert = require('assert');
const { toV2, fromV2 } = require('../api/_lib.js');
const H = 'https://data-api.polymarket.com';
assert.strictEqual(toV2(`${H}/trades?market=0xabc&limit=5`), `${H}/v2/trades?limit=5&condition=0xabc`);
assert.strictEqual(toV2(`${H}/v1/leaderboard?timePeriod=MONTH`), `${H}/v2/leaderboard?timePeriod=MONTH`);
assert.strictEqual(toV2(`${H}/v2/positions?user=x`), `${H}/v2/positions?user=x`);
assert.strictEqual(toV2('https://clob.polymarket.com/book?token_id=1'), 'https://clob.polymarket.com/book?token_id=1');
const rows = fromV2({ data: [{ proxy_wallet: '0xw', token_id: '9', current_size: 20, avg_price: 0.4, unrealized_pnl: -1, outcome_index: 1 }], pagination: {} });
assert.deepStrictEqual([rows[0].proxyWallet, rows[0].asset, rows[0].size, rows[0].avgPrice, rows[0].cashPnl, rows[0].outcomeIndex], ['0xw', '9', 20, 0.4, -1, 1]);
assert.strictEqual(fromV2({ data: { proxy_wallet: '0xw', value: 12.5 } }).value, 12.5);
assert.strictEqual(fromV2({ data: [{ user_id: '0xu', volume: 9, pnl: 3 }] })[0].proxyWallet, '0xu');
console.log('data api v2 ok');
