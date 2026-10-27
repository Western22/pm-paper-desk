// getJSON retries transient failures (429 / 5xx / network) but not client errors.
const assert = require('assert');
const { getJSON } = require('../api/_lib.js');
const seq = codes => { let i = 0; global.fetch = async () => { const c = codes[Math.min(i++, codes.length - 1)]; if (c === 'net') throw new TypeError('fetch failed'); return { ok: c === 200, status: c, statusText: String(c), json: async () => ({ ok: true }) }; }; return () => i; };
(async () => {
  let n = seq([429, 503, 200]); assert.deepStrictEqual(await getJSON('https://x/a'), { ok: true }); assert.strictEqual(n(), 3, 'retried twice');
  n = seq(['net', 200]); await getJSON('https://x/b'); assert.strictEqual(n(), 2, 'network error retried');
  n = seq([404, 200]); await assert.rejects(getJSON('https://x/c'), /404/); assert.strictEqual(n(), 1, '404 not retried');
  n = seq([500, 500, 500, 200]); await assert.rejects(getJSON('https://x/d'), /500/); assert.strictEqual(n(), 3, 'gives up after 2 retries');
  console.log('retry ok');
})().catch(e => { console.error(e); process.exit(1); });
