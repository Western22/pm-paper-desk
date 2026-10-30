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

// spare-capital rebalance: $68 cap, $50 given to markets → rebalance once 30 min have passed, not before
{
  const now = Date.now();
  const s = E.freshState(68); s.P.live = true; s.P.rebalanceH = 6;
  s.markets = { a: { budget: 30 }, b: { budget: 20 } };
  s.lastRebalance = now - 10 * 60000;
  assert.strictEqual(E.needsRebalance(s, now, false), false, 'too soon');
  s.lastRebalance = now - 31 * 60000;
  assert.strictEqual(E.needsRebalance(s, now, false), true, '$18 spare after 31 min');
  s.markets.c = { budget: 15 };
  assert.strictEqual(E.needsRebalance(s, now, false), false, 'only $3 spare');
  s.P.live = false; s.markets = {};
  assert.strictEqual(E.needsRebalance(s, now, false), false, 'paper keeps its 6 h cycle');
  console.log('spare rebalance ok');
}
