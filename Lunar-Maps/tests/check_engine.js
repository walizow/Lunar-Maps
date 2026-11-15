// Engine checks from section 7 of the brief. Run:  node tests/check_engine.js
// Env: LUNAR_HORIZONS = folder containing horizons_out/ and horizons_custom/ (the raw JPL CSVs)
const fs = require('fs'), path = require('path');
const WEB = path.join(__dirname, '..', 'web');
const HZ = process.env.LUNAR_HORIZONS || '/mnt/user-data/uploads';
// Load the browser scripts into this Node process as globals.
for (const f of ['astro.js', 'terrain.js', 'engine.js']) {
  const name = { 'astro.js': 'Astro', 'terrain.js': 'Terrain', 'engine.js': 'Engine' }[f];
  global[name] = new Function(fs.readFileSync(path.join(WEB, 'js', f), 'utf8') + ';return ' + name + ';')();
}
Engine.setFetch(async p => JSON.parse(fs.readFileSync(path.join(WEB, p), 'utf8')), async p => new Uint8Array(fs.readFileSync(path.join(WEB, p))));

const readCsv = p => fs.readFileSync(p, 'utf8').trim().split('\n').slice(1).map(l => { const c = l.split(','); return [Date.parse(c[0]), +c[1], +c[2]]; });
const fmt = (x, n = 3) => x.toFixed(n);

(async () => {
  const DB = await Engine.load();
  let fail = 0; const bad = m => { fail++; console.log('  ** FAIL: ' + m); };

  console.log('== Check 1: browser ephemeris (astro.js) vs JPL Horizons, elevation, every 6 h over 2026-2028 ==');
  let worstRms = 0, worstMax = 0, tabErr = 0;
  for (const s of DB.sites.filter(s => s.eph)) {
    const folder = ['horizons_out', 'horizons_custom', 'horizons_extra'].find(f => fs.existsSync(path.join(HZ, f, s.id + '__sun.csv')));
    const sun = readCsv(path.join(HZ, folder, s.id + '__sun.csv')), earth = readCsv(path.join(HZ, folder, s.id + '__earth.csv'));
    await Engine.ensureTable(s);
    let se = 0, ee = 0, ms = 0, me = 0, n = 0;
    for (let i = 0; i < sun.length; i += 6) {
      const g = Astro.geometry(new Date(sun[i][0]));
      const a = Astro.topo(g.sun, s.lat, s.lon, s.ephH / 1000), b = Astro.topo(g.earth, s.lat, s.lon, s.ephH / 1000);
      const ds = a.el - sun[i][2], de = b.el - earth[i][2];
      se += ds * ds; ee += de * de; ms = Math.max(ms, Math.abs(ds)); me = Math.max(me, Math.abs(de)); n++;
      // the packed table must reproduce the CSV (half-hour offset tests the interpolation too)
      const p = Engine.pos(s, sun[i][0]);
      tabErr = Math.max(tabErr, Math.abs(p.sun.el - sun[i][2]), Math.abs(p.earth.el - earth[i][2]),
        Math.abs(((p.sun.az - sun[i][1] + 540) % 360) - 180) * Math.cos(sun[i][2] * Math.PI / 180));
    }
    const rs = Math.sqrt(se / n), re = Math.sqrt(ee / n);
    worstRms = Math.max(worstRms, rs, re); worstMax = Math.max(worstMax, ms, me);
    console.log(`  ${s.id.padEnd(42)} Sun rms ${fmt(rs)} max ${fmt(ms)} | Earth rms ${fmt(re)} max ${fmt(me)}`);
  }
  console.log(`  worst RMS ${fmt(worstRms)} deg (target <= 0.02), worst max ${fmt(worstMax)} deg (target <= 0.05)`);
  console.log(`  packed Horizons table vs CSV: max error ${fmt(tabErr, 4)} deg`);
  if (worstMax > 0.05) bad('ephemeris max error'); if (tabErr > 0.01) bad('table decode');

  console.log('== Check 2: Apollo 11 landing, 1969-07-20 20:17 UTC ==');
  const a11 = Engine.pos(DB.byId['apollo-11'], Date.UTC(1969, 6, 20, 20, 17));
  console.log(`  Sun elevation ${fmt(a11.sun.el, 2)} deg, azimuth ${fmt(a11.sun.az, 1)} (expected about 10.8; source: ${a11.src})`);
  if (Math.abs(a11.sun.el - 10.8) > 0.3) bad('Apollo 11');

  console.log('== Check 5: three-year fractions through the app engine (2 m mast) ==');
  const opt = { t0: Date.UTC(2026, 0, 1), hours: 3 * 365 * 24, mast: 2, earthEdge: 0, dsnMinEl: 10, lander: Object.assign({ heading: 0, tilt: 0, tiltDir: 0 }, Engine.LANDERS['nova-c']), loadW: 200, batteryWh: 1500 };
  for (const id of ['shackleton-floor', 'derosa2012-cr1-connecting-ridge', 'derosa2012-mp1-malapert-peak', 'custom-s85.490-w19.219', 'apollo-11']) {
    const s = DB.byId[id], S = Engine.series(s, opt);
    console.log(`  ${id.padEnd(36)} sunlit ${fmt(S.stats.pctLit, 1)} %  Earth ${fmt(S.stats.pctEarth, 1)} %  DSN link ${fmt(S.stats.pctLink, 1)} %  longest dark ${fmt(S.stats.longestDark / 24, 1)} d` +
      (s.longterm ? `   [NASA long-term: Sun ${s.longterm.sun} %, Earth ${s.longterm.earth} %]` : ''));
    if (id === 'shackleton-floor' && S.stats.pctLit > 0.5) bad('Shackleton floor should be dark');
  }

  console.log('== Check 6: Artemis III regions ==');
  for (const r of DB.regions) {
    // average of the corners in map coordinates is safely inside a convex region
    const c = r.ring.slice(0, -1); let x = 0, y = 0;
    for (const [lo, la] of c) { const rho = 90 + la; x += rho * Math.sin(lo * Math.PI / 180); y += rho * Math.cos(lo * Math.PI / 180); }
    x /= c.length; y /= c.length;
    const lat = -90 + Math.hypot(x, y), lon = Math.atan2(x, y) * 180 / Math.PI;
    const hit = Engine.regionAt(lat, lon), out = Engine.regionAt(lat + 1.2, lon + 3);
    console.log(`  ${r.code} ${r.name.padEnd(20)} centre (${fmt(lat, 2)}, ${fmt(lon, 2)}) -> ${hit ? hit.code : 'none'};  point 1.2 deg away -> ${out ? out.code : 'none'}`);
    if (!hit || hit.code !== r.code) bad('region ' + r.code);
  }
  for (const [la, lo] of [[-89.9, 0], [-80.5, 100], [-60, 20], [45, 0]]) if (Engine.regionAt(la, lo)) bad('outside point flagged');
  const sitesIn = DB.sites.filter(s => s.group === 'artemis3').map(s => (Engine.regionAt(s.lat, s.lon) || {}).code).join(' ');
  console.log('  Artemis preset sites fall in: ' + sitesIn);

  console.log('== Custom site: browser horizon (400 m) vs precomputed (80 m) at the demo site ==');
  const demo = DB.byId['custom-s85.490-w19.219'];
  const t1 = Date.now(), cs = await Engine.customSite(demo.lat, demo.lon); cs.table = demo.table;
  let d = 0; for (let k = 0; k < 720; k++) d += Math.abs(cs.mask[2][k] - demo.mask[2][k]);
  const A = Engine.series(demo, opt).stats, B = Engine.series(cs, opt).stats;
  console.log(`  load+trace ${Date.now() - t1} ms; mean horizon difference ${fmt(d / 720, 2)} deg; sunlit ${fmt(A.pctLit, 1)} vs ${fmt(B.pctLit, 1)} %; Earth ${fmt(A.pctEarth, 1)} vs ${fmt(B.pctEarth, 1)} %; region: ${cs.region ? cs.region.code : 'none'}; height ${fmt(cs.h, 0)} m`);

  console.log('== DSN sanity: Moon elevation at the three complexes, 2026-11-15 00:00 UTC ==');
  const g = Astro.geometry(new Date(Date.UTC(2026, 10, 15)));
  console.log('  ' + Engine.dsnElevations(g, Date.UTC(2026, 10, 15)).map((e, k) => Engine.DSN[k].name + ' ' + fmt(e, 1)).join(', '));
  const t2 = Date.now(); Engine.series(DB.byId['derosa2012-cr1-connecting-ridge'], Object.assign({}, opt, { hours: 29.5 * 24 }));
  console.log(`  one lunar-day series: ${Date.now() - t2} ms`);
  const ev = Engine.nextEvent(DB.byId['apollo-11'], opt, Date.UTC(2026, 10, 15), 'sunset');
  console.log('  next sunset at Apollo 11 after 2026-11-15: ' + new Date(ev).toISOString());
  console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll engine checks passed');
})();
