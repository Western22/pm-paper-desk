// Shared helpers for serverless routes (files prefixed with _ are not exposed as routes).
const CLOB = 'https://clob.polymarket.com';

async function getJSONOnce(url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'pm-liquidity-desk/1.0', ...(init.headers || {}) } });
    if (!r.ok) { const e = new Error(`${r.status} ${r.statusText} ← ${url.replace(CLOB, '')}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(timer); }
}
// Polymarket retired Data API v1 (Nov 2026: every v1 path returns 410 "Data API v1 has been retired").
// v2 lives under /v2, wraps results in {data, pagination}, uses snake_case and renames a few params.
// Callers keep writing v1 URLs and reading v1 field names; this layer translates both ways.
const DATA_HOST = 'https://data-api.polymarket.com';
const V2_PARAMS = { market: 'condition' };
const V2_FIELDS = { proxy_wallet: 'proxyWallet', token_id: 'asset', condition_id: 'conditionId', outcome_index: 'outcomeIndex', usdc_size: 'usdcSize',
  current_size: 'size', avg_price: 'avgPrice', current_price: 'curPrice', realized_pnl: 'realizedPnl', unrealized_pnl: 'cashPnl', total_pnl: 'totalPnl',
  current_value: 'currentValue', event_slug: 'eventSlug', end_date: 'endDate', opposite_token_id: 'oppositeAsset', opposite_outcome: 'oppositeOutcome',
  transaction_hash: 'transactionHash', profile_image: 'profileImage', user_id: 'proxyWallet', user_name: 'userName', volume: 'vol', x_username: 'xUsername' };
function toV2(url) {
  if (!url.startsWith(DATA_HOST + '/') || url.startsWith(DATA_HOST + '/v2/')) return url;
  const u = new URL(url.replace(DATA_HOST + '/v1/', DATA_HOST + '/'));
  u.pathname = '/v2' + u.pathname;
  for (const [a, b] of Object.entries(V2_PARAMS)) if (u.searchParams.has(a)) { u.searchParams.set(b, u.searchParams.get(a)); u.searchParams.delete(a); }
  return u.toString();
}
function fromV2(body) {
  const d = body && typeof body === 'object' && 'data' in body ? body.data : body;
  const fix = o => { if (!o || typeof o !== 'object' || Array.isArray(o)) return o; const out = Object.assign({}, o); for (const [k, v] of Object.entries(o)) if (V2_FIELDS[k] && out[V2_FIELDS[k]] === undefined) out[V2_FIELDS[k]] = v; if (Array.isArray(o.holders)) out.holders = o.holders.map(fix); return out; };
  return Array.isArray(d) ? d.map(fix) : fix(d);
}

/** GET/POST JSON with retries on rate limits (429), 5xx, timeouts and network errors: 0.3 s, 0.9 s backoff. */
async function getJSON(url, init = {}, timeoutMs = 8000, retries = 2) {
  const v2 = toV2(url);
  if (v2 !== url) return fromV2(await getJSON(v2, init, timeoutMs, retries));
  for (let a = 0; ; a++) {
    try { return await getJSONOnce(url, init, timeoutMs); }
    catch (e) {
      const transient = !e.status || e.status === 429 || e.status >= 500;
      if (!transient || a >= retries) throw e;
      await new Promise(r => setTimeout(r, 300 * 3 ** a));
    }
  }
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

module.exports = { CLOB, getJSON, pool, send, isToken, toV2, fromV2 };
