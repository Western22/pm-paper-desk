/* 07 Wallets — peer-wallet report published by the paper runner (state/peers.json on the paper-state branch). */
(function () {
  'use strict';
  const URL_ = 'https://raw.githubusercontent.com/Western22/pm-paper-desk/paper-state/peers.json';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = x => x == null ? '—' : (x >= 0 ? '+$' : '−$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const cls = x => x == null ? 'dim' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'dim';
  const vol = v => v == null ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v / 1e3) + 'k';
  const pct = x => x == null ? '—' : Math.round(x * 100) + '%';

  function row(p) {
    const r = p.record || {}, pos = p.position, b = p.boughtRecent;
    const tag = p.sharp ? '<b class="pos">★</b>' : r.style === 'market maker' ? '<b class="warn">M</b>' : '';
    return `<tr><td>${tag}</td>
      <td><a class="mono" href="https://polymarket.com/profile/${esc(p.wallet)}" target="_blank" rel="noopener noreferrer">${esc(p.short)}</a> <span class="dim">${esc(p.pseudonym)}</span></td>
      <td>${b ? `${b.shares.toLocaleString()} @ ${b.avg.toFixed(3)}` : '<span class="dim">holder</span>'}</td>
      <td class="${cls(pos && pos.pnl)}">${pos ? `${usd(pos.pnl)} <span class="dim">(${pos.pct}%)</span>` : '<span class="dim">exited</span>'}</td>
      <td class="${cls(r.pnl)}">${usd(r.pnl)}</td><td class="dim">${vol(r.vol)}${r.margin != null ? ` · ${r.margin}%` : ''}</td>
      <td class="${cls(r.pnl30d)}">${usd(r.pnl30d)}</td><td>${pct(r.recentWinRate)} <span class="dim">of ${r.recentClosed ?? 0}</span></td></tr>`;
  }

  function render(d) {
    document.getElementById('wlAsOf').textContent = 'as of ' + new Date(d.asOf).toLocaleString() + ` · ${d.markets.length} positions`;
    const order = m => (/other side/.test(m.verdict) ? 0 : /agrees/.test(m.verdict) ? 1 : 2);
    document.getElementById('wlBody').innerHTML = d.markets.slice().sort((a, b) => order(a) - order(b)).map(m => {
      if (m.error) return '';
      const o = m.ours || {}, warn = /other side/.test(m.verdict), good = /agrees/.test(m.verdict);
      return `<div class="panel" style="margin-bottom:14px"><div class="ph"><h3>${esc(m.question)}</h3><span class="sp"></span>
          <span class="pill ${warn ? 'neg' : good ? 'pos' : ''}">${esc(m.verdict)}</span></div>
        <div class="pb"><div class="dim mono" style="font-size:12px;margin-bottom:8px">we hold <b>${o.shares ?? '—'} ${esc(m.side)}</b> · mark ${o.mark ?? '—'} · our trading <span class="${cls(o.tradingPnl)}">${usd(o.tradingPnl)}</span> · rewards <span class="pos">${usd(o.rewards)}</span>
          · same side: ${m.sameSharp} sharp, ${m.makers} market makers of ${m.peers.length} · opposite top-5: ${m.opposite.sharp} sharp (${usd(m.opposite.pnl)} all-time)</div>
          <div class="scroll"><table class="tbl"><thead><tr><th></th><th>Wallet</th><th>Bought (7 d)</th><th>P&amp;L here</th><th>All-time P&amp;L</th><th>Volume · margin</th><th>30 d P&amp;L</th><th>Recent hit rate</th></tr></thead>
          <tbody>${m.peers.map(row).join('')}</tbody></table></div></div></div>`;
    }).join('') || '<div class="panel"><div class="pb dim">No open positions right now.</div></div>';
  }

  let loaded = 0;
  async function load() {
    try {
      const r = await fetch(URL_ + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'first report not published yet (runner refreshes every 3 h)' : 'HTTP ' + r.status);
      render(await r.json()); loaded = Date.now();
    } catch (e) { document.getElementById('wlAsOf').textContent = 'report unavailable: ' + e.message; }
  }
  const btn = document.querySelector('#tabs button[data-v="wallets"]');
  if (btn) btn.addEventListener('click', () => { if (Date.now() - loaded > 10 * 60000) load(); });
  if (location.hash === '#wallets') load();
})();
