// paper-config.json is untrusted input (a person or an AI agent edits it): only bounded keys, clamped.
const assert = require('assert');
const E = require('../lib/paper-engine.js');
const { applyConfig } = require('../runner/run.js');
const s = E.freshState(200);
applyConfig(s, { running: true, maxMarkets: 99, toxicUsd: 150, payoutFloor: 0, capital: 1e6, tickSec: 0.01, live: 1, gate: 'abc' });
assert.strictEqual(s.P.maxMarkets, 16, 'clamped to max');
assert.strictEqual(s.P.toxicUsd, 150, 'in-range value applied');
assert.strictEqual(s.P.payoutFloor, 1, 'fixed key cannot move');
assert.strictEqual(s.P.capital, 200, 'capital is not agent-tunable');
assert.notStrictEqual(s.P.tickSec, 0.01, 'tick not tunable');
assert(!s.P.live, 'live flag never settable from config');
assert.strictEqual(s.P.gate, E.freshState(200).P.gate, 'non-numeric ignored');
console.log('bounds ok');
