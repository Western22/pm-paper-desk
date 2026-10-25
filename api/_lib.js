// Shared helpers for serverless routes (files prefixed with _ are not exposed as routes).
const CLOB = 'https://clob.polymarket.com';

async function getJSON(url, init = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'pm-liquidity-desk/1.0', ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} ← ${url.replace(CLOB, '')}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}

function send(res, status, body, cache = 's-maxage=20, stale-while-revalidate=120') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200 ? cache : 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(body));
}

const isToken = s => typeof s === 'string' && /^[0-9]{10,90}$/.test(s);

module.exports = { CLOB, getJSON, pool, send, isToken };
