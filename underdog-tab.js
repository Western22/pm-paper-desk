/* 08 Underdog — paper forward-test published by the runner (state/underdog.json on the paper-state branch). */
(function () {
  'use strict';
  const URL_ = 'https://raw.githubusercontent.com/Western22/pm-paper-desk/paper-state/underdog.json';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = x => x == null ? '—' : (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(2);
  const pct = x => x == null ? '—' : (x * 100).toFixed(1) + '%';
  const cls = x => x == null ? 'dim' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim';

  function render(d) {
    const s = d.summary || {};
    $('udAsOf').textContent = `as of ${new Date(d.asOf).toLocaleString()} · running since ${new Date(d.startedAt).toLocaleDateString()}`;
    $('udPnl').textContent = usd(s.pnl); $('udPnl').className = 'v ' + cls(s.pnl);
    $('udRoi').textContent = s.roi == null ? 'no settled bets yet' : `${pct(s.roi)} per $ staked · $${(s.staked || 0).toFixed(0)} staked`;
    $('udCount').textContent = `${s.settled || 0} · ${s.open || 0}`;
    $('udBets').textContent = `${s.bets || 0} paper bets of $${d.cfg ? d.cfg.stake : 1}`;
    $('udWin').textContent = s.winRate == null ? '—' : `${pct(s.winRate)} vs ${pct(s.avgPrice)}`;
    $('udWin').className = 'v ' + (s.winRate == null ? 'dim' : s.winRate > s.avgPrice ? 'pos' : 'neg');
    $('udStreak').textContent = `${s.worstStreak || 0} · $${(s.maxDrawdown || 0).toFixed(2)}`;
    $('udDd').textContent = 'losses in a row · deepest dip from the high';
    const k = s.sized || {};
    $('udK').textContent = k.bankroll == null ? '—' : `$${k.bankroll.toFixed(2)}`;
    $('udK').className = 'v ' + cls(k.pnl);
    $('udK2').textContent = `${usd(k.pnl)} · ${k.settled || 0} settled, ${k.open || 0} open · ${k.roi == null ? '—' : pct(k.roi)} per $`;
    $('udM').textContent = k.settled ? `${k.actualWins} vs ${k.predictedWins} wins` : '—';
    $('udM2').textContent = k.settled ? `P&L ${usd(k.pnl)} vs expected ${usd(k.expectedPnl)}` : 'fills in as sized bets settle';
    $('udRows').innerHTML = (d.bets || []).map(b => `<tr><td class="dim">${new Date(b.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${esc(b.q)} <span class="dim">· ${esc(b.type)}</span></td><td>${esc(b.side)}</td><td class="mono">${(+b.price).toFixed(3)}</td>
      <td class="mono">${b.edge == null ? '—' : pct(b.edge)}</td><td class="mono">${b.kstake ? '$' + b.kstake.toFixed(2) : '—'}</td>
      <td class="${b.status === 'won' ? 'pos' : b.status === 'lost' ? 'neg' : 'dim'}">${esc(b.status)}</td><td class="mono ${cls(b.pnl)}">${b.pnl == null ? '—' : usd(b.pnl)}</td></tr>`).join('')
      || '<tr><td colspan="8" class="dim">No bets yet — the runner scans every 30 min.</td></tr>';
    $('udLog').innerHTML = (d.log || []).map(l => `<div><span class="dim">${new Date(l.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> ${esc(l.t)}</div>`).join('');
  }

  let loaded = 0;
  async function load() {
    try {
      const r = await fetch(URL_ + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'first results not published yet (the runner writes them within ~10 min of its next start)' : 'HTTP ' + r.status);
      render(await r.json()); loaded = Date.now();
    } catch (e) { $('udAsOf').textContent = 'unavailable: ' + e.message; }
  }
  const btn = document.querySelector('#tabs button[data-v="underdog"]');
  if (btn) btn.addEventListener('click', () => { if (Date.now() - loaded > 5 * 60000) load(); });
  if (location.hash === '#underdog') load();
  setInterval(() => { if (document.querySelector('#v-underdog.on')) load(); }, 5 * 60000);
})();
