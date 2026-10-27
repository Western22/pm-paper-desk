// GET /api/history?token_id=…&interval=1w&fidelity=60  → {history:[{t,p}]}
const { CLOB, getJSON, send, isToken } = require('./_lib.js');
const INTERVALS = new Set(['1h', '6h', '1d', '1w', '1m', 'max']);
module.exports = async (req, res) => {
  const t = (req.query.token_id || '').toString();
  if (!isToken(t)) return send(res, 400, { ok: false, error: 'token_id required' });
  const interval = INTERVALS.has(req.query.interval) ? req.query.interval : '1w';
  const fidelity = Math.min(Math.max(parseInt(req.query.fidelity || '60', 10) || 60, 1), 1440);
  try { send(res, 200, await getJSON(`${CLOB}/prices-history?market=${t}&interval=${interval}&fidelity=${fidelity}`), 's-maxage=120, stale-while-revalidate=600'); }
  catch (e) { send(res, 502, { ok: false, error: String(e.message || e) }); }
};
