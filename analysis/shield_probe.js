// With the queue shield on, how many candidate markets still get a quote (and how far back does it sit)?
const E = require('../lib/paper-engine.js');
const { queueShield } = require('../bot/decide.js');
const { getJSON } = require('../api/_lib.js');
const Core = E.Core;
(async () => {
  const all = await E.scanMarkets(20);
  const ms = all.filter(m => m.C != null && m.mid >= 0.15 && m.mid <= 0.85 && !E.isHeadline(m.question) && m.minSize * Math.min(m.mid, 1 - m.mid) <= 10).sort((a, b) => (b.refDaily || 0) - (a.refDaily || 0)).slice(0, 40);
  let quoted = 0, shielded = 0, sides = 0, steps = 0; console.log("candidates", ms.length, "of", all.length);
  for (const m of ms) {
    const model = E.applyMarkout(await E.calibrated(m), { live: true, liveMarkoutC: 6.4 });
    const sig = model.volL / Math.sqrt(1440) * 100 * m.mid * (1 - m.mid) * 0.8;
    const best = Core.optimalQuote(E.metaOf(m), Math.max(m.C, 0.5 * m.minSize), sig * 1.25, m.mid, 10, model, 0, { maxShares: 1000, allowOneSided: true });
    if (!best || best.edge <= 0) continue;
    quoted++;
    const d = best.d / 100, x = Math.floor(best.x);
    const q = { bid: +(m.mid - d).toFixed(2), bs: best.mode === 'no' ? 0 : x, ask: +(m.mid + d).toFixed(2), as: best.mode === 'yes' ? 0 : x };
    const book = await getJSON(`https://clob.polymarket.com/book?token_id=${m.tokens[0].id}`, {}, 8000);
    const others = { bids: new Map(book.bids.map(l => [+l.price, +l.size])), asks: new Map(book.asks.map(l => [+l.price, +l.size])) };
    const sq = queueShield(q, others, m.mid, m.v, +book.tick_size || 0.01, +(process.env.K || 2), +(process.env.STEPS || 3));
    const n = (sq.bs > 0) + (sq.as > 0);
    if (n) { shielded++; sides += n; steps += Math.round(((q.bid - sq.bid) + (sq.ask - q.ask)) * 100); }
    console.log(`${n ? 'OK ' : 'OFF'} ${m.question.slice(0, 55).padEnd(55)} mid ${m.mid} d ${best.d}¢ → bid ${sq.bs ? sq.bid : '—'} ask ${sq.as ? sq.ask : '—'}`);
  }
  console.log(`\n${quoted} markets worth quoting · ${shielded} still quoted with the shield (${sides} sides, ${steps} ticks stepped back in total)`);
})().catch(e => { console.error(e); process.exit(1); });
