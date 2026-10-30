// SPREAD_FRAC: plans that put more than the cap into one market are dropped (unless nothing else exists)
const assert = require('assert');
const E = require('../lib/paper-engine.js');
const tries = [
  { name: 'greedy', pl: [{ budget: 35 }, { budget: 15 }] },
  { name: '≤$15', pl: [{ budget: 15 }, { budget: 15 }, { budget: 10 }] },
];
assert.deepStrictEqual(E.spreadOnly(tries, { capital: 50, spreadFrac: 0 }).map(t => t.name), ['greedy', '≤$15'], 'off by default');
assert.deepStrictEqual(E.spreadOnly(tries, { capital: 50, spreadFrac: 0.3 }).map(t => t.name), ['≤$15']);
assert.strictEqual(E.spreadOnly([tries[0]], { capital: 50, spreadFrac: 0.3 }).length, 1, 'fallback when no plan fits');
console.log('spread ok');
