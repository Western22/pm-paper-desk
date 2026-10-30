// How many reward markets have a non-integer minimum size (rounding-down risk)?
const scan = require('../api/scan.js');
(async () => {
  const res = { headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
  await scan({ query: { n: '3000', size: '50', deep: '1' } }, res);
  const ms = res.body.markets;
  const frac = ms.filter(m => m.minSize % 1 !== 0);
  console.log(`${ms.length} markets · ${frac.length} with fractional min size`);
  const hits = ms.filter(m => /airlines suspend Ben Gurion|10-year Japanese government bond|oil export tax/i.test(m.question));
  hits.forEach(m => console.log(' ', m.minSize, m.tick, m.question.slice(0, 70)));
  frac.slice(0, 8).forEach(m => console.log('  frac', m.minSize, m.question.slice(0, 60)));
})().catch(e => { console.error(e); process.exit(1); });
