/* Safest-market screen — shared by /api/scan (Node) and the browser (window.PMSafety).
 * "Safe" here means: low adverse-selection risk per dollar of reward, not "guaranteed profit".
 */
(function (root) {
  'use strict';
  function assess(m) {
    const chgC = Math.abs(+m.chg24 || 0) * 100;
    const v = +m.v || 3;
    const spreadC = m.spread != null ? m.spread * 100 : null;
    const hrs = m.hoursToEnd;
    const checks = [
      { k: 'Mid between 20¢ and 80¢', ok: m.mid >= 0.2 && m.mid <= 0.8 },
      { k: 'Resolves more than 7 days out', ok: hrs != null && hrs > 168 },
      { k: '24h move ≤ 2¢', ok: chgC <= 2 },
      { k: 'Two-sided book, spread ≤ 3¢', ok: spreadC != null && spreadC <= 3.05 },
      { k: 'Calm flow (24h turnover < 5× band depth)', ok: (m.turnover || 0) < 5 },
      { k: 'Clears the $1 payout floor at ref size', ok: (m.refDaily || 0) >= 1 },
    ];
    const risk = chgC / v + (m.turnover || 0) / 10 + (hrs == null ? 1 : Math.max(0, 168 - hrs) / 168)
      + Math.abs((m.mid ?? 0.5) - 0.5) * 2 + (spreadC == null ? 1 : spreadC / v);
    const safety = Math.round(100 / (1 + risk));
    const passed = checks.filter(c => c.ok).length;
    return { safety, passed, total: checks.length, checks };
  }
  /** Pick the safest market: must pass every check; ties broken by expected reward. */
  function pickSafest(markets) {
    const scored = markets.filter(m => m.C != null).map(m => ({ m, a: assess(m) }));
    if (!scored.length) return null;
    scored.sort((x, y) => (y.a.passed - x.a.passed) || (y.a.safety - x.a.safety) || ((y.m.refDaily || 0) - (x.m.refDaily || 0)));
    const top = scored[0];
    return { id: top.m.id, allPassed: top.a.passed === top.a.total, ...top.a };
  }
  const api = { assess, pickSafest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PMSafety = api;
})(typeof window !== 'undefined' ? window : globalThis);
