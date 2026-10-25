/* PM Liquidity Desk — quant engine
 * Reward scoring (Polymarket liquidity-rewards methodology), competition
 * estimation, Monte Carlo market-making simulator with common random numbers,
 * strategies v1..v4, parameter sweep, and a water-filling capital allocator.
 * Works in browser (window.PMQ) and Node (module.exports).
 */
(function (root) {
  'use strict';

  const C_SCALE = 3.0;          // single-sided scaling factor c (docs: 3.0 on all markets)
  const SAMPLES_PER_DAY = 1440; // one sample per minute, epoch = 1 UTC day

  // ---------- RNG (mulberry32) + normals ----------
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const phi = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  function Phi(x) { // Abramowitz-Stegun
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const logit = p => Math.log(p / (1 - p));
  const sigm = l => 1 / (1 + Math.exp(-l));

  // ---------- Scoring ----------
  /** S(v,s) = ((v-s)/v)^2 * b ; v,s in cents. Zero outside the band. */
  function S(v, s, b = 1) {
    if (s < 0) s = 0;
    if (s >= v) return 0;
    const x = (v - s) / v;
    return x * x * b;
  }
  /** Combine side scores per docs eq.4 */
  function qmin(qOne, qTwo, mid) {
    const two = Math.min(qOne, qTwo);
    if (mid >= 0.10 && mid <= 0.90) return Math.max(two, Math.max(qOne / C_SCALE, qTwo / C_SCALE));
    return two;
  }

  /** Normalise a CLOB book {bids:[{price,size}],asks:[...]} into sorted numeric arrays. */
  function normBook(book) {
    const f = l => ({ p: +l.price, s: +l.size });
    const bids = (book && book.bids || []).map(f).filter(l => l.s > 0).sort((a, b) => b.p - a.p);
    const asks = (book && book.asks || []).map(f).filter(l => l.s > 0).sort((a, b) => a.p - b.p);
    return { bids, asks };
  }

  /** Size-cutoff-adjusted midpoint: ignore levels smaller than minSize. */
  function adjustedMid(book, minSize) {
    const bb = book.bids.find(l => l.s >= minSize) || book.bids[0];
    const ba = book.asks.find(l => l.s >= minSize) || book.asks[0];
    if (!bb && !ba) return null;
    if (!bb) return ba.p; if (!ba) return bb.p;
    return (bb.p + ba.p) / 2;
  }

  /**
   * Estimate aggregate competing score inside the reward band from a YES book.
   * On Polymarket the NO book mirrors YES, so YES bids ≈ Q_one side, YES asks ≈ Q_two side.
   * Aggregate maker Qmin ≈ min(Qb,Qa) + |Qb-Qa|/c (excess one-sided depth scores at 1/c).
   */
  function competition(bookRaw, vCents, minSize) {
    const book = bookRaw.bids && bookRaw.bids[0] && bookRaw.bids[0].p !== undefined ? bookRaw : normBook(bookRaw);
    const mid = adjustedMid(book, minSize);
    if (mid == null) return null;
    let qb = 0, qa = 0, depthB = 0, depthA = 0;
    const levels = [];
    for (const l of book.bids) {
      const s = (mid - l.p) * 100;
      if (s >= vCents) break;
      const sc = l.s >= minSize ? S(vCents, s) * l.s : 0;
      qb += sc; depthB += l.s; levels.push({ side: 'bid', p: l.p, s: l.s, d: s, score: sc });
    }
    for (const l of book.asks) {
      const s = (l.p - mid) * 100;
      if (s >= vCents) break;
      const sc = l.s >= minSize ? S(vCents, s) * l.s : 0;
      qa += sc; depthA += l.s; levels.push({ side: 'ask', p: l.p, s: l.s, d: s, score: sc });
    }
    const inner = mid >= 0.1 && mid <= 0.9;
    const C = inner ? Math.min(qb, qa) + Math.abs(qb - qa) / C_SCALE : Math.min(qb, qa);
    const bestBid = book.bids[0] ? book.bids[0].p : null, bestAsk = book.asks[0] ? book.asks[0].p : null;
    return { mid, qb, qa, C, depthB, depthA, levels, bestBid, bestAsk,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null };
  }

  /** Expected daily reward + APR for a symmetric quote of x shares/side at d cents. */
  function rewardEstimate({ rate, v, C, x, d }) {
    const myQ = S(v, d) * x;
    const share = myQ > 0 ? myQ / (myQ + Math.max(C, 0)) : 0;
    const daily = rate * share;
    const capital = x; // YES bid (p·x) + NO bid ((1-p)·x) ≈ x USDC
    return { myQ, share, daily, capital, apr: capital > 0 ? daily * 365 / capital : 0 };
  }

  /** Expected shortfall of a Gaussian move beyond d: E[(X-d)+], X~N(0,σ). */
  function excess(sigma, d) {
    if (sigma <= 0) return 0;
    const z = d / sigma;
    return sigma * phi(z) - d * (1 - Phi(z));
  }

  // ---------- Market regime presets ----------
  const PRESETS = {
    // noise: taker arrivals/min hitting the touch; kappa: decay per cent of distance;
    // markout: expected adverse move (cents) after a passive fill (flow toxicity)
    politics: { label: 'Politics · long-dated', p0: 0.42, volL: 0.10, jumpsPerDay: 0.15, jumpL: 0.35, rate: 150, C: 2500, v: 3.5, minSize: 50, tick: 0.01, noise: 0.4, kappa: 0.8, markout: 0.3 },
    sportsPre: { label: 'Sports · pre-game', p0: 0.55, volL: 0.30, jumpsPerDay: 1.5, jumpL: 0.12, rate: 300, C: 4000, v: 3, minSize: 100, tick: 0.01, noise: 0.6, kappa: 0.8, markout: 0.6, resetDaily: true },
    sportsLive: { label: 'Sports · in-play', p0: 0.50, volL: 0.90, jumpsPerDay: 5, jumpL: 0.35, rate: 800, C: 2500, v: 3, minSize: 100, tick: 0.01, noise: 1.5, kappa: 0.6, markout: 1.5, resetDaily: true },
    crypto: { label: 'Crypto · daily strike', p0: 0.50, volL: 0.35, jumpsPerDay: 1, jumpL: 0.2, rate: 250, C: 2000, v: 3.5, minSize: 50, tick: 0.01, noise: 1.0, kappa: 0.6, markout: 0.9, resetDaily: true },
  };

  // ---------- Path generation (common random numbers) ----------
  function genPath(env, days, seed) {
    const N = days * SAMPLES_PER_DAY;
    const r = rng(seed);
    const p = new Float64Array(N + 1);
    const comp = new Float64Array(N + 1);
    const uB = new Float64Array(N + 1), uA = new Float64Array(N + 1), uF = new Float64Array(N + 1);
    const jump = new Uint8Array(N + 1);
    const dt = 1 / SAMPLES_PER_DAY;
    const sd = env.volL * Math.sqrt(dt);
    const pj = env.jumpsPerDay * dt;
    let L = logit(clamp(env.p0, 0.02, 0.98));
    let cLog = 0, pull = 0;
    p[0] = sigm(L); comp[0] = env.C;
    // Itô correction so that p = sigmoid(L) is a martingale (prices of binary claims must be):
    // drift_L = -½(1-2p)·(σ² + λ_J·E[J²]) ; otherwise the sim manufactures fake mean-reversion alpha.
    const jv = env.jumpL * 1.6;
    const varRate = env.volL * env.volL + env.jumpsPerDay * jv * jv;
    // Self-exciting regime: each jump raises an excitation e that boosts jump intensity (×(1+5e))
    // and diffusive vol (×(1+2e)), decaying with ~20 min half-life — news/goal cascades cluster.
    let e = 0;
    const decay = Math.exp(-Math.LN2 / 20);
    for (let t = 1; t <= N; t++) {
      const pc = sigm(L);
      const vm = 1 + 2 * e;
      L += -0.5 * (1 - 2 * pc) * varRate * vm * vm * dt + sd * vm * gauss(r);
      if (r() < pj * (1 + 5 * e)) { L += jv * gauss(r); jump[t] = 1; e += 1; pull = 25 + Math.floor(r() * 30); }
      e *= decay;
      L = clamp(L, -6.9, 6.9); // numerical guard only (~[0.001, 0.999])
      p[t] = sigm(L);
      if (env.resetDaily && t % SAMPLES_PER_DAY === 0) L = logit(clamp(env.p0, 0.02, 0.98)); // next game / next contract
      cLog = 0.995 * cLog + 0.07 * gauss(r);           // AR(1) competitor liquidity
      const pulled = pull > 0 ? 0.25 : 1; if (pull > 0) pull--; // competitors pull after shocks
      comp[t] = env.C * Math.exp(cLog) * pulled;
      uB[t] = r(); uA[t] = r(); uF[t] = r();
    }
    return { N, p, comp, uB, uA, uF, jump };
  }

  // ---------- Strategies ----------
  const tickDown = (x, tk) => Math.floor(x / tk + 1e-9) * tk;
  const tickUp = (x, tk) => Math.ceil(x / tk - 1e-9) * tk;

  /**
   * Joint (d, x) optimiser. Per-minute value:
   *   R/1440 · S(d)x/(S(d)x + C)                      reward share (concave in x, quadratic in d)
   * − 2·x·[E(ΔP−d)⁺ + λ_J·E(J−d)⁺]/100              informed crossing cost (Gaussian + jump)
   * − 2·flow(d,x)·(markout + toxSlope·d − d)/100      taker markout net of spread captured
   * Returns null when no (d, x) has positive edge → stand down.
   * Memoised on (C, σ, mid) buckets so sweeps stay fast.
   */
  function optimalQuote(env, P, C, sigC, mid) {
    const key = Math.round(Math.log(Math.max(C, 1)) * 20) + '|' + Math.round(sigC * 50) + '|' + Math.round(mid * 20);
    const cache = env.__oq || (env.__oq = new Map());
    const ck = P.size + '|' + key;
    if (cache.has(ck)) return cache.get(ck);
    const jumpPerMin = env.jumpsPerDay / SAMPLES_PER_DAY;
    const cPerLogit = 100 * mid * (1 - mid);
    const jumpC = env.jumpL * 1.6 * cPerLogit;
    const sig = sigC * 1.4;
    const sizes = [];
    for (let x = Math.max(env.minSize, 10); x <= P.size * 1.0001; x *= 1.6) sizes.push(x);
    if (!sizes.length || sizes[sizes.length - 1] < P.size) sizes.push(P.size);
    let best = null, bestV = 0;
    for (let d = 0.5; d < env.v; d += 0.25) {
      const sd = S(env.v, d);
      const crossPerShare = (excess(sig, d) + jumpPerMin * excess(jumpC, d)) / 100;
      const flowPerShare = (env.noise || 0) * Math.exp(-(env.kappa || 1) * d) * 0.35 * ((env.markout || 0) + (env.toxSlope ?? 0.7) * d - d) / 100;
      for (const x of sizes) {
        const rew = env.rate / SAMPLES_PER_DAY * (sd * x / (sd * x + C));
        const qs = x / (x + C / 0.35);
        const val = rew - 2 * x * crossPerShare - 2 * qs * x * flowPerShare;
        if (val > bestV) { bestV = val; best = { d, x, edge: val }; }
      }
    }
    if (cache.size > 20000) cache.clear();
    cache.set(ck, best);
    return best;
  }

  const STRATS = {
    v1: { name: 'v1 · Naive Mid-Hugger', color: '#7c8aa5',
      thesis: 'Quote both sides one tick off mid at max size, 24/7. Maximises raw quadratic score; prices no risk.',
      init: () => ({}),
      quote(st, o, env, P) {
        const x = P.size;
        return { bid: tickDown(o.mid - 0.01, env.tick), ask: tickUp(o.mid + 0.01, env.tick), bs: x, as: x };
      } },
    v2: { name: 'v2 · Edge Optimizer', color: '#5ad1ff',
      thesis: 'Jointly pick distance d and size x maximising reward share − crossing cost − flow markout; stand down when edge ≤ 0. Uses concavity: past x*, extra size buys little share.',
      init: () => ({}),
      quote(st, o, env, P) {
        const b = optimalQuote(env, P, o.compObs, o.sigC, o.mid);
        if (!b) return null;
        const q = { bid: tickDown(o.mid - b.d / 100, env.tick), ask: tickUp(o.mid + b.d / 100, env.tick), bs: b.x, as: b.x };
        if (o.inv >= P.invCap) q.bs = 0;
        if (o.inv <= -P.invCap) q.as = 0;
        return q;
      } },
    v3: { name: 'v3 · Inventory-Skewed (A-S)', color: '#b28cff',
      thesis: 'v2 + Avellaneda-Stoikov reservation price: shift the quote centre against inventory and taper size on the loaded side.',
      init: () => ({}),
      quote(st, o, env, P) {
        const b = optimalQuote(env, P, o.compObs, o.sigC, o.mid);
        if (!b && Math.abs(o.inv) < env.minSize) return null;
        const x = b ? b.x : Math.max(env.minSize, P.size * 0.25);
        const d = b ? b.d : env.v * 0.6; // with inventory but no edge: work it out passively
        const z = clamp(o.inv / P.invCap, -1, 1);
        const centre = o.mid - P.gamma * z * (env.v / 2) / 100;
        let bs = x * clamp(1 - Math.max(z, 0), 0, 1), as = x * clamp(1 + Math.min(z, 0), 0, 1);
        if (bs < env.minSize) bs = z > 0.95 ? 0 : env.minSize;
        if (as < env.minSize) as = z < -0.95 ? 0 : env.minSize;
        if (!b) { if (z > 0) bs = 0; else as = 0; } // unwind-only mode
        return { bid: tickDown(centre - d / 100, env.tick), ask: tickUp(centre + d / 100, env.tick), bs, as };
      } },
    v4: { name: 'v4 · Regime-Gated Skew', color: '#3dffa8',
      thesis: 'v3 + volatility regime gate: pull quotes when short-vol ≫ long-vol or a jump prints, cool down, re-enter when competitors are thin.',
      init: () => ({ cool: 0 }),
      quote(st, o, env, P) {
        if (o.shock || o.sigFast > P.gate * Math.max(o.sigSlow, 0.02)) st.cool = P.cooldown;
        if (st.cool > 0) {
          st.cool--;
          // early re-entry if fast vol has normalised and the book has emptied (reward share is cheap)
          if (!(o.sigFast < 1.2 * o.sigSlow && o.compObs < 0.5 * env.C)) return null;
          st.cool = 0;
        }
        const q = STRATS.v3.quote(st, o, env, P);
        if (!q) return null;
        // outside [0.10,0.90] one-sided quotes score zero → don't carry risk for nothing unless unwinding
        if ((o.mid < 0.1 || o.mid > 0.9) && (q.bs === 0 || q.as === 0) && Math.abs(o.inv) < env.minSize) return null;
        return q;
      } },
  };
  const DEFAULT_PARAMS = { size: 1000, invCap: 3000, gamma: 0.9, gate: 2.6, cooldown: 20 };

  // ---------- Simulator ----------
  /**
   * Simulate one strategy on one path. Minute steps.
   * Fills: (a) informed — next mid trades through our level → full fill at our price;
   *        (b) noise — Poisson flow hits our level w.p. noise·e^{-κ·d}, fills 35% of size, mid unchanged.
   * Rewards: per-minute sample share × rate/1440.
   */
  function simulate(env, path, stratKey, P, opts = {}) {
    const strat = STRATS[stratKey];
    const st = strat.init();
    const N = path.N;
    let cash = 0, inv = 0, reward = 0, spreadPnL = 0, fills = 0, quotedMin = 0, shareSum = 0;
    let sigFast = 0.15, sigSlow = 0.15; // EWMA |Δp| per minute in cents
    const aF = 1 - Math.exp(-Math.LN2 / 5), aS = 1 - Math.exp(-Math.LN2 / 240);
    const stride = opts.stride || 30;
    const eq = new Float32Array(Math.floor(N / stride) + 1);
    const rw = new Float32Array(Math.floor(N / stride) + 1);
    const daily = new Float64Array(Math.ceil(N / SAMPLES_PER_DAY));
    let prevEq = 0;
    for (let t = 0; t < N; t++) {
      const mid = path.p[t];
      const afterRoll = env.resetDaily && t > 1 && (t - 1) % SAMPLES_PER_DAY === 0;
      if (t > 0 && !afterRoll) {
        const dpc = Math.abs(path.p[t] - path.p[t - 1]) * 100;
        sigFast += aF * (dpc - sigFast); sigSlow += aS * (dpc - sigSlow);
      }
      const o = { mid, inv, compObs: path.comp[t], sigC: sigSlow * 1.25, sigFast, sigSlow,
        shock: t > 0 && !afterRoll && Math.abs(path.p[t] - path.p[t - 1]) * 100 > 4 * Math.max(sigSlow, 0.05) };
      const roll = env.resetDaily && t > 0 && t % SAMPLES_PER_DAY === 0; // contract switch minute: no quoting
      const q = roll ? null : strat.quote(st, o, env, P);
      const pn = path.p[t + 1];
      if (q) {
        let bid = clamp(q.bid, env.tick, 1 - env.tick), ask = clamp(q.ask, env.tick, 1 - env.tick);
        if (bid >= mid) bid = tickDown(mid - env.tick / 2, env.tick);
        if (ask <= mid) ask = tickUp(mid + env.tick / 2, env.tick);
        const dB = (mid - bid) * 100, dA = (ask - mid) * 100;
        const bs = q.bs >= env.minSize ? q.bs : 0, as = q.as >= env.minSize ? q.as : 0;
        // reward sample (YES bid -> Q_one, YES ask -> Q_two)
        const qOne = S(env.v, dB) * bs, qTwo = S(env.v, dA) * as;
        const my = qmin(qOne, qTwo, mid);
        if (my > 0) {
          const sh = my / (my + path.comp[t]);
          reward += env.rate / SAMPLES_PER_DAY * sh; shareSum += sh;
        }
        if (bs > 0 && as > 0) quotedMin++;
        // (a) informed: mid trades through our level → full fill, marked at the new mid
        // (b) taker flow at our level, pro-rata with competing depth, pays spread but carries markout
        // deeper fills are more toxic: effective markout = m + toxSlope·d
        const depth = path.comp[t] / 0.35;
        const hard = P.hardCap || P.invCap * 2; // capital exhaustion applies to every strategy
        const canBuy = inv + bs <= hard, canSell = inv - as >= -hard;
        if (bs > 0 && canBuy && pn <= bid) { cash -= bid * bs; inv += bs; fills++; }
        else if (bs > 0 && canBuy && path.uB[t] < env.noise * Math.exp(-env.kappa * dB) * (bs / (bs + depth))) {
          const mo = ((env.markout || 0) + (env.toxSlope ?? 0.7) * dB) / 100;
          const f = bs * 0.35; cash -= bid * f + f * mo; inv += f; fills++; spreadPnL += f * (mid - bid - mo);
        }
        if (as > 0 && canSell && pn >= ask) { cash += ask * as; inv -= as; fills++; }
        else if (as > 0 && canSell && path.uA[t] < env.noise * Math.exp(-env.kappa * dA) * (as / (as + depth))) {
          const mo = ((env.markout || 0) + (env.toxSlope ?? 0.7) * dA) / 100;
          const f = as * 0.35; cash += ask * f - f * mo; inv -= f; fills++; spreadPnL += f * (ask - mid - mo);
        }
      }
      if (env.resetDaily && (t + 1) % SAMPLES_PER_DAY === 0) { cash += inv * pn; inv = 0; } // flatten at contract roll
      const equity = cash + inv * pn + reward;
      if ((t + 1) % stride === 0) { const k = (t + 1) / stride; eq[k] = equity; rw[k] = reward; }
      if ((t + 1) % SAMPLES_PER_DAY === 0) { const dd = (t + 1) / SAMPLES_PER_DAY - 1; daily[dd] = equity - prevEq; prevEq = equity; }
    }
    const tradingPnL = cash + inv * path.p[N];
    return { reward, tradingPnL, net: reward + tradingPnL, spreadPnL, fills, inv,
      uptime: quotedMin / N, avgShare: shareSum / N, eq, rw, daily };
  }

  function stats(arr) {
    const n = arr.length; if (!n) return { mean: 0, sd: 0 };
    let m = 0; for (const x of arr) m += x; m /= n;
    let v = 0; for (const x of arr) v += (x - m) * (x - m);
    return { mean: m, sd: Math.sqrt(v / Math.max(n - 1, 1)) };
  }

  /** Run all strategies over `paths` CRN paths. Returns aggregates + mean equity curves. */
  function runLab(env, { days = 7, paths = 12, seed = 7, params = DEFAULT_PARAMS, keys = Object.keys(STRATS), stride = 30 } = {}) {
    const out = {};
    for (const k of keys) out[k] = { key: k, reward: [], trade: [], net: [], fills: [], uptime: [], share: [], dailyAll: [], eq: null, rw: null, maxInv: [] };
    for (let i = 0; i < paths; i++) {
      const path = genPath(env, days, seed * 1000 + i);
      for (const k of keys) {
        const r = simulate(env, path, k, params, { stride });
        const o = out[k];
        o.reward.push(r.reward); o.trade.push(r.tradingPnL); o.net.push(r.net);
        o.fills.push(r.fills); o.uptime.push(r.uptime); o.share.push(r.avgShare);
        for (const d of r.daily) o.dailyAll.push(d);
        if (!o.eq) { o.eq = new Float64Array(r.eq.length); o.rw = new Float64Array(r.rw.length); }
        for (let j = 0; j < r.eq.length; j++) { o.eq[j] += r.eq[j] / paths; o.rw[j] += r.rw[j] / paths; }
      }
    }
    const capital = params.size + params.invCap * 0.5;
    for (const k of keys) {
      const o = out[k];
      const dS = stats(o.dailyAll);
      let peak = -Infinity, mdd = 0;
      for (const e of o.eq) { peak = Math.max(peak, e); mdd = Math.max(mdd, peak - e); }
      const net = stats(o.net);
      o.summary = {
        reward: stats(o.reward).mean, trade: stats(o.trade).mean, net: net.mean, netSd: net.sd,
        perDay: net.mean / days, sharpe: dS.sd > 0 ? dS.mean / dS.sd * Math.sqrt(365) : 0,
        maxDD: mdd, fills: stats(o.fills).mean, uptime: stats(o.uptime).mean, share: stats(o.share).mean,
        apr: net.mean / days * 365 / capital, winDays: o.dailyAll.filter(x => x > 0).length / o.dailyAll.length,
      };
    }
    return { out, days, paths, capital, stride };
  }

  /** 2-D parameter sweep for one strategy: returns grid of metric values. */
  function sweep(env, stratKey, axX, axY, { days = 5, paths = 6, seed = 11, base = DEFAULT_PARAMS, metric = 'sharpe' } = {}) {
    const pathsArr = []; for (let i = 0; i < paths; i++) pathsArr.push(genPath(env, days, seed * 1000 + i));
    const grid = [];
    for (const yv of axY.values) {
      const row = [];
      for (const xv of axX.values) {
        const P = Object.assign({}, base, { [axX.key]: xv, [axY.key]: yv });
        const nets = [], dl = [];
        for (const pth of pathsArr) { const r = simulate(env, pth, stratKey, P, { stride: 1e9 }); nets.push(r.net); for (const d of r.daily) dl.push(d); }
        const s = stats(dl);
        row.push({ x: xv, y: yv, sharpe: s.sd > 0 ? s.mean / s.sd * Math.sqrt(365) : 0, perDay: stats(nets).mean / days });
      }
      grid.push(row);
    }
    return grid;
  }

  // ---------- Water-filling allocator ----------
  /**
   * markets: [{id, rate, C, v, minSize, advPerDollar}] ; quoting at d=1c.
   * maximise Σ R_i·y_i/(y_i+C_i) − a_i·x_i  s.t. Σx_i ≤ K, x_i ∈ {0} ∪ [min_i, ∞), y_i = s_i x_i.
   * KKT: s_i R_i C_i /(s_i x_i + C_i)^2 = λ + a_i  →  x_i = (sqrt(s_i R_i C_i/(λ+a_i)) − C_i)/s_i
   */
  function allocate(markets, K, d = 1) {
    const ms = markets.map(m => Object.assign({}, m, { s: S(m.v, d) }));
    const xFor = (m, lam) => {
      const C = Math.max(m.C, 1);
      const x = (Math.sqrt(m.s * m.rate * C / (lam + (m.advPerDollar || 0))) - C) / m.s;
      return x < m.minSize ? 0 : x;
    };
    let lo = 1e-9, hi = 10;
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      const tot = ms.reduce((a, m) => a + xFor(m, mid), 0);
      if (tot > K) lo = mid; else hi = mid;
    }
    const lam = hi;
    let used = 0, daily = 0;
    const alloc = ms.map(m => {
      const x = xFor(m, lam);
      const y = m.s * x;
      const rew = x > 0 ? m.rate * y / (y + Math.max(m.C, 1)) : 0;
      const cost = (m.advPerDollar || 0) * x;
      used += x; daily += rew - cost;
      return { id: m.id, x, reward: rew, cost, net: rew - cost, share: x > 0 ? y / (y + Math.max(m.C, 1)) : 0 };
    });
    return { alloc, used, daily, lambda: lam, apr: used > 0 ? daily * 365 / used : 0 };
  }

  /** Calibrate env from live data: hourly price history + book competition. */
  function calibrate(base, { history, comp, rate, v, minSize, tick }) {
    const env = Object.assign({}, base);
    if (comp) { env.p0 = clamp(comp.mid, 0.03, 0.97); env.C = Math.max(comp.C, 10); }
    if (rate) env.rate = rate; if (v) env.v = v; if (minSize) env.minSize = minSize; if (tick) env.tick = tick;
    if (history && history.length > 24) {
      const L = history.map(h => logit(clamp(+h.p, 0.01, 0.99)));
      const dts = [];
      for (let i = 1; i < history.length; i++) dts.push(Math.max((history[i].t - history[i - 1].t) / 86400, 1 / 1440));
      const ret = []; for (let i = 1; i < L.length; i++) ret.push((L[i] - L[i - 1]) / Math.sqrt(dts[i - 1]));
      const sorted = ret.map(Math.abs).sort((a, b) => a - b);
      const mad = sorted[Math.floor(sorted.length / 2)] / 0.6745; // robust daily logit vol
      const thr = Math.max(4 * mad, 0.6); // floor: 1¢ tick moves on flat books are not jumps
      const jumps = ret.filter(r => Math.abs(r) > thr);
      const spanDays = (history[history.length - 1].t - history[0].t) / 86400;
      env.volL = clamp(mad, 0.02, 3);
      env.jumpsPerDay = clamp(jumps.length / Math.max(spanDays, 1), 0.02, 40);
      if (jumps.length) env.jumpL = clamp(stats(jumps.map(r => Math.abs(r) * Math.sqrt(dts[0]))).mean, 0.05, 1.5);
    }
    return env;
  }

  const api = { S, qmin, normBook, adjustedMid, competition, rewardEstimate, excess, PRESETS, STRATS, DEFAULT_PARAMS,
    genPath, simulate, runLab, sweep, allocate, calibrate, stats, rng, C_SCALE, SAMPLES_PER_DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PMQ = api;
})(typeof window !== 'undefined' ? window : globalThis);
