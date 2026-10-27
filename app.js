/* Liquidity Desk — UI controller */
(() => {
'use strict';
const Q = window.PMQ;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { mint: css('--mint'), cyan: css('--cyan'), violet: css('--violet'), amber: css('--amber'), red: css('--red'), slate: css('--slate'), tx2: css('--tx2'), tx3: css('--tx3'), line: 'rgba(120,150,200,.14)' };
const fmt = {
  usd: (x, d = 0) => x == null || !isFinite(x) ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }),
  num: (x, d = 0) => x == null || !isFinite(x) ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }),
  pct: (x, d = 0) => x == null || !isFinite(x) ? '—' : (x * 100).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) + '%',
  k: x => x == null || !isFinite(x) ? '—' : Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(0),
  c: x => x == null ? '—' : (x * 100).toFixed(1) + '¢',
  sgn: (x, f) => (x > 0 ? '+' : '') + f(x),
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ease = t => 1 - Math.pow(1 - t, 3);

function countUp(el, to, f, ms = 900) {
  const from = +el.dataset.v || 0; el.dataset.v = to;
  const t0 = performance.now();
  const step = now => { const t = Math.min((now - t0) / ms, 1); el.textContent = f(from + (to - from) * ease(t)); if (t < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ---------- canvas helpers ---------- */
function ctx2d(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const h = +cv.dataset.h || +cv.getAttribute('height'); cv.dataset.h = h;
  const w = cv.clientWidth || cv.parentElement.clientWidth;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px';
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = '11px JetBrains Mono, monospace';
  return { c, w, h };
}
function axes(c, x0, y0, x1, y1, yMin, yMax, fy, ticks = 5) {
  c.strokeStyle = COL.line; c.fillStyle = COL.tx3; c.lineWidth = 1; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (yMax - yMin) * i / ticks, y = y1 - (y1 - y0) * i / ticks;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.fillText(fy(v), x0 - 6, y);
  }
}

/* ---------- animated background: order-flow field ---------- */
(function bg() {
  const cv = $('#bg'), c = cv.getContext('2d');
  let W, H, parts = [];
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; parts = Array.from({ length: Math.min(90, Math.floor(W / 16)) }, mk); };
  const mk = () => ({ x: Math.random() * W, y: Math.random() * H, v: .2 + Math.random() * .9, s: Math.random() < .5 ? 1 : -1, a: Math.random() * 6.28, r: .6 + Math.random() * 1.6 });
  resize(); addEventListener('resize', resize);
  let t = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  (function loop() {
    t += .004;
    c.clearRect(0, 0, W, H);
    const g = c.createRadialGradient(W * .8, -H * .1, 0, W * .8, -H * .1, H * 1.1);
    g.addColorStop(0, 'rgba(61,255,168,.07)'); g.addColorStop(.5, 'rgba(90,209,255,.03)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(120,150,200,.045)'; c.lineWidth = 1;
    const gs = 56, off = (t * 40) % gs;
    for (let x = -off; x < W; x += gs) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += gs) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    for (const p of parts) {
      p.x += p.v * p.s; p.y += Math.sin(t * 3 + p.a) * .25;
      if (p.x > W + 20) p.x = -20; if (p.x < -20) p.x = W + 20;
      c.fillStyle = p.s > 0 ? 'rgba(61,255,168,.55)' : 'rgba(255,93,115,.45)';
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.28); c.fill();
      c.strokeStyle = p.s > 0 ? 'rgba(61,255,168,.08)' : 'rgba(255,93,115,.07)';
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.s * p.v * 26, p.y); c.stroke();
    }
    if (!reduce) requestAnimationFrame(loop);
  })();
})();

/* ---------- clock / epoch ---------- */
function tickClock() {
  const n = new Date();
  $('#clock').textContent = n.toISOString().slice(11, 19);
  const mid = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1);
  const s = Math.floor((mid - n) / 1000);
  $('#epoch').textContent = [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  $('#sample').textContent = '#' + String(n.getUTCHours() * 60 + n.getUTCMinutes() + 1).padStart(4, '0');
}
setInterval(tickClock, 1000); tickClock();

/* ---------- tabs ---------- */
const views = {};
$$('#tabs button').forEach(b => b.onclick = () => {
  $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + b.dataset.v));
  location.hash = b.dataset.v;
  (views[b.dataset.v] || (() => {}))();
});

/* ---------- state ---------- */
const S = { markets: [], demo: false, sel: null, sort: { k: 'score', dir: -1 }, book: null, hist: null, bookTimer: null,
  env: null, envLabel: '', params: Object.assign({}, Q.DEFAULT_PARAMS), lab: null, alloc: null };

/* ---------- data ---------- */
async function api(path, tries = 3) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(40000) });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || r.status);
      return j;
    } catch (e) {
      if (a >= tries) throw e;
      setFeed('live', `feed slow — retrying (${a}/${tries - 1})…`);
      await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
}
let scanRetry = null;
function setFeed(state, txt) {
  $('#feedDot').className = 'dot' + (state === 'demo' ? ' demo' : state === 'err' ? ' err' : '');
  $('#feedTxt').textContent = txt;
}

function demoMarkets(size) {
  const r = Q.rng(42);
  const topics = ['Fed cuts rates at next meeting?', 'BTC above $120k on Dec 31?', 'ETH ETF net inflows positive this week?', 'Home team wins tonight?', 'Over 2.5 goals in the derby?',
    'Incumbent party wins the regional election?', 'CPI YoY prints above 3.0%?', 'Box-office opener tops $100M?', 'Will the ceasefire hold through month-end?', 'Team A wins the championship?',
    'GDP growth above 2% this quarter?', 'Unemployment rate rises next print?', 'Tech giant announces new CEO this year?', 'SOL flips $300 this month?', 'Record temperature this summer?'];
  const out = [];
  for (let i = 0; i < 36; i++) {
    const mid = Math.round((0.08 + r() * 0.84) * 100) / 100, rate = Math.round(Math.exp(2.5 + r() * 4)), v = [2, 2.5, 3, 3.5, 4.5][Math.floor(r() * 5)];
    const minSize = [20, 50, 100, 200][Math.floor(r() * 4)], C = Math.round(Math.exp(4 + r() * 6.5));
    const est = Q.rewardEstimate({ rate, v, C, x: Math.max(size, minSize), d: 1 });
    const chg = (r() - .5) * 0.12;
    out.push({ id: 'demo' + i, conditionId: '0xdemo' + i, question: topics[i % topics.length] + (i >= topics.length ? ` (#${i})` : ''), rate, v, minSize, mid, C,
      qb: C * (0.6 + r() * .8), qa: C * (0.6 + r() * .8), spread: 0.01 + Math.floor(r() * 3) / 100, tick: 0.01, vol24: Math.round(Math.exp(6 + r() * 5)), chg24: chg,
      tokens: [{ id: '1', outcome: 'Yes', price: mid }, { id: '2', outcome: 'No', price: 1 - mid }], hoursToEnd: 24 + r() * 2000, refSize: size,
      refDaily: est.daily, refShare: est.share, refAPR: est.apr, turnover: r() * 30,
      score: est.apr / (1 + Math.abs(chg) * 100 / v) / (1 + r()) * (mid >= .1 && mid <= .9 ? 1 : .4), demo: true });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function scan() {
  const size = +$('#refSize').value || 1000;
  $('#rescan').disabled = true;
  setFeed('live', 'scanning CLOB…');
  try {
    const q = $('#q').value.trim();
    const j = await api(`/api/scan?n=80&size=${size}${q ? '&q=' + encodeURIComponent(q) : ''}`);
    S.markets = j.markets; S.demo = false;
    clearTimeout(scanRetry); scanRetry = null;
    setFeed('live', j.stale ? `LIVE (cached ${Math.round((Date.now() - Date.parse(j.asOf)) / 60000)} min) · ${j.count} books` : `LIVE · ${j.count} books · ${j.ms}ms`);
  } catch (e) {
    console.warn('scan failed → demo', e);
    S.markets = demoMarkets(size); S.demo = true;
    setFeed('demo', 'DEMO DATA · live feed unreachable — retrying in 30 s');
    clearTimeout(scanRetry); scanRetry = setTimeout(scan, 30000); // recover on its own
  }
  $('#rescan').disabled = false;
  renderScan();
  if (!S.sel && S.markets.length) select(S.markets[0].id);
}

/* ---------- scanner ---------- */
function renderScan() {
  const ms = S.markets;
  const pool = ms.reduce((a, m) => a + m.rate, 0);
  const aprs = ms.map(m => m.refAPR).filter(x => x != null).sort((a, b) => a - b);
  const med = aprs.length ? aprs[Math.floor(aprs.length / 2)] : null;
  countUp($('#k-pool'), pool, x => fmt.usd(x));
  countUp($('#k-n'), ms.length, x => fmt.num(x));
  $('#k-n-s').textContent = S.demo ? 'synthetic demo set' : 'books priced live';
  countUp($('#k-apr'), (med || 0) * 100, x => fmt.num(x) + '%');
  const best = ms[0];
  if (best) { countUp($('#k-best'), best.score * 100, x => fmt.num(x)); $('#k-best-s').textContent = best.question.slice(0, 40); }
  countUp($('#k-thin'), ms.filter(m => m.C != null && m.C < 500).length, x => fmt.num(x));
  $('#k-pool-s').textContent = `across ${ms.length} markets · ref ${fmt.num(+$('#refSize').value)} sh`;
  // ticker
  const items = ms.slice(0, 24).map(m => `<span>${esc(m.question.slice(0, 48))}<b>${fmt.usd(m.rate)}/d</b><em>mid ${fmt.c(m.mid)} · APR ${fmt.pct(m.refAPR)}</em></span>`).join('');
  $('#ticker').innerHTML = items + items;
  renderTable();
}

function renderTable() {
  const { k, dir } = S.sort;
  const rows = [...S.markets].sort((a, b) => {
    const x = a[k], y = b[k];
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  const maxScore = Math.max(...rows.map(r => r.score || 0), 1e-9);
  $('#tbl tbody').innerHTML = rows.map((m, i) => `<tr data-id="${esc(m.id)}" class="${S.sel && S.sel.id === m.id ? 'sel' : ''}" style="animation-delay:${Math.min(i * 18, 600)}ms">
    <td><div class="q" title="${esc(m.question)}">${esc(m.question)}</div></td>
    <td class="pos">${fmt.usd(m.rate)}</td><td class="hm">${fmt.c(m.mid)}</td><td class="hm">±${m.v}¢</td>
    <td>${fmt.k(m.C)}</td><td class="hm">${fmt.pct(m.refShare, 1)}</td><td>${fmt.pct(m.refAPR)}</td>
    <td><div class="bar"><i style="width:${(m.score / maxScore * 100).toFixed(1)}%"></i></div></td></tr>`).join('');
  $$('#tbl tbody tr').forEach(tr => tr.onclick = () => select(tr.dataset.id));
}
$$('#tbl th').forEach(th => th.onclick = () => {
  const k = th.dataset.k; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : -1 }; renderTable();
});
$('#rescan').onclick = scan;
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') scan(); });

function demoBook(m) {
  const r = Q.rng(m.id.length * 97 + Math.floor(Date.now() / 4000));
  const bids = [], asks = [];
  for (let i = 1; i <= 8; i++) {
    bids.push({ price: (m.mid - i * 0.01 + 0.005).toFixed(3), size: String(Math.round(Math.exp(3 + r() * 4.5))) });
    asks.push({ price: (m.mid + i * 0.01 - 0.005).toFixed(3), size: String(Math.round(Math.exp(3 + r() * 4.5))) });
  }
  return { bids, asks, tick_size: '0.01' };
}

async function select(id) {
  const m = S.markets.find(x => x.id === id); if (!m) return;
  S.sel = m; S.hist = null; S.book = null;
  $$('#tbl tbody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.id === id));
  const link = m.eventSlug ? `https://polymarket.com/event/${encodeURIComponent(m.eventSlug)}` : null;
  $('#detail').innerHTML = `<div class="ph"><h3>Market detail</h3><span class="sp"></span>${link ? `<a class="btn" href="${link}" target="_blank" rel="noopener">↗ Polymarket</a>` : ''}<button class="btn pri" id="toLab">→ Calibrate lab</button></div>
    <div class="pb"><div class="detail-h">${m.image ? `<img src="${esc(m.image)}" alt="" onerror="this.remove()">` : ''}<div><h2>${esc(m.question)}</h2>
      <div class="chips"><span class="chip">pool <b>${fmt.usd(m.rate)}/day</b></span><span class="chip">band <b>±${m.v}¢</b></span><span class="chip">min size <b>${m.minSize}</b></span>
      <span class="chip">24h vol <b>${fmt.usd(m.vol24)}</b></span><span class="chip">24h Δ <b class="${m.chg24 >= 0 ? 'pos' : 'neg'}">${fmt.sgn(m.chg24 * 100, x => x.toFixed(1))}¢</b></span>
      ${m.hoursToEnd != null ? `<span class="chip">ends <b>${m.hoursToEnd < 48 ? m.hoursToEnd.toFixed(0) + 'h' : (m.hoursToEnd / 24).toFixed(0) + 'd'}</b></span>` : ''}</div></div></div>
      <div class="stats"><div class="stat"><label>adj. mid</label><div id="d-mid">${fmt.c(m.mid)}</div></div><div class="stat"><label>competing C</label><div id="d-c">${fmt.k(m.C)}</div></div>
        <div class="stat"><label>ref $/day</label><div class="pos" id="d-day">${fmt.usd(m.refDaily, 2)}</div></div></div>
      <div class="legend" style="margin-bottom:6px"><span><i style="background:var(--mint)"></i>bids</span><span><i style="background:var(--red)"></i>asks</span><span><i style="background:var(--amber)"></i>S(v,s) reward band</span><span><i style="background:var(--cyan)"></i>your ref quote</span></div>
      <canvas class="ch" id="cBook" height="230"></canvas>
      <div class="ph" style="margin:12px -14px 8px;border-top:1px solid var(--line)"><h3>YES price · 7d hourly</h3><span class="sp"></span><span class="dim mono" style="font-size:11px" id="d-vol"></span></div>
      <canvas class="ch" id="cHist2" height="150"></canvas></div>`;
  $('#toLab').onclick = () => calibrateFrom(m);
  clearInterval(S.bookTimer);
  const poll = async () => {
    if (S.sel !== m) return;
    try { S.book = m.demo ? demoBook(m) : await api(`/api/book?token_id=${m.tokens[0].id}`); }
    catch (e) { S.book = demoBook(m); }
    drawBook(m);
  };
  poll(); S.bookTimer = setInterval(() => { if ($('#v-scan').classList.contains('on')) poll(); }, 4000);
  try {
    if (m.demo) throw 0;
    const h = await api(`/api/history?token_id=${m.tokens[0].id}&interval=1w&fidelity=60`);
    S.hist = h.history || [];
  } catch (e) {
    const r = Q.rng(7); let p = m.mid; const now = Date.now() / 1000; S.hist = [];
    for (let i = 168; i >= 0; i--) { p = Math.min(.99, Math.max(.01, p + (r() - .5) * .012)); S.hist.push({ t: now - i * 3600, p }); }
  }
  if (S.sel === m) drawHist(m);
}

const bookAnim = { bars: new Map() };
function drawBook(m) {
  const cv = $('#cBook'); if (!cv) return;
  const comp = Q.competition(S.book, m.v, m.minSize);
  if (comp) {
    $('#d-mid').textContent = fmt.c(comp.mid); $('#d-c').textContent = fmt.k(comp.C);
    const est = Q.rewardEstimate({ rate: m.rate, v: m.v, C: comp.C, x: Math.max(+$('#refSize').value || 1000, m.minSize), d: 1 });
    $('#d-day').textContent = fmt.usd(est.daily, 2);
    S.selComp = comp;
  }
  const book = Q.normBook(S.book);
  const mid = comp ? comp.mid : m.mid;
  const span = (m.v + 2.5) / 100;
  const lv = [...book.bids.filter(l => l.p >= mid - span).map(l => ({ ...l, side: 'b' })), ...book.asks.filter(l => l.p <= mid + span).map(l => ({ ...l, side: 'a' }))];
  const maxS = Math.max(...lv.map(l => l.s), m.minSize * 2, 10);
  const t0 = performance.now();
  const from = new Map(bookAnim.bars);
  const frame = now => {
    const k = Math.min((now - t0) / 500, 1), e = ease(k);
    const { c, w, h } = ctx2d(cv);
    const x0 = 8, x1 = w - 8, y0 = 14, y1 = h - 22;
    const X = p => x0 + (p - (mid - span)) / (2 * span) * (x1 - x0);
    // reward band heat
    for (let i = 0; i < 80; i++) {
      const s = (i / 80) * m.v, a = Q.S(m.v, s) * 0.22;
      c.fillStyle = `rgba(255,181,71,${a})`;
      const wpx = (m.v / 80) / 100 / (2 * span) * (x1 - x0) + 1;
      c.fillRect(X(mid - s / 100) - wpx, y0, wpx, y1 - y0); c.fillRect(X(mid + s / 100), y0, wpx, y1 - y0);
    }
    // S curve
    c.strokeStyle = COL.amber; c.setLineDash([4, 4]); c.lineWidth = 1.2; c.beginPath();
    for (let i = -100; i <= 100; i++) { const s = Math.abs(i) / 100 * (m.v + 1); const p = mid + Math.sign(i) * s / 100; const y = y1 - Q.S(m.v, s) * (y1 - y0) * 0.95; i === -100 ? c.moveTo(X(p), y) : c.lineTo(X(p), y); }
    c.stroke(); c.setLineDash([]);
    // bars
    const bw = Math.max(4, (0.01 / (2 * span)) * (x1 - x0) * 0.62);
    for (const l of lv) {
      const key = l.side + l.p.toFixed(3);
      const target = Math.sqrt(l.s / maxS) * (y1 - y0) * 0.9;
      const prev = from.has(key) ? from.get(key) : 0;
      const hh = prev + (target - prev) * e;
      bookAnim.bars.set(key, hh);
      const scored = l.s >= m.minSize && Math.abs(l.p - mid) * 100 < m.v;
      c.fillStyle = l.side === 'b' ? (scored ? 'rgba(61,255,168,.85)' : 'rgba(61,255,168,.3)') : (scored ? 'rgba(255,93,115,.85)' : 'rgba(255,93,115,.3)');
      c.fillRect(X(l.p) - bw / 2, y1 - hh, bw, hh);
      if (k === 1 && hh > 22) { c.save(); c.fillStyle = 'rgba(230,237,247,.8)'; c.font = '9.5px JetBrains Mono'; c.textAlign = 'center'; c.fillText(fmt.k(l.s), X(l.p), y1 - hh - 5); c.restore(); }
    }
    // mid + ref quotes
    c.strokeStyle = 'rgba(230,237,247,.7)'; c.beginPath(); c.moveTo(X(mid), y0 - 6); c.lineTo(X(mid), y1); c.stroke();
    c.strokeStyle = COL.cyan; c.lineWidth = 2;
    for (const p of [mid - 0.01, mid + 0.01]) { c.beginPath(); c.moveTo(X(p), y0); c.lineTo(X(p), y1); c.stroke(); }
    c.lineWidth = 1;
    c.fillStyle = COL.tx3; c.textAlign = 'center'; c.textBaseline = 'top';
    for (let d = -Math.floor(span * 100); d <= Math.floor(span * 100); d++) c.fillText((d > 0 ? '+' : '') + d, X(mid + d / 100), y1 + 6);
    c.fillStyle = COL.tx2; c.textAlign = 'left'; c.fillText(`mid ${fmt.c(mid)}`, X(mid) + 4, y0 - 12);
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function drawHist(m) {
  const cv = $('#cHist2'); if (!cv || !S.hist || !S.hist.length) return;
  const H = S.hist;
  const ps = H.map(x => +x.p), lo = Math.max(0, Math.min(...ps) - .02), hi = Math.min(1, Math.max(...ps) + .02);
  // realised vol in cents/hour
  const d = []; for (let i = 1; i < ps.length; i++) d.push(Math.abs(ps[i] - ps[i - 1]) * 100);
  const mad = d.length ? d.sort((a, b) => a - b)[Math.floor(d.length / 2)] : 0;
  $('#d-vol').textContent = `median |Δ| ${mad.toFixed(2)}¢/h · range ${fmt.c(Math.min(...ps))}–${fmt.c(Math.max(...ps))}`;
  const t0 = performance.now();
  const frame = now => {
    const k = Math.min((now - t0) / 900, 1);
    const { c, w, h } = ctx2d(cv);
    const x0 = 40, x1 = w - 6, y0 = 8, y1 = h - 16;
    axes(c, x0, y0, x1, y1, lo, hi, v => (v * 100).toFixed(0) + '¢', 3);
    const n = Math.max(2, Math.floor(H.length * ease(k)));
    const X = i => x0 + i / (H.length - 1) * (x1 - x0), Y = p => y1 - (p - lo) / (hi - lo) * (y1 - y0);
    const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(90,209,255,.28)'); g.addColorStop(1, 'rgba(90,209,255,0)');
    c.beginPath(); c.moveTo(X(0), y1); for (let i = 0; i < n; i++) c.lineTo(X(i), Y(ps[i])); c.lineTo(X(n - 1), y1); c.fillStyle = g; c.fill();
    c.beginPath(); for (let i = 0; i < n; i++) i ? c.lineTo(X(i), Y(ps[i])) : c.moveTo(X(i), Y(ps[i])); c.strokeStyle = COL.cyan; c.lineWidth = 1.6; c.stroke();
    c.fillStyle = COL.cyan; c.beginPath(); c.arc(X(n - 1), Y(ps[n - 1]), 3, 0, 6.28); c.fill();
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ---------- scoring tab ---------- */
function scoring() {
  const g = id => +$('#' + id).value;
  const v = g('s-v'), d = g('s-d'), x = g('s-x'), R = g('s-r'), C = g('s-c'), mid = g('s-m');
  $('#o-v').textContent = v + '¢'; $('#o-d').textContent = d.toFixed(1) + '¢'; $('#o-x').textContent = fmt.num(x);
  $('#o-r').textContent = fmt.usd(R); $('#o-c').textContent = fmt.num(C); $('#o-m').textContent = fmt.c(mid);
  const sc = Q.S(v, d), qOne = sc * x, two = Q.qmin(qOne, qOne, mid), one = Q.qmin(qOne, 0, mid);
  const est = Q.rewardEstimate({ rate: R, v, C, x, d });
  const oneSide = one > 0 ? R * one / (one + C) : 0;
  $('#scoreStats').innerHTML = `<div class="stat"><label>S per share</label><div>${sc.toFixed(3)}</div></div>
    <div class="stat"><label>Q_min two-sided</label><div>${fmt.num(two)}</div></div>
    <div class="stat"><label>pool share</label><div>${fmt.pct(est.share, 1)}</div></div>
    <div class="stat"><label>$ / day</label><div class="pos">${fmt.usd(est.daily, 2)}</div></div>
    <div class="stat"><label>APR on ~${fmt.usd(x)}</label><div class="pos">${fmt.pct(est.apr)}</div></div>
    <div class="stat"><label>one-sided $ / day</label><div class="${one > 0 ? 'warn' : 'neg'}">${fmt.usd(oneSide, 2)}${one > 0 ? '' : ' · 0 outside 10–90¢'}</div></div>`;
  // S curve
  { const { c, w, h } = ctx2d($('#cS'));
    const x0 = 36, x1 = w - 10, y0 = 12, y1 = h - 24, vmax = 6;
    axes(c, x0, y0, x1, y1, 0, 1, t => t.toFixed(1), 4);
    const X = s => x0 + s / vmax * (x1 - x0), Y = t => y1 - t * (y1 - y0);
    c.fillStyle = 'rgba(255,181,71,.08)'; c.fillRect(X(0), y0, X(v) - X(0), y1 - y0);
    const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(61,255,168,.35)'); g.addColorStop(1, 'rgba(61,255,168,0)');
    c.beginPath(); c.moveTo(X(0), y1); for (let s = 0; s <= vmax; s += .02) c.lineTo(X(s), Y(Q.S(v, s))); c.lineTo(X(vmax), y1); c.fillStyle = g; c.fill();
    c.beginPath(); for (let s = 0; s <= vmax; s += .02) s ? c.lineTo(X(s), Y(Q.S(v, s))) : c.moveTo(X(s), Y(Q.S(v, s))); c.strokeStyle = COL.mint; c.lineWidth = 2; c.stroke();
    c.strokeStyle = 'rgba(122,138,165,.6)'; c.setLineDash([3, 4]); c.beginPath(); for (let s = 0; s <= vmax; s += .05) { const lin = Math.max(0, 1 - s / v); s ? c.lineTo(X(s), Y(lin)) : c.moveTo(X(s), Y(lin)); } c.stroke(); c.setLineDash([]);
    c.strokeStyle = COL.cyan; c.beginPath(); c.moveTo(X(d), y0); c.lineTo(X(d), y1); c.stroke();
    c.fillStyle = COL.cyan; c.beginPath(); c.arc(X(d), Y(sc), 6, 0, 6.28); c.fill();
    c.fillStyle = 'rgba(90,209,255,.25)'; c.beginPath(); c.arc(X(d), Y(sc), 12 + 3 * Math.sin(performance.now() / 300), 0, 6.28); c.fill();
    c.fillStyle = COL.tx3; c.textAlign = 'center'; c.textBaseline = 'top';
    for (let s = 0; s <= vmax; s++) c.fillText(s + '¢', X(s), y1 + 6);
    c.textAlign = 'left'; c.fillStyle = COL.tx2; c.fillText('quadratic', X(0.2), Y(0.95)); c.fillStyle = COL.slate; c.fillText('linear (for contrast)', X(v * .45), Y(1 - .45) - 14);
  }
  // share vs size
  { const { c, w, h } = ctx2d($('#cShare'));
    const x0 = 46, x1 = w - 10, y0 = 10, y1 = h - 22, xmax = 20000;
    const f = xx => Q.rewardEstimate({ rate: R, v, C, x: xx, d }).daily;
    const ymax = Math.max(R * 0.05, f(xmax)) * 1.1;
    axes(c, x0, y0, x1, y1, 0, ymax, t => '$' + (t >= 100 ? t.toFixed(0) : t.toFixed(1)), 4);
    const X = s => x0 + s / xmax * (x1 - x0), Y = t => y1 - t / ymax * (y1 - y0);
    c.beginPath(); for (let s = 0; s <= xmax; s += 100) s ? c.lineTo(X(s), Y(f(s))) : c.moveTo(X(s), Y(f(s))); c.strokeStyle = COL.mint; c.lineWidth = 2; c.stroke();
    c.beginPath(); for (let s = 0; s <= xmax; s += 100) { const mg = (f(s + 1000) - f(s)); s ? c.lineTo(X(s), Y(mg)) : c.moveTo(X(s), Y(mg)); } c.strokeStyle = COL.amber; c.lineWidth = 1.4; c.stroke();
    c.fillStyle = COL.cyan; c.beginPath(); c.arc(X(Math.min(x, xmax)), Y(f(x)), 5, 0, 6.28); c.fill();
    c.fillStyle = COL.tx3; c.textAlign = 'center'; c.textBaseline = 'top';
    for (let s = 0; s <= xmax; s += 5000) c.fillText(fmt.k(s), X(s), y1 + 6);
  }
}
$$('#v-score input').forEach(i => i.addEventListener('input', scoring));
views.score = scoring;

/* ---------- strategy lab ---------- */
const ENV_FIELDS = [['rate', '$/day pool', 5], ['C', 'competing C', 50], ['v', 'band v ¢', .5], ['minSize', 'min size', 10], ['p0', 'start mid', .01], ['volL', 'logit vol /day', .01],
  ['jumpsPerDay', 'jumps /day', .1], ['jumpL', 'jump size (logit)', .01], ['noise', 'taker flow /min', .05], ['kappa', 'flow decay κ', .05], ['markout', 'markout ¢', .1], ['toxSlope', 'depth toxicity', .05]];
const PAR_FIELDS = [['size', 'max size / side', 50], ['invCap', 'inventory cap', 100], ['gamma', 'γ skew', .1], ['gate', 'vol gate ×', .1], ['cooldown', 'cooldown min', 1]];
function buildLabForm() {
  const sel = $('#preset');
  sel.innerHTML = Object.entries(Q.PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  sel.onchange = () => { loadEnv(Object.assign({ toxSlope: 0.7 }, Q.PRESETS[sel.value]), ''); };
  loadEnv(Object.assign({ toxSlope: 0.7 }, Q.PRESETS.politics), '');
  $('#parFields').innerHTML = PAR_FIELDS.map(([k, l, st]) => `<div class="field">${l}<input data-p="${k}" type="number" step="${st}" value="${S.params[k]}"></div>`).join('');
}
function loadEnv(env, label) {
  S.env = env; S.envLabel = label;
  $('#envFields').innerHTML = ENV_FIELDS.map(([k, l, st]) => `<div class="field">${l}<input data-e="${k}" type="number" step="${st}" value="${+((+env[k] || 0).toPrecision(4))}"></div>`).join('')
    + `<div class="field">roll daily (new contract)<select data-e="resetDaily"><option value="0">no</option><option value="1" ${env.resetDaily ? 'selected' : ''}>yes</option></select></div>`;
  $('#calibNote').innerHTML = label ? `<span class="pos">● calibrated</span> from <b>${esc(label)}</b> — live book C, band, pool and 7d realised logit-vol / jump rate.` : 'Stylised regime preset. Calibrate from any scanned market via “→ Calibrate lab”.';
}
function readForm() {
  const env = Object.assign({}, S.env);
  $$('[data-e]').forEach(i => env[i.dataset.e] = i.dataset.e === 'resetDaily' ? i.value === '1' : +i.value);
  delete env.__oq;
  const P = Object.assign({}, S.params);
  $$('[data-p]').forEach(i => P[i.dataset.p] = +i.value);
  S.params = P;
  return { env, P, days: Math.min(Math.max(+$('#days').value || 7, 1), 30), paths: Math.min(Math.max(+$('#paths').value || 12, 2), 60), seed: +$('#seed').value || 7 };
}
async function calibrateFrom(m) {
  let hist = S.sel === m ? S.hist : null;
  if (!hist) { try { hist = m.demo ? null : (await api(`/api/history?token_id=${m.tokens[0].id}&interval=1w&fidelity=60`)).history; } catch (e) { hist = null; } }
  const comp = S.sel === m && S.selComp ? S.selComp : { mid: m.mid, C: m.C };
  const base = Object.assign({ toxSlope: 0.7 }, Q.PRESETS[m.hoursToEnd != null && m.hoursToEnd < 30 ? 'sportsPre' : 'politics']);
  const env = Q.calibrate(base, { history: hist, comp, rate: m.rate, v: m.v, minSize: m.minSize, tick: m.tick });
  loadEnv(env, m.question);
  S.lab = null; // views.lab re-runs on an empty lab
  $('#tabs button[data-v=lab]').click();
}

let labBusy = false;
async function runLab() {
  if (labBusy) return; labBusy = true;
  $('#run').disabled = true; $('#sweepBtn').disabled = true;
  const { env, P, days, paths, seed } = readForm();
  const keys = Object.keys(Q.STRATS), stride = 30;
  const out = {}; keys.forEach(k => out[k] = { key: k, reward: [], trade: [], net: [], fills: [], uptime: [], share: [], dailyAll: [], eq: null, rw: null });
  for (let i = 0; i < paths; i++) {
    const path = Q.genPath(env, days, seed * 1000 + i);
    for (const k of keys) {
      const r = Q.simulate(env, path, k, P, { stride });
      const o = out[k];
      o.reward.push(r.reward); o.trade.push(r.tradingPnL); o.net.push(r.net); o.fills.push(r.fills); o.uptime.push(r.uptime); o.share.push(r.avgShare);
      for (const d of r.daily) o.dailyAll.push(d);
      if (!o.eq) { o.eq = new Float64Array(r.eq.length); o.rw = new Float64Array(r.rw.length); }
      for (let j = 0; j < r.eq.length; j++) { o.eq[j] += r.eq[j] / paths; o.rw[j] += r.rw[j] / paths; }
    }
    $('#prog').style.width = ((i + 1) / paths * 100) + '%';
    await sleep(0);
  }
  const capital = P.size + P.invCap * 0.5;
  for (const k of keys) {
    const o = out[k], dS = Q.stats(o.dailyAll), net = Q.stats(o.net);
    let peak = -Infinity, mdd = 0; for (const e of o.eq) { peak = Math.max(peak, e); mdd = Math.max(mdd, peak - e); }
    o.summary = { reward: Q.stats(o.reward).mean, trade: Q.stats(o.trade).mean, net: net.mean, perDay: net.mean / days,
      sharpe: dS.sd > 0 ? dS.mean / dS.sd * Math.sqrt(365) : 0, maxDD: mdd, fills: Q.stats(o.fills).mean, uptime: Q.stats(o.uptime).mean,
      share: Q.stats(o.share).mean, apr: net.mean / days * 365 / capital, winDays: o.dailyAll.filter(x => x > 0).length / Math.max(o.dailyAll.length, 1) };
  }
  S.lab = { out, days, paths, capital, stride, env, P };
  $('#labMeta').textContent = `${paths} paths × ${days}d · capital ≈ ${fmt.usd(capital)} · ${S.envLabel ? 'calibrated' : $('#preset').selectedOptions[0].text}`;
  renderLab();
  setTimeout(() => $('#prog').style.width = '0', 600);
  $('#run').disabled = false; $('#sweepBtn').disabled = false; labBusy = false;
}

function renderLab() {
  const L = S.lab; if (!L) return;
  const keys = Object.keys(L.out);
  $('#eqLegend').innerHTML = keys.map(k => `<span><i style="background:${Q.STRATS[k].color}"></i>${Q.STRATS[k].name.split(' · ')[0]}</span>`).join('');
  // equity race
  const cv = $('#cEq');
  let lo = 0, hi = 0; keys.forEach(k => L.out[k].eq.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
  const pad = (hi - lo) * .08 || 1; lo -= pad; hi += pad;
  const n = L.out[keys[0]].eq.length;
  const t0 = performance.now();
  const frame = now => {
    const k = Math.min((now - t0) / 2200, 1), m = Math.max(2, Math.floor(n * ease(k)));
    const { c, w, h } = ctx2d(cv);
    const x0 = 58, x1 = w - 70, y0 = 10, y1 = h - 22;
    axes(c, x0, y0, x1, y1, lo, hi, v => fmt.usd(v), 5);
    const X = i => x0 + i / (n - 1) * (x1 - x0), Y = v => y1 - (v - lo) / (hi - lo) * (y1 - y0);
    c.strokeStyle = 'rgba(230,237,247,.25)'; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x1, Y(0)); c.stroke(); c.setLineDash([]);
    c.fillStyle = COL.tx3; c.textAlign = 'center'; c.textBaseline = 'top';
    const perDay = 1440 / L.stride; for (let d = 0; d <= L.days; d++) c.fillText('d' + d, X(Math.min(d * perDay, n - 1)), y1 + 6);
    keys.forEach(kk => {
      const e = L.out[kk].eq, col = Q.STRATS[kk].color;
      c.beginPath(); for (let i = 0; i < m; i++) i ? c.lineTo(X(i), Y(e[i])) : c.moveTo(X(i), Y(e[i]));
      c.strokeStyle = col; c.lineWidth = kk === 'v4' ? 2.4 : 1.6; c.shadowColor = col; c.shadowBlur = kk === 'v4' ? 10 : 0; c.stroke(); c.shadowBlur = 0;
      const lx = X(m - 1), ly = Y(e[m - 1]);
      c.fillStyle = col; c.beginPath(); c.arc(lx, ly, 3.5, 0, 6.28); c.fill();
      c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(fmt.usd(e[m - 1]), lx + 7, ly);
    });
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // scorecard
  const best = keys.reduce((a, k) => L.out[k].summary.sharpe > L.out[a].summary.sharpe ? k : a, keys[0]);
  $('#resTbl tbody').innerHTML = keys.map((k, i) => { const s = L.out[k].summary; return `<tr style="animation-delay:${i * 80}ms">
    <td class="k"><span class="sw" style="background:${Q.STRATS[k].color}"></span>${esc(Q.STRATS[k].name)}${k === best ? ' <span class="pos mono" style="font-size:10px">★ best SR</span>' : ''}</td>
    <td class="${s.perDay >= 0 ? 'pos' : 'neg'}">${fmt.usd(s.perDay, 1)}</td><td>${fmt.usd(s.reward)}</td><td class="${s.trade >= 0 ? 'pos' : 'neg'}">${fmt.usd(s.trade)}</td>
    <td>${s.sharpe.toFixed(2)}</td><td class="neg">${fmt.usd(s.maxDD)}</td><td>${fmt.pct(s.winDays)}</td><td>${fmt.pct(s.uptime)}</td><td>${fmt.pct(s.share, 1)}</td><td class="${s.apr >= 0 ? 'pos' : 'neg'}">${fmt.pct(s.apr)}</td></tr>`; }).join('');
  // journal
  $('#journal').innerHTML = keys.map((k, i) => {
    const s = L.out[k].summary, st = Q.STRATS[k];
    let verdict = '<span class="verdict base">BASELINE</span>', delta = '';
    if (i > 0) {
      const p = L.out[keys[i - 1]].summary;
      const keep = s.sharpe > p.sharpe + 0.05 && s.perDay >= p.perDay - Math.max(Math.abs(p.perDay) * 0.35, 1);
      verdict = keep ? '<span class="verdict keep">KEEP</span>' : '<span class="verdict rev">REVERT</span>';
      const row = (l, a, f, good) => `<span>${l} <b class="${good ? 'pos' : 'neg'}">${fmt.sgn(a, f)}</b></span>`;
      delta = `<div class="delta">${row('Δ net/day', s.perDay - p.perDay, x => fmt.usd(x, 1), s.perDay >= p.perDay)}${row('Δ Sharpe', s.sharpe - p.sharpe, x => x.toFixed(2), s.sharpe >= p.sharpe)}
        ${row('Δ max DD', s.maxDD - p.maxDD, x => fmt.usd(x), s.maxDD <= p.maxDD)}${row('Δ uptime', s.uptime - p.uptime, x => fmt.pct(x), true)}</div>`;
    } else delta = `<div class="delta"><span>net/day <b class="${s.perDay >= 0 ? 'pos' : 'neg'}">${fmt.usd(s.perDay, 1)}</b></span><span>Sharpe <b>${s.sharpe.toFixed(2)}</b></span><span>rewards ${fmt.usd(s.reward)} vs trading ${fmt.usd(s.trade)}</span></div>`;
    return `<div class="jcard" style="animation-delay:${i * 120}ms;border-color:${st.color}33">${verdict}<h4><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${st.color}"></span>${esc(st.name)}</h4><p>${esc(st.thesis)}</p>${delta}</div>`;
  }).join('');
  drawDailyHist();
}

function drawDailyHist() {
  const L = S.lab; if (!L) return;
  const keys = Object.keys(L.out);
  const all = keys.flatMap(k => L.out[k].dailyAll);
  const sorted = [...all].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
  const B = 28, wdt = (hi - lo) / B || 1;
  const hists = keys.map(k => { const hh = new Array(B).fill(0); L.out[k].dailyAll.forEach(x => { const b = Math.floor((x - lo) / wdt); if (b >= 0 && b < B) hh[b]++; }); return hh.map(v => v / L.out[k].dailyAll.length); });
  const ymax = Math.max(...hists.flat()) * 1.1;
  const { c, w, h } = ctx2d($('#cHist'));
  const x0 = 40, x1 = w - 8, y0 = 10, y1 = h - 22;
  axes(c, x0, y0, x1, y1, 0, ymax, v => (v * 100).toFixed(0) + '%', 4);
  const X = v => x0 + (v - lo) / (hi - lo) * (x1 - x0), Y = v => y1 - v / ymax * (y1 - y0);
  if (lo < 0 && hi > 0) { c.strokeStyle = 'rgba(230,237,247,.3)'; c.beginPath(); c.moveTo(X(0), y0); c.lineTo(X(0), y1); c.stroke(); }
  hists.forEach((hh, i) => {
    const col = Q.STRATS[keys[i]].color;
    c.beginPath(); c.moveTo(X(lo), y1);
    hh.forEach((v, b) => { c.lineTo(X(lo + b * wdt), Y(v)); c.lineTo(X(lo + (b + 1) * wdt), Y(v)); });
    c.lineTo(X(hi), y1); c.strokeStyle = col; c.lineWidth = 1.5; c.stroke(); c.fillStyle = col + '18'; c.fill();
  });
  c.fillStyle = COL.tx3; c.textAlign = 'center'; c.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; c.fillText(fmt.usd(v), X(v), y1 + 6); }
}

const SWEEP_AX = {
  gamma: { key: 'gamma', label: 'γ', values: [0, 0.3, 0.6, 0.9, 1.2, 1.6, 2.0] },
  gate: { key: 'gate', label: 'gate', values: [1.6, 2, 2.6, 3.2, 4, 5, 6.5] },
  size: { key: 'size', label: 'size', values: [100, 250, 500, 1000, 2000, 4000] },
  cooldown: { key: 'cooldown', label: 'cool', values: [5, 10, 20, 40, 60, 90] },
};
async function runSweep() {
  if (labBusy) return; labBusy = true;
  $('#run').disabled = true; $('#sweepBtn').disabled = true;
  const { env, P, seed } = readForm();
  const [ky, kx] = $('#sweepAxes').value.split('|');
  const ax = SWEEP_AX[kx], ay = SWEEP_AX[ky];
  const days = 5, npaths = 6;
  const paths = []; for (let i = 0; i < npaths; i++) paths.push(Q.genPath(env, days, seed * 1000 + 500 + i));
  const heat = $('#heat');
  heat.style.gridTemplateColumns = `48px repeat(${ax.values.length}, 1fr)`;
  heat.innerHTML = `<div class="ax">${ay.label}\\${ax.label}</div>` + ax.values.map(v => `<div class="ax">${v}</div>`).join('');
  const cells = [];
  for (let yi = 0; yi < ay.values.length; yi++) {
    heat.insertAdjacentHTML('beforeend', `<div class="ax">${ay.values[yi]}</div>`);
    for (let xi = 0; xi < ax.values.length; xi++) {
      const PP = Object.assign({}, P, { [ax.key]: ax.values[xi], [ay.key]: ay.values[yi] });
      const dl = [], nets = [];
      for (const p of paths) { const r = Q.simulate(env, p, 'v4', PP, { stride: 1e9 }); nets.push(r.net); r.daily.forEach(d => dl.push(d)); }
      const s = Q.stats(dl);
      const cell = { x: ax.values[xi], y: ay.values[yi], sharpe: s.sd > 0 ? s.mean / s.sd * Math.sqrt(365) : 0, perDay: Q.stats(nets).mean / days };
      cells.push(cell);
      const el = document.createElement('div'); el.className = 'c'; el.dataset.i = cells.length - 1;
      el.textContent = cell.sharpe.toFixed(1); el.title = `${ay.key}=${cell.y} ${ax.key}=${cell.x}\nSharpe ${cell.sharpe.toFixed(2)} · ${fmt.usd(cell.perDay, 1)}/day`;
      heat.appendChild(el);
      $('#prog').style.width = (cells.length / (ax.values.length * ay.values.length) * 100) + '%';
      await sleep(0);
    }
  }
  const sh = cells.map(c => c.sharpe), mx = Math.max(...sh.map(Math.abs), 1e-6);
  const bestI = sh.indexOf(Math.max(...sh));
  $$('#heat .c').forEach(el => {
    const cl = cells[+el.dataset.i], t = cl.sharpe / mx;
    el.style.background = t >= 0 ? `rgba(61,255,168,${0.08 + 0.6 * t})` : `rgba(255,93,115,${0.08 + 0.6 * -t})`;
    el.style.color = Math.abs(t) > .55 ? '#05070d' : '#e6edf7';
    if (+el.dataset.i === bestI) el.classList.add('best');
    el.onclick = () => {
      S.params[ax.key] = cl.x; S.params[ay.key] = cl.y;
      $$('[data-p]').forEach(i => { if (i.dataset.p in S.params) i.value = S.params[i.dataset.p]; });
      labBusy = false; runLab();
    };
  });
  setTimeout(() => $('#prog').style.width = '0', 600);
  $('#run').disabled = false; $('#sweepBtn').disabled = false; labBusy = false;
}
$('#run').onclick = runLab;
$('#sweepBtn').onclick = runSweep;
views.lab = () => { if (!S.lab) runLab(); else renderLab(); };

/* ---------- allocator ---------- */
function allocate() {
  const K = +$('#cap').value || 0, N = +$('#topN').value || 20, a = (+$('#adv').value || 0) / 1e4, d = +$('#adist').value || 1;
  const pool = S.markets.filter(m => m.C != null && m.rate > 0 && m.mid >= 0.1 && m.mid <= 0.9).slice(0, N);
  if (!pool.length) { $('#allocList').innerHTML = '<div class="empty">No eligible markets yet — run the scanner first.</div>'; return; }
  const res = Q.allocate(pool.map(m => ({ id: m.id, rate: m.rate, C: m.C, v: m.v, minSize: m.minSize, advPerDollar: a })), K, d);
  S.alloc = { res, pool, d, K };
  const rows = res.alloc.map((r, i) => ({ ...r, m: pool[i] })).sort((x, y) => y.x - x.x);
  const mx = Math.max(...rows.map(r => r.x), 1);
  $('#allocList').innerHTML = `<div class="abar dim mono" style="font-size:10.5px;letter-spacing:.08em"><span>MARKET</span><span>CAPITAL</span><span class="m">$/DAY</span><span class="m">SHARE</span></div>` +
    rows.map(r => `<div class="abar"><span class="t" title="${esc(r.m.question)}">${esc(r.m.question)}</span><span class="b"><i style="width:0" data-w="${(r.x / mx * 100).toFixed(1)}"></i></span>
      <span class="m ${r.net > 0 ? 'pos' : 'dimmer'}">${r.x > 0 ? fmt.usd(r.net, 2) : '—'}</span><span class="m">${r.x > 0 ? fmt.usd(r.x) : '<span class="dimmer">skip</span>'}</span></div>`).join('');
  requestAnimationFrame(() => $$('#allocList .b i').forEach((el, i) => setTimeout(() => el.style.width = el.dataset.w + '%', i * 40)));
  const funded = rows.filter(r => r.x > 0).length;
  $('#allocStats').innerHTML = `<div class="stat"><label>deployed</label><div>${fmt.usd(res.used)}</div></div><div class="stat"><label>markets funded</label><div>${funded} / ${pool.length}</div></div>
    <div class="stat"><label>exp. net $/day</label><div class="pos">${fmt.usd(res.daily, 2)}</div></div><div class="stat"><label>exp. APR</label><div class="pos">${fmt.pct(res.apr)}</div></div>`;
  $('#allocMeta').textContent = `λ* = ${res.lambda.toExponential(2)} $/day per $ · quoting ${d}¢ · ${S.demo ? 'demo data' : 'live books'}`;
  renderConfig();
}
$('#allocBtn').onclick = allocate;
views.alloc = () => { if (!S.alloc) allocate(); };

function botConfig() {
  const P = S.params;
  const al = S.alloc ? S.alloc.res.alloc.map((r, i) => ({ r, m: S.alloc.pool[i] })).filter(x => x.r.x > 0) : [];
  return {
    generated_at: new Date().toISOString(), strategy: 'v4_regime_gated_skew', dry_run: true,
    params: { gamma: P.gamma, vol_gate: P.gate, cooldown_min: P.cooldown, inv_cap_shares: P.invCap, max_size_shares: P.size, requote_sec: 15, ewma_fast_min: 5, ewma_slow_min: 240 },
    model: (() => { const e = (S.lab && S.lab.env) || S.env || {}; return { jumps_per_day: e.jumpsPerDay ?? 1, jump_logit: e.jumpL ?? 0.2, taker_per_min: e.noise ?? 0.6, kappa: e.kappa ?? 0.8, markout_c: e.markout ?? 0.6, tox_slope: e.toxSlope ?? 0.7 }; })(),
    risk: { daily_loss_limit_usd: Math.round((S.alloc ? S.alloc.res.daily : 50) * 3), max_gross_usd: S.alloc ? Math.round(S.alloc.K) : 10000, cancel_all_on_exit: true },
    markets: al.map(({ r, m }) => ({ condition_id: m.conditionId, question: m.question, yes_token: m.tokens[0].id, no_token: m.tokens[1].id,
      capital_usd: Math.round(r.x), size_shares: Math.max(m.minSize, Math.round(r.x)), max_spread_c: m.v, min_size: m.minSize, tick: m.tick || 0.01, pool_per_day: m.rate })),
  };
}
function renderConfig() { $('#cfgCode').textContent = JSON.stringify(botConfig(), null, 2); }
$('#dlCfg').onclick = () => {
  const b = new Blob([JSON.stringify(botConfig(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'desk_config.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ---------- execution ---------- */
function pipeline() {
  const nodes = [['CLOB book', 'REST · WS', 40], ['Scanner', 'C, APR, edge', 190], ['Allocator', 'water-fill λ*', 340], ['Quote engine', 'v4 · d*, x*, skew', 490], ['Risk gate', 'jump · caps · PnL', 640], ['Order router', 'post / cancel', 790]];
  const W = 900, H = 230;
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="JetBrains Mono, monospace">
  <defs><linearGradient id="gl" x1="0" x2="1"><stop offset="0" stop-color="#5ad1ff"/><stop offset="1" stop-color="#3dffa8"/></linearGradient>
  <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#3dffa8"/></marker></defs>`;
  for (let i = 0; i < nodes.length - 1; i++) {
    const x = nodes[i][2] + 104, x2 = nodes[i + 1][2];
    s += `<path id="p${i}" d="M${x},70 L${x2 - 2},70" stroke="url(#gl)" stroke-width="1.5" fill="none" marker-end="url(#ar)" opacity=".7"/>
      <circle r="3.5" fill="#3dffa8"><animateMotion dur="${1.4 + i * .15}s" repeatCount="indefinite" begin="${i * .25}s"><mpath href="#p${i}"/></animateMotion></circle>`;
  }
  s += `<path id="fb" d="M842,98 C842,190 842,190 560,190 L120,190 C92,190 92,190 92,100" stroke="#b28cff" stroke-width="1.3" stroke-dasharray="5 5" fill="none" opacity=".75" marker-end="url(#ar)">
      <animate attributeName="stroke-dashoffset" from="0" to="-40" dur="2s" repeatCount="indefinite"/></path>
    <circle r="3.5" fill="#b28cff"><animateMotion dur="5s" repeatCount="indefinite"><mpath href="#fb"/></animateMotion></circle>
    <rect x="356" y="174" width="190" height="32" rx="8" fill="#0a0f1a" stroke="#b28cff" stroke-opacity=".5"/>
    <text x="451" y="194" fill="#b28cff" font-size="11" text-anchor="middle">fills · /rewards/user/total → recalibrate</text>`;
  nodes.forEach(([t, sub, x], i) => {
    s += `<g><rect x="${x}" y="42" width="104" height="56" rx="10" fill="#0a0f1a" stroke="${i === 3 ? '#3dffa8' : 'rgba(120,150,200,.35)'}" stroke-width="${i === 3 ? 1.6 : 1}">
      ${i === 3 ? '<animate attributeName="stroke-opacity" values="1;.35;1" dur="2.2s" repeatCount="indefinite"/>' : ''}</rect>
      <text x="${x + 52}" y="66" fill="#e6edf7" font-size="12" text-anchor="middle">${t}</text><text x="${x + 52}" y="84" fill="#5e6a80" font-size="9.5" text-anchor="middle">${sub}</text></g>`;
  });
  s += `<text x="40" y="24" fill="#5e6a80" font-size="10" letter-spacing="2">LOOP · every 15s requote · every 1m reward sample · every 24h epoch payout + recalibration</text></svg>`;
  $('#pipe').innerHTML = s;
}
views.exec = async () => {
  pipeline(); renderConfig();
  if ($('#botCode').dataset.ok) return;
  try { const t = await (await fetch('/bot/mm_bot.py')).text(); $('#botCode').textContent = t; $('#botCode').dataset.ok = 1; }
  catch (e) { $('#botCode').textContent = 'Download mm_bot.py from the button above.'; }
};

/* ---------- boot ---------- */
buildLabForm();
scoring();
scan();
addEventListener('resize', () => { clearTimeout(window.__rs); window.__rs = setTimeout(() => { scoring(); if (S.sel && S.book) { drawBook(S.sel); drawHist(S.sel); } if (S.lab) renderLab(); }, 200); });
const h = location.hash.slice(1); if (h && $(`#tabs button[data-v="${h}"]`)) $(`#tabs button[data-v="${h}"]`).click();
setInterval(() => { if ($('#v-score').classList.contains('on')) scoring(); }, 120);
setInterval(() => { if (!document.hidden) scan(); }, 90000);
})();
