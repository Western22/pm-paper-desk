// GET /api/book?token_id=…  → raw CLOB book (short edge cache)
const { CLOB, getJSON, send, isToken } = require('./_lib.js');
module.exports = async (req, res) => {
  const t = (req.query.token_id || '').toString();
  if (!isToken(t)) return send(res, 400, { ok: false, error: 'token_id required' });
  try { send(res, 200, await getJSON(`${CLOB}/book?token_id=${t}`), 's-maxage=2, stale-while-revalidate=10'); }
  catch (e) { send(res, 502, { ok: false, error: String(e.message || e) }); }
};
