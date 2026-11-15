// =============================================================================
// engine.js - all the numbers behind the app (no drawing code in here).
//
//   1. loads the site list, horizons and JPL Horizons tables
//   2. answers "where are the Sun and Earth right now, from this site?"
//   3. builds a time series over a window (sunlit? Earth visible? DSN link?
//      power? battery?) and summary statistics
//   4. finds the next sunrise / sunset / Earthrise / Earthset
//
// Angles are degrees. Azimuth is clockwise from north. Times are milliseconds
// since 1970 (what JavaScript's Date uses), always UTC.
// =============================================================================
const Engine = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const AU_KM = 149597870.7, SUN_R_KM = 695700, EARTH_R_KM = 6378.14;
  const SOLAR_CONSTANT = 1361;                 // W/m2 at 1 AU
  const HOUR = 3600000;

  // Deep Space Network complexes (latitude, east longitude)
  const DSN = [
    { id: 'gds', name: 'Goldstone', lat: 35.426, lon: -116.890 },
    { id: 'mad', name: 'Madrid', lat: 40.431, lon: -4.248 },
    { id: 'cbr', name: 'Canberra', lat: -35.401, lon: 148.982 },
  ];

  let fetchJSON = async (p) => (await fetch(p)).json();
  const DB = { sites: [], byId: {}, regions: [], masts: [2, 10] };

  // ---------------------------------------------------------------- loading
  async function load() {
    const j = await fetchJSON('data/sites.json');
    DB.masts = j.masts; DB.regions = j.regions;
    for (const s of j.sites) {
      // horizons arrive as integers in 1/100 degree; convert to degrees
      s.mask = {};
      for (const m of j.masts) s.mask[m] = Float32Array.from(s.hz[String(m)], v => v / 100);
      delete s.hz;
      s.table = null;                         // Horizons table, loaded on demand
      s.horizonSource = Math.abs(s.lat) > 75.1 ? 'LOLA 80/120 m terrain, precomputed' : 'LOLA global 1.9 km terrain, precomputed';
      DB.sites.push(s); DB.byId[s.id] = s;
    }
    return DB;
  }

  // Load and decode a site's JPL Horizons table (hourly Sun/Earth directions).
  async function ensureTable(site) {
    if (!site.eph || site.table) return;
    const j = await fetchJSON('data/eph/' + site.id + '.json');
    const bytes = await Terrain.gunzipB64(j.data);
    const raw = new Uint16Array(bytes.buffer, bytes.byteOffset, j.n * 4);
    // Each of the 4 series was stored as differences between neighbours.
    // Undo that with a running sum (Int16/Uint16 wrap-around does the rest).
    const series = k => {
      const out = new Uint16Array(j.n); let acc = 0;
      for (let i = 0; i < j.n; i++) { acc = (acc + raw[k * j.n + i]) & 0xFFFF; out[i] = acc; }
      return out;
    };
    const toVec = (azQ, elQ) => {
      // Store unit vectors (east, north, up): interpolating these avoids the
      // 359 deg -> 0 deg jump you would get interpolating azimuth directly.
      const v = new Float32Array(j.n * 3);
      for (let i = 0; i < j.n; i++) {
        const az = azQ[i] * j.azScale * D2R;
        const el = (elQ[i] > 32767 ? elQ[i] - 65536 : elQ[i]) * j.elScale * D2R;
        v[3 * i] = Math.cos(el) * Math.sin(az); v[3 * i + 1] = Math.cos(el) * Math.cos(az); v[3 * i + 2] = Math.sin(el);
      }
      return v;
    };
    site.table = { t0: Date.parse(j.t0), n: j.n, step: j.stepHours * HOUR,
      sun: toVec(series(0), series(1)), earth: toVec(series(2), series(3)) };
  }

  function tableLookup(tb, vec, t) {
    const x = (t - tb.t0) / tb.step;
    if (x < 0 || x > tb.n - 1) return null;
    const i = Math.min(Math.floor(x), tb.n - 2), f = x - i;
    const e = vec[3 * i] * (1 - f) + vec[3 * i + 3] * f, n = vec[3 * i + 1] * (1 - f) + vec[3 * i + 4] * f, u = vec[3 * i + 2] * (1 - f) + vec[3 * i + 5] * f;
    const len = Math.hypot(e, n, u);
    return { az: Astro.norm(Math.atan2(e, n) * R2D), el: Math.asin(u / len) * R2D };
  }

  // ------------------------------------------------------------- positions
  // Sun and Earth as seen from a site at time t.
  // Directions come from the JPL Horizons table when the site has one and the
  // date is inside it (2026-2028); otherwise from the Meeus formulas in astro.js.
  // Distances always come from astro.js (the Horizons files only kept 3 decimals).
  function pos(site, t, g) {
    g = g || Astro.geometry(new Date(t));
    const hKm = (site.h + 2) / 1000;
    const sun = Astro.topo(g.sun, site.lat, site.lon, hKm);
    const earth = Astro.topo(g.earth, site.lat, site.lon, hKm);
    let src = 'computed';
    if (site.table) {
      const a = tableLookup(site.table, site.table.sun, t), b = tableLookup(site.table, site.table.earth, t);
      if (a && b) { sun.az = a.az; sun.el = a.el; earth.az = b.az; earth.el = b.el; src = 'horizons'; }
    }
    sun.radius = Math.asin(SUN_R_KM / sun.range) * R2D;       // about 0.27 deg
    earth.radius = Math.asin(EARTH_R_KM / earth.range) * R2D; // about 0.95 deg
    // Fraction of Earth's disc that is lit, as seen from the Moon: Earth is
    // "new" when it sits next to the Sun in the sky and "full" when opposite.
    const cosSep = Math.sin(sun.el * D2R) * Math.sin(earth.el * D2R) + Math.cos(sun.el * D2R) * Math.cos(earth.el * D2R) * Math.cos((sun.az - earth.az) * D2R);
    earth.phase = (1 - cosSep) / 2;
    return { sun, earth, src, g };
  }

  // Horizon mask of a site for ANY mast height.
  //  - Heights that were precomputed (ten values from 2 to 30 m) are used as they are.
  //  - Preset sites, other heights: blend the two nearest precomputed skylines.
  //    This is approximate, and slightly cautious: the true skyline is never
  //    higher than the blend, so it can only understate sunlight a little.
  //  - Custom sites: traced directly at that height on the browser's terrain.
  // Results are stored on the site so each height is worked out once.
  function maskOf(site, mast) {
    if (site.mask[mast]) return site.mask[mast];
    if (site.custom) return (site.mask[mast] = Terrain.horizon(site.lat, site.lon, mast).mask);
    const hs = DB.masts, lo = Math.max(...hs.filter(h => h <= mast), hs[0]), hi = Math.min(...hs.filter(h => h >= mast), hs[hs.length - 1]);
    if (lo === hi) return site.mask[lo];
    const f = (mast - lo) / (hi - lo), a = site.mask[lo], b = site.mask[hi], out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - f) + b[i] * f;
    return (site.mask[mast] = out);
  }
  // Is this mast height one of the exactly computed ones for this site?
  const mastExact = (site, mast) => site.custom || DB.masts.includes(mast);

  // Terrain horizon elevation at a given azimuth (linear interpolation of 720 values)
  function maskAt(mask, az) {
    const x = Astro.norm(az) * (mask.length / 360), i = Math.floor(x) % mask.length, f = x - Math.floor(x);
    return mask[i] * (1 - f) + mask[(i + 1) % mask.length] * f;
  }

  // --------------------------------------------------------------- DSN
  // Elevation of the Moon above the horizon at each DSN complex.
  // Moon's ecliptic position -> right ascension/declination -> hour angle
  // (using Greenwich sidereal time = how far the Earth has turned) -> elevation.
  function dsnElevations(g, t) {
    const jd = t / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
    const eps = (23.4392911 - 0.0130042 * T) * D2R, lam = g.moonLon * D2R, bet = g.moonLat * D2R;
    const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T) * D2R;
    const parallax = Math.asin(EARTH_R_KM / g.earth.dist);   // Moon looks ~1 deg lower from the surface than from Earth's centre
    return DSN.map(c => {
      const H = gmst + c.lon * D2R - ra, phi = c.lat * D2R;
      const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
      return (alt - parallax * Math.cos(alt)) * R2D;
    });
  }

  // ------------------------------------------------------------- lander power
  // Lander presets. These are APPROXIMATIONS for comparison, not vendor data.
  const LANDERS = {
    'nova-c': { label: 'Nova-C-style (approx.)', kind: 'body', topArea: 1.0, sides: 3, sideArea: 1.3, eff: 0.28,
      note: 'Hexagonal body with a top-deck array and three body-mounted side panels.' },
    'blue-ghost': { label: 'Blue Ghost-style (approx.)', kind: 'body', topArea: 1.6, sides: 4, sideArea: 1.0, eff: 0.28,
      note: 'Wide deck with a top array and four body-mounted side panels.' },
    'mast': { label: 'Sun-tracking mast (future base concept)', kind: 'mast', mastArea: 4.0, eff: 0.28,
      note: 'A vertical array on a mast that turns to face the Sun. Suits the pole, where the Sun circles the horizon.' },
  };

  // Turn a vector from the lander's own frame into the local frame
  // (x = east, y = north, z = up):
  //   1) rotate by the heading (clockwise seen from above, like a compass);
  //   2) lean the whole lander by `tilt` degrees toward compass direction
  //      tiltDir - a rotation about the horizontal axis at right angles to it
  //      (Rodrigues' rotation formula).
  function bodyToWorld(cfg, n) {
    const h = cfg.heading * D2R, ch = Math.cos(h), sh = Math.sin(h);
    let v = [n[0] * ch + n[1] * sh, -n[0] * sh + n[1] * ch, n[2]];
    const td = cfg.tiltDir * D2R, tt = cfg.tilt * D2R;
    const ax = [-Math.cos(td), Math.sin(td), 0], ct = Math.cos(tt), st = Math.sin(tt);
    const dot = ax[0] * v[0] + ax[1] * v[1] + ax[2] * v[2];
    const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
    return [v[0] * ct + cr[0] * st + ax[0] * dot * (1 - ct), v[1] * ct + cr[1] * st + ax[1] * dot * (1 - ct), v[2] * ct + cr[2] * st + ax[2] * dot * (1 - ct)];
  }

  // Panel list for a lander configuration. Normals are unit vectors in the
  // local frame (x = east, y = north, z = up), after heading and tilt.
  function panels(cfg) {
    const out = [];
    if (cfg.kind === 'mast') return out;
    const base = [{ name: 'Top deck', area: cfg.topArea, n: [0, 0, 1], bodyAz: null }];
    for (let k = 0; k < cfg.sides; k++) {
      const a = k * 360 / cfg.sides;                    // evenly spaced round the body
      base.push({ name: 'Side ' + (k + 1), area: cfg.sideArea, n: [Math.sin(a * D2R), Math.cos(a * D2R), 0], bodyAz: a });
    }
    for (const p of base) out.push({ name: p.name, area: p.area, n: bodyToWorld(cfg, p.n), bodyAz: p.bodyAz });
    return out;
  }

  // Electrical power (W) for a Sun at (az, el), with `frac` of its disc visible
  // and at distance rangeKm.  P = 1361 x (1 AU / r)^2 x area x efficiency x
  // visible fraction x cos(angle between panel and Sun). Panels facing away give 0.
  // Not modelled: one panel shading another, dust, temperature.
  function power(cfg, pl, sunAz, sunEl, frac, rangeKm, perPanel) {
    if (frac <= 0) { if (perPanel) perPanel.fill(0); return 0; }
    const flux = SOLAR_CONSTANT * (AU_KM / rangeKm) * (AU_KM / rangeKm) * frac * cfg.eff;
    if (cfg.kind === 'mast') return flux * cfg.mastArea * Math.cos(sunEl * D2R);   // always faces the Sun's azimuth
    const ce = Math.cos(sunEl * D2R), s = [ce * Math.sin(sunAz * D2R), ce * Math.cos(sunAz * D2R), Math.sin(sunEl * D2R)];
    let total = 0;
    for (let k = 0; k < pl.length; k++) {
      const c = pl[k].n[0] * s[0] + pl[k].n[1] * s[1] + pl[k].n[2] * s[2];
      const w = c > 0 ? flux * pl[k].area * c : 0;
      if (perPanel) perPanel[k] = w;
      total += w;
    }
    return total;
  }

  // ------------------------------------------------------------- time series
  // Pick a sample spacing that keeps the series under ~5000 points.
  function stepFor(hours) {
    for (const m of [2, 5, 10, 15, 20, 30, 60, 120, 180, 360]) if (hours * 60 / m <= 5000) return m * 60000;
    return 720 * 60000;
  }

  // Is the Sun / Earth up at time t?  (used by the event finder)
  //   Sun: its UPPER LIMB clears the terrain (any sunlight at all).
  //   Earth: by default its CENTRE clears the terrain; opt.earthEdge moves the
  //   test to the top edge (+1, "any part visible") or bottom edge (-1, "whole disc").
  function sunUp(site, opt, t) { const p = pos(site, t); return p.sun.el + p.sun.radius > maskAt(maskOf(site, opt.mast), p.sun.az); }
  function earthUp(site, opt, t) { const p = pos(site, t); return p.earth.el + opt.earthEdge * p.earth.radius > maskAt(maskOf(site, opt.mast), p.earth.az); }

  /* opt = { t0, hours, mast, earthEdge, dsnMinEl, lander (config), loadW, batteryWh } */
  function series(site, opt) {
    const dt = opt.stepMs || stepFor(opt.hours), n = Math.floor(opt.hours * HOUR / dt) + 1, dtH = dt / HOUR;
    const mask = maskOf(site, opt.mast), pl = panels(opt.lander);
    const S = { n, dt, t0: opt.t0, src: null,
      sunAz: new Float32Array(n), sunEl: new Float32Array(n), sunHz: new Float32Array(n), sunFrac: new Float32Array(n),
      earthAz: new Float32Array(n), earthEl: new Float32Array(n), earthHz: new Float32Array(n),
      earthVis: new Uint8Array(n), dsn: new Uint8Array(n), link: new Uint8Array(n), green: new Uint8Array(n),
      power: new Float32Array(n), soc: new Float32Array(n) };
    let nHor = 0;
    for (let i = 0; i < n; i++) {
      const t = opt.t0 + i * dt, p = pos(site, t);
      if (p.src === 'horizons') nHor++;
      const hs = maskAt(mask, p.sun.az), he = maskAt(mask, p.earth.az);
      const frac = Astro.discFraction(p.sun.el, hs, p.sun.radius);
      S.sunAz[i] = p.sun.az; S.sunEl[i] = p.sun.el; S.sunHz[i] = hs; S.sunFrac[i] = frac;
      S.earthAz[i] = p.earth.az; S.earthEl[i] = p.earth.el; S.earthHz[i] = he;
      S.earthVis[i] = p.earth.el + opt.earthEdge * p.earth.radius > he ? 1 : 0;
      // DSN: bit 0 Goldstone, bit 1 Madrid, bit 2 Canberra (Moon high enough there)
      const de = dsnElevations(p.g, t);
      let bits = 0; for (let k = 0; k < 3; k++) if (de[k] >= opt.dsnMinEl) bits |= 1 << k;
      S.dsn[i] = bits;
      S.link[i] = S.earthVis[i] && bits ? 1 : 0;          // direct-to-Earth contact possible
      S.green[i] = S.link[i] && frac > 0 ? 1 : 0;          // sunlight AND a link
      S.power[i] = power(opt.lander, pl, p.sun.az, p.sun.el, frac, p.sun.range);
    }
    S.src = nHor === n ? 'horizons' : nHor === 0 ? 'computed' : 'mixed';

    // Battery: start full, add (generation - load) each step, clamp to 0..capacity.
    let soc = opt.batteryWh, minSoc = soc, emptyH = 0, firstEmpty = -1, energy = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        soc += (S.power[i] - opt.loadW) * dtH; energy += S.power[i] * dtH;
        if (soc > opt.batteryWh) soc = opt.batteryWh;
        if (soc <= 0) { soc = 0; emptyH += dtH; if (firstEmpty < 0) firstEmpty = i; }
      }
      S.soc[i] = soc; if (soc < minSoc) minSoc = soc;
    }

    // Summary statistics. runs() measures the longest stretch of 1s and of 0s.
    const runs = (arr, test) => {
      let on = 0, best1 = 0, best0 = 0, cur1 = 0, cur0 = 0, zeroRuns = 0;
      for (let i = 0; i < n; i++) {
        if (test(arr[i])) { on++; cur1++; cur0 = 0; if (cur1 > best1) best1 = cur1; }
        else { if (cur0 === 0) zeroRuns++; cur0++; cur1 = 0; if (cur0 > best0) best0 = cur0; }
      }
      return { pct: 100 * on / n, longestOn: best1 * dtH, longestOff: best0 * dtH, offRuns: zeroRuns };
    };
    const lit = runs(S.sunFrac, v => v > 0), ear = runs(S.earthVis, v => v), lnk = runs(S.link, v => v), grn = runs(S.green, v => v);
    // DSN coverage gaps: stretches when NONE of the three complexes has the Moon
    // high enough. This depends only on Earth's rotation and the Moon's position,
    // not on the landing site's terrain. Times are accurate to one sample step.
    const dsnGaps = []; let gs = -1;
    for (let i = 0; i <= n; i++) {
      const none = i < n && S.dsn[i] === 0;
      if (none && gs < 0) gs = i;
      if (!none && gs >= 0) { dsnGaps.push({ t0: opt.t0 + gs * dt, t1: opt.t0 + i * dt, hours: (i - gs) * dtH }); gs = -1; }
    }
    let disc = 0; for (let i = 0; i < n; i++) disc += S.sunFrac[i];
    S.stats = { pctLit: lit.pct, meanDisc: 100 * disc / n, longestLit: lit.longestOn, longestDark: lit.longestOff, outages: lit.offRuns,
      pctEarth: ear.pct, longestNoEarth: ear.longestOff, pctLink: lnk.pct, longestNoLink: lnk.longestOff,
      pctGreen: grn.pct, longestGreen: grn.longestOn,
      dsnGaps, dsnGapHours: dsnGaps.reduce((a, g) => a + g.hours, 0), dsnGapLongest: dsnGaps.reduce((a, g) => Math.max(a, g.hours), 0),
      energyWh: energy, minSoc, emptyH, firstEmpty: firstEmpty < 0 ? null : opt.t0 + firstEmpty * dt,
      peakW: S.power.reduce((a, b) => Math.max(a, b), 0) };
    return S;
  }

  // ------------------------------------------------------------- find a window
  // Try many start dates and score each one. To stay fast we compute ONE long
  // series (30-minute steps) covering every candidate window, then slide a
  // window along it.
  //   criterion: 'green'    most time with sunlight AND a DSN link   (higher is better)
  //              'greenRun' longest unbroken sunlight + link stretch (higher is better)
  //              'sun'      most sunlit time                         (higher is better)
  //              'link'     most DSN link time                       (higher is better)
  //              'dark'     shortest "longest darkness"              (lower is better)
  function findWindow(site, opt, rangeDays, criterion) {
    const dt = 30 * 60000, win = Math.round(opt.hours * HOUR / dt), span = Math.round(rangeDays * 24 * HOUR / dt);
    const S = series(site, Object.assign({}, opt, { hours: (span + win) * dt / HOUR, stepMs: dt }));
    const flag = new Uint8Array(S.n);
    for (let i = 0; i < S.n; i++) flag[i] = criterion === 'green' || criterion === 'greenRun' ? S.green[i] : criterion === 'link' ? S.link[i] : (S.sunFrac[i] > 0 ? 1 : 0);
    const runMode = criterion === 'greenRun' || criterion === 'dark', want = criterion === 'dark' ? 0 : 1;
    // prefix sums: number of flagged samples before index i (makes each percentage one subtraction)
    const pre = new Uint32Array(S.n + 1); for (let i = 0; i < S.n; i++) pre[i + 1] = pre[i] + flag[i];
    const stepC = Math.round((rangeDays <= 90 ? 6 : rangeDays <= 180 ? 12 : 24) * HOUR / dt);   // spacing of candidate starts
    const out = []; let best = null;
    for (let a = 0; a <= span; a += stepC) {
      let score;
      if (!runMode) score = 100 * (pre[a + win] - pre[a]) / win;
      else { let cur = 0, mx = 0; for (let i = a; i < a + win; i++) { if (flag[i] === want) { cur++; if (cur > mx) mx = cur; } else cur = 0; } score = mx * dt / HOUR; }
      const c = { t0: opt.t0 + a * dt, score }; out.push(c);
      if (!best || (criterion === 'dark' ? score < best.score : score > best.score)) best = c;
    }
    return { candidates: out, best, unit: runMode ? 'h' : '%', lowerIsBetter: criterion === 'dark' };
  }

  // ------------------------------------------------------------- events
  // Next time `up(t)` switches to `wantUp` after tFrom: scan in coarse steps,
  // then halve the bracketing interval (bisection) until it is under a minute.
  function nextChange(up, tFrom, wantUp, stepMs, maxMs) {
    let prev = up(tFrom);
    for (let t = tFrom + stepMs; t <= tFrom + maxMs; t += stepMs) {
      const cur = up(t);
      if (cur !== prev && cur === wantUp) {
        let a = t - stepMs, b = t;
        while (b - a > 30000) { const m = (a + b) / 2; if (up(m) === wantUp) b = m; else a = m; }
        return b;
      }
      prev = cur;
    }
    return null;
  }
  // kind: 'sunrise' | 'sunset' | 'earthrise' | 'earthset'. Looks up to 120 days ahead.
  function nextEvent(site, opt, tFrom, kind) {
    const f = kind.startsWith('sun') ? (t => sunUp(site, opt, t)) : (t => earthUp(site, opt, t));
    return nextChange(f, tFrom, kind.endsWith('rise'), 30 * 60000, 120 * 24 * HOUR);
  }

  // ------------------------------------------------------------- custom sites
  // South/north polar stereographic projection (km), used for point-in-polygon.
  function stereo(lat, lon) {
    const rho = 2 * 1737.4 * Math.tan((90 - Math.abs(lat)) * D2R / 2);
    return [rho * Math.sin(lon * D2R), rho * Math.cos(lon * D2R)];
  }
  // Which Artemis III candidate region (if any) contains this point?
  // Classic ray-casting test, done on the flat polar map so that polygons
  // near the pole (where longitude lines converge) behave.
  function regionAt(lat, lon) {
    if (lat > -80) return null;
    const [x, y] = stereo(lat, lon);
    for (const r of DB.regions) {
      const pts = r.ring.map(c => stereo(c[1], c[0]));
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return r;
    }
    return null;
  }

  async function customSite(lat, lon) {
    await Terrain.ensureFor(lat);
    const site = { id: 'custom', name: 'Custom site', group: 'custom', lat, lon, custom: true, eph: false, table: null, mask: {}, note: '',
      horizonSource: Math.abs(lat) > 75.1 ? 'approximate: 400 m terrain, traced in your browser' : 'approximate: 7.6 km terrain, traced in your browser' };
    const r = Terrain.horizon(lat, lon, 2); site.mask[2] = r.mask; site.h = r.h;      // other mast heights are traced on demand (maskOf)
    site.region = regionAt(lat, lon);
    return site;
  }

  return { load, ensureTable, pos, maskAt, maskOf, mastExact, series, findWindow, nextEvent, sunUp, earthUp, dsnElevations, panels, bodyToWorld, power, regionAt, customSite,
    DB, DSN, LANDERS, HOUR, setFetch: (f, fb) => { fetchJSON = f; Terrain.setFetch(f, fb); } };
})();
if (typeof module !== 'undefined') module.exports = Engine;
