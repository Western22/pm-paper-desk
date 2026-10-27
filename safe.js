/* Safest-market card + in-browser live paper test (no keys, no orders). */
(() => {
'use strict';
const Q = window.PMQ, SF = window.PMSafety;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const c = x => x == null ? '—' : (x * 100).toFixed(1) + '¢';
const pct = x => x == null || !isFinite(x) ? '—' : Math.round(x * 100).toLocaleString('en-US') + '%';

const style = document.createElement('style');
style.textContent = `
.safe{display:grid;grid-template-columns:150px minmax(0,1fr) minmax(0,1.1fr);gap:18px;align-items:center;padding:16px;margin-bottom:14px}
.safe .ring{position:relative;width:130px;height:130px}
.safe .ring svg{transform:rotate(-90deg)}
.safe .ring .val{position:absolute;inset:0;display:grid;place-items:center;text-align:center;font-family:var(--mono)}
.safe .ring .val b{font-size:30px;display:block;color:var(--mint)} .safe .ring .val span{font-size:10px;color:var(--tx3);letter-spacing:.12em}
.safe h2{font-size:16px;line-height:1.35;margin:4px 0 8px}
.safe .tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;color:var(--mint);text-transform:uppercase}
.safe .ck{display:grid;gap:4px;font-size:12px;color:var(--tx2);margin-top:8px}
.safe .ck .ok::before{content:"✓ ";color:var(--mint)} .safe .ck .no::before{content:"✗ ";color:var(--red)}
.safe .kv{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.safe .log{font-family:var(--mono);font-size:11px;line-height:1.55;background:rgba(3,5,10,.8);border:1px solid var(--line);border-radius:10px;padding:10px;height:150px;overflow:auto;margin-top:10px;white-space:pre-wrap;color:#cfe3ff}
.safe .log .g{color:var(--mint)} .safe .log .r{color:var(--red)} .safe .log .a{color:var(--amber)}
@media (max-width:1100px){.safe{grid-template-columns:130px 1fr}.safe .right{grid-column:1/-1}}
@media (max-width:640px){.safe{grid-template-columns:1fr}.safe .ring{margin:0 auto}}`;
document.head.appendChild(style);

const host = document.createElement('div');
host.className = 'panel safe';
host.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:24px">Screening for the safest reward market…</div>';
const anchor = document.querySelector('#v-scan .g-scan');
anchor.parentNode.insertBefore(host, anchor);

let current = null, running = false;

function ring(score) {
  const r = 56, C = 2 * Math.PI * r, f = Math.max(0, Math.min(score, 100)) / 100;
  return `<div class="ring"><svg width="130" height="130"><circle cx="65" cy="65" r="${r}" stroke="rgba(120,150,200,.15)" stroke-width="9" fill="none"/>
    <circle cx="65" cy="65" r="${r}" stroke="url(#sg)" stroke-width="9" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}">
    <animate attributeName="stroke-dashoffset" from="${C}" to="${C * (1 - f)}" dur="1.2s" fill="freeze" calcMode="spline" keySplines=".2 .8 .2 1" keyTimes="0;1"/></circle>
    <defs><linearGradient id="sg"><stop offset="0" stop-color="#5ad1ff"/><stop offset="1" stop-color="#3dffa8"/></linearGradient></defs></svg>
    <div class="val"><div><b>${score}</b><span>SAFETY</span></div></div></div>`;
}

function render(m, pick, live) {
  current = m;
  const days = m.hoursToEnd != null ? (m.hoursToEnd / 24).toFixed(0) + 'd' : '—';
  host.innerHTML = `${ring(pick.safety)}
    <div><div class="tag">${pick.allPassed ? '◆ Safest market right now' : '◇ Best available — not every check passed'}</div>
      <h2>${esc(m.question)}</h2>
      <div class="ck">${pick.checks.map(k => `<span class="${k.ok ? 'ok' : 'no'}">${esc(k.k)}</span>`).join('')}</div></div>
    <div class="right">
      <div class="kv">
        <div class="stat"><label>pool / day</label><div class="pos">${usd(m.rate, 0)}</div></div>
        <div class="stat"><label>ref $ / day</label><div class="pos">${usd(m.refDaily)}</div></div>
        <div class="stat"><label>ref APR</label><div>${pct(m.refAPR)}</div></div>
        <div class="stat"><label>mid</label><div>${c(m.mid)}</div></div>
        <div class="stat"><label>24h move</label><div>${((m.chg24 || 0) * 100).toFixed(1)}¢</div></div>
        <div class="stat"><label>resolves in</label><div>${days}</div></div>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn pri" id="safeLive">▶ Run live test</button><button class="btn" id="safeLab">→ Calibrate lab</button>
        <span class="dim mono" style="font-size:11px">${live ? 'live CLOB data' : 'feed unreachable'}</span></div>
      <div class="log" id="safeLog">Live test = paper-quote this market against the real order book every 4 s for ~1 min: requotes, would-be fills and modelled reward accrual. No keys, no orders.</div>
    </div>`;
  $('#safeLive').onclick = () => liveTest(m);
  $('#safeLab').onclick = () => openInDesk(m, true);
}

function openInDesk(m, toLab) {
  const tr = document.querySelector(`#tbl tbody tr[data-id="${CSS.escape(String(m.id))}"]`);
  if (tr) tr.click();
  if (toLab) setTimeout(() => { const b = $('#toLab'); if (b) b.click(); }, 300);
}

function log(html) { const el = $('#safeLog'); el.innerHTML += '\n' + html; el.scrollTop = el.scrollHeight; }

async function liveTest(m) {
  if (running) return; running = true;
  const btn = $('#safeLive'); btn.disabled = true;
  $('#safeLog').innerHTML = `<span class="a">LIVE PAPER TEST</span> · ${esc(m.question.slice(0, 60))}`;
  const size = Math.max(+($('#refSize') || {}).value || 1000, m.minSize);
  let quote = null, reward = 0, requotes = 0, fills = 0, last = Date.now(), ok = 0;
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`/api/book?token_id=${m.tokens[0].id}`, { cache: 'no-store' });
      const book = await r.json();
      if (!r.ok || book.ok === false) throw new Error(book.error || r.status);
      const comp = Q.competition(book, m.v, m.minSize);
      if (!comp) throw new Error('empty book');
      ok++;
      const now = Date.now(), dtMin = (now - last) / 60000; last = now;
      if (quote) {
        // would our resting quote have been hit by the current touch?
        if (comp.bestAsk != null && comp.bestAsk <= quote.bid) { fills++; log(`<span class="r">  ✗ bid ${quote.bid.toFixed(2)} crossed by ask ${comp.bestAsk.toFixed(2)} → paper fill (adverse)</span>`); }
        if (comp.bestBid != null && comp.bestBid >= quote.ask) { fills++; log(`<span class="r">  ✗ ask ${quote.ask.toFixed(2)} crossed by bid ${comp.bestBid.toFixed(2)} → paper fill (adverse)</span>`); }
        const est = Q.rewardEstimate({ rate: m.rate, v: m.v, C: comp.C, x: size, d: Math.max((comp.mid - quote.bid) * 100, (quote.ask - comp.mid) * 100) });
        reward += est.daily / 1440 * dtMin;
      }
      const tick = +(book.tick_size || m.tick || 0.01);
      const bid = Math.floor((comp.mid - 0.01) / tick + 1e-9) * tick, ask = Math.ceil((comp.mid + 0.01) / tick - 1e-9) * tick;
      const est = Q.rewardEstimate({ rate: m.rate, v: m.v, C: comp.C, x: size, d: Math.max((comp.mid - bid) * 100, (ask - comp.mid) * 100) });
      if (!quote || quote.bid !== bid || quote.ask !== ask) {
        requotes += quote ? 1 : 0;
        log(`<span class="g">t+${i * 4}s</span> mid ${c(comp.mid)} · C ${Math.round(comp.C).toLocaleString()} → ${quote ? 'REQUOTE' : 'POST'} BUY YES ${bid.toFixed(2)} / BUY NO ${(1 - ask).toFixed(2)} × ${size.toLocaleString()} · share ${(est.share * 100).toFixed(1)}% ≈ ${usd(est.daily)}/day`);
        quote = { bid, ask };
      } else log(`t+${i * 4}s mid ${c(comp.mid)} · hold · spread ${c(comp.spread)} · accrued ${usd(reward, 4)}`);
    } catch (e) { log(`<span class="r">t+${i * 4}s book fetch failed: ${esc(e.message || e)}</span>`); }
    if (i < 14) await new Promise(r => setTimeout(r, 4000));
  }
  log(`<span class="a">DONE</span> · ${ok}/15 live books · ${requotes} requotes · ${fills} paper fills · modelled reward ${usd(reward, 4)} over ~1 min (≈ ${usd(reward * 60 * 24, 2)}/day pace)`);
  log(fills === 0 ? '<span class="g">✓ quotes held without being crossed — candidate for the dry-run bot</span>' : '<span class="r">⚠ quotes were crossed — widen d or skip this market</span>');
  btn.disabled = false; running = false;
}

async function load() {
  const size = +($('#refSize') || {}).value || 1000;
  try {
    const r = await fetch(`/api/scan?n=80&size=${size}`, { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    const pick = j.safest || SF.pickSafest(j.markets);
    if (!pick) throw new Error('no priced markets');
    const m = j.markets.find(x => x.id === pick.id);
    const a = SF.assess(m);
    render(m, Object.assign({}, a, { allPassed: a.passed === a.total }), true);
  } catch (e) {
    host.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:24px">Safest-market screen needs the live feed (${esc(e.message || e)}). The rest of the desk runs on demo data.</div>`;
  }
}
load();
setInterval(() => { if (!running && !document.hidden) load(); }, 120000);
})();
