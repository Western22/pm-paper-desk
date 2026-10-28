// Order mapping for live execution: held shares are sold first, the rest is collateralised buys.
const assert = require('assert');
const { ordersFor } = require('../bot/decide.js');
const ms = { meta: { id: 'm', question: 'Q', tokens: [{ id: 'Y' }, { id: 'N' }] }, quote: { bid: 0.44, ask: 0.47, bs: 30, as: 30, mode: 'two' } };

// flat wallet: BUY YES @ bid and BUY NO @ (1 − ask)
let o = ordersFor(ms, 0, 0);
assert.deepStrictEqual(o.map(x => [x.token, x.side, x.price, x.size]), [['Y', 'BUY', 0.44, 30], ['N', 'BUY', 0.53, 30]]);
// long 20 YES: ask leg sells 20 YES @ ask, buys only 10 NO
o = ordersFor(ms, 20, 0);
assert.deepStrictEqual(o.map(x => [x.token, x.side, x.price, x.size]), [['Y', 'BUY', 0.44, 30], ['Y', 'SELL', 0.47, 20], ['N', 'BUY', 0.53, 10]]);
// long 40 NO: bid leg sells 30 NO @ (1 − bid), no YES buy needed
o = ordersFor(ms, 0, 40);
assert.deepStrictEqual(o.map(x => [x.token, x.side, x.price, x.size]), [['N', 'SELL', 0.56, 30], ['N', 'BUY', 0.53, 30]]);
// sub-minimum remainders are dropped
o = ordersFor(ms, 27, 0);
assert(!o.some(x => x.size < 5), 'no orders under 5 shares');
console.log('decide ok');
