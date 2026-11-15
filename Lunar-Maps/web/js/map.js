// =============================================================================
// map.js - the 2D map: polar maps (south, north) and a global map.
//
// The map is a stack of pictures drawn on one canvas:
//   base picture (WAC photo / shaded relief / elevation colours)
//   + optional data overlays (average Sun / Earth visibility, permanent shadow)
//   + lines and labels drawn by code (graticule, Artemis regions, names, sites)
//
// Two small pieces of maths do all the work:
//   project(lat, lon)  -> pixel position in the base picture
//   unproject(x, y)    -> lat, lon under a pixel (used for hover and clicks)
// and a "view" (zoom k and offset ox, oy) maps picture pixels to screen pixels.
// =============================================================================
const MapView = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, R_KM = 1737.4;
  let cv, c, W = 0, H = 0, hooks = {}, meta = null;
  let view = 'S', base = 'wac', k = 1, ox = 0, oy = 0;       // which map, which base picture, zoom and offset
  const show = { sun: false, earth: false, psr: true, regions: true, objects: true, names: true, grid: true, sites: true };
  let opacity = 0.65;
  const images = {};          // loaded pictures, by file name
  const overlays = {};        // coloured overlay canvases + their raw values, by file name
  let features = null, objects = null, pin = null, hover = null, site = null, sunEarth = null;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ------------------------------------------------------------ projections
  const mapW = () => view === 'G' ? meta.G.width : meta[view].size;
  const mapH = () => view === 'G' ? meta.G.height : meta[view].size;
  function project(lat, lon) {
    if (view === 'G') { const lo = ((lon + 540) % 360) - 180; return [(lo + 180) / 360 * meta.G.width, (90 - lat) / 180 * meta.G.height]; }
    const m = meta[view], half = m.size / 2;
    if (m.south ? lat > -74.9 : lat < 74.9) return null;                       // outside this polar map
    // polar stereographic: distance from the pole on the map, in km, then in pixels
    const rho = 2 * R_KM * Math.tan((90 - Math.abs(lat)) * D2R / 2) / m.radius_km * half;
    return [half + rho * Math.sin(lon * D2R), m.south ? half - rho * Math.cos(lon * D2R) : half + rho * Math.cos(lon * D2R)];
  }
  function unproject(x, y) {
    if (view === 'G') { if (y < 0 || y > meta.G.height) return null; return [90 - y / meta.G.height * 180, ((x / meta.G.width * 360) % 360 + 360) % 360 - 180]; }
    const m = meta[view], half = m.size / 2, dx = (x - half) / half * m.radius_km, dy = (y - half) / half * m.radius_km;
    const colat = 2 * Math.atan(Math.hypot(dx, dy) / (2 * R_KM)) * R2D;
    if (colat > 15) return null;
    return [m.south ? -(90 - colat) : 90 - colat, (m.south ? Math.atan2(dx, -dy) : Math.atan2(dx, dy)) * R2D];
  }
  const toScreen = p => [p[0] * k + ox, p[1] * k + oy];
  const kmPerPx = () => view === 'G' ? (2 * Math.PI * R_KM / meta.G.width) / k : (2 * meta[view].radius_km / meta[view].size) / k;

  // ------------------------------------------------------------ loading
  function image(name) {
    if (!images[name]) { const im = new Image(); im.onload = draw; im.src = 'data/map/' + name; images[name] = im; }
    return images[name].complete && images[name].naturalWidth ? images[name] : null;
  }
  // Data overlays arrive as grey pictures. Read the grey values once, keep them
  // (for the hover readout) and paint a coloured, see-through copy.
  const RAMPS = { sun: [[20, 10, 40], [120, 30, 110], [220, 90, 60], [250, 180, 50], [255, 250, 190]], earth: [[8, 20, 60], [20, 80, 150], [60, 150, 210], [150, 215, 240], [235, 250, 255]] };
  const rampColor = (stops, f) => { const v = Math.max(0, Math.min(1, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(v)), t = v - i; return stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * t)); };
  function overlay(kind) {
    const name = view + '_' + kind + '.png';
    if (overlays[name]) return overlays[name];
    const im = image(name); if (!im) return null;
    const cvs = document.createElement('canvas'); cvs.width = im.naturalWidth; cvs.height = im.naturalHeight;
    const g = cvs.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, cvs.width, cvs.height), px = d.data, vals = new Uint8Array(cvs.width * cvs.height);
    for (let i = 0; i < vals.length; i++) {
      const v = px[4 * i]; vals[i] = v;
      if (kind === 'psr') { px[4 * i] = 0; px[4 * i + 1] = 210; px[4 * i + 2] = 255; px[4 * i + 3] = v > 127 ? 255 : 0; }
      else if (v === 255) px[4 * i + 3] = 0;                                         // no data
      else { const col = rampColor(RAMPS[kind], v / 250); px[4 * i] = col[0]; px[4 * i + 1] = col[1]; px[4 * i + 2] = col[2]; px[4 * i + 3] = 255; }
    }
    g.putImageData(d, 0, 0);
    return (overlays[name] = { cvs, vals, w: cvs.width, h: cvs.height });
  }
  async function loadLists() {
    if (features) return;
    features = []; objects = [];
    const [f, o] = await Promise.all([hooks.fetchJSON('data/map/features.json'), hooks.fetchJSON('data/map/objects.json')]);
    features = f; objects = o; draw();
  }

  // ------------------------------------------------------------ view control
  function fit() { k = Math.min(W / mapW(), H / mapH()); ox = (W - mapW() * k) / 2; oy = (H - mapH() * k) / 2; }
  function zoomAt(sx, sy, factor) {
    const k2 = Math.max(Math.min(W / mapW(), H / mapH()) * 0.9, Math.min(40, k * factor));
    ox = sx - (sx - ox) * k2 / k; oy = sy - (sy - oy) * k2 / k; k = k2; draw();
  }
  function centreOn(lat, lon, spanKm) {
    const p = project(lat, lon); if (!p) return;
    if (spanKm) k = Math.min(40, (view === 'G' ? (2 * Math.PI * R_KM / meta.G.width) : (2 * meta[view].radius_km / meta[view].size)) * Math.min(W, H) / spanKm);
    ox = W / 2 - p[0] * k; oy = H / 2 - p[1] * k; draw();
  }
  function setView(v, keep) { view = v; if (!keep) fit(); hooks.onView && hooks.onView(v); draw(); }
  const viewFor = lat => lat < -75.5 ? 'S' : lat > 75.5 ? 'N' : 'G';

  // ------------------------------------------------------------ drawing
  function draw() {
    if (!meta || !cv) return;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); const first = !W; W = r.width; H = r.height; if (first) fit(); }
    W = r.width; H = r.height; c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#05070b'; c.fillRect(0, 0, W, H);
    const im = image(view + '_' + base + '.webp');
    c.imageSmoothingEnabled = k < 3;
    if (im) c.drawImage(im, ox, oy, mapW() * k, mapH() * k);
    else { c.fillStyle = '#9aa'; c.font = '13px ' + css('--font'); c.fillText('Loading map…', 12, 20); }
    if (view !== 'G') {
      c.globalAlpha = opacity;
      for (const kind of ['sun', 'earth']) if (show[kind]) { const o = overlay(kind); if (o) c.drawImage(o.cvs, ox, oy, mapW() * k, mapH() * k); }
      c.globalAlpha = Math.min(1, opacity + 0.15);
      if (show.psr) { const o = overlay('psr'); if (o) c.drawImage(o.cvs, ox, oy, mapW() * k, mapH() * k); }
      c.globalAlpha = 1;
    }
    c.font = '11px ' + css('--mono'); c.textBaseline = 'middle'; c.textAlign = 'center';
    // text with a dark outline so it stays readable on any background (line settings are put back afterwards)
    const text = (s, x, y, col) => { const ss = c.strokeStyle, lw = c.lineWidth; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.75)'; c.strokeText(s, x, y); c.fillStyle = col; c.fillText(s, x, y); c.strokeStyle = ss; c.lineWidth = lw; };
    const line = pts => { c.beginPath(); let pen = false; for (const p of pts) { if (!p) { pen = false; continue; } const s = toScreen(p); pen ? c.lineTo(s[0], s[1]) : c.moveTo(s[0], s[1]); pen = true; } c.stroke(); };

    // graticule: circles of latitude and lines of longitude
    if (show.grid) {
      c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1;
      if (view === 'G') {
        for (let lo = -180; lo <= 180; lo += 30) { line([project(89.99, lo === 180 ? 179.999 : lo), project(-89.99, lo === 180 ? 179.999 : lo)]); const s = toScreen(project(0, lo === 180 ? 179.999 : lo)); text(lo + '°', s[0], s[1] - 8, '#dfe6ee'); }
        for (let la = -60; la <= 60; la += 30) { line([project(la, -180), project(la, 179.999)]); const s = toScreen(project(la, -180)); text(la + '°', Math.max(18, s[0] + 16), s[1] - 8, '#dfe6ee'); }
      } else {
        const sgn = meta[view].south ? -1 : 1, stepLat = k > 2.2 ? 1 : 5, stepLon = k > 2.2 ? 15 : 30;
        for (let la = 76; la < 90; la++) if (la % stepLat === 0) { const pts = []; for (let lo = 0; lo <= 360; lo += 3) pts.push(project(sgn * la, lo)); c.strokeStyle = la % 5 === 0 ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.18)'; line(pts); const s = toScreen(project(sgn * la, 45)); if (la % 5 === 0 || k > 4) text(la + '°' + (sgn < 0 ? 'S' : 'N'), s[0], s[1], '#dfe6ee'); }
        c.strokeStyle = 'rgba(255,255,255,.22)';
        for (let lo = 0; lo < 360; lo += stepLon) { line([project(sgn * 89.6, lo), project(sgn * 75.05, lo)]); const s = toScreen(project(sgn * 76.2, lo)); text((lo > 180 ? lo - 360 : lo) + '°', s[0], s[1], '#dfe6ee'); }
      }
    }
    // Artemis III candidate regions
    if (show.regions && view === 'S') {
      c.strokeStyle = '#ffd34d'; c.lineWidth = 1.6;
      for (const rg of hooks.regions()) { const pts = rg.ring.map(q => project(q[1], q[0])); line(pts); const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length, s = toScreen([cx, cy]); c.font = '600 11px ' + css('--font'); text(rg.code, s[0], s[1], '#ffd34d'); }
    }
    // IAU names: features arrive biggest first; label those that are large enough on screen and do not collide
    c.font = '11.5px ' + css('--font');
    if (show.names && features) {
      const taken = [], kpp = kmPerPx(); let n = 0;
      for (const f of features) {
        if (f[3] / kpp < 26 || n > 70) break;      // the rest are smaller still
        const p = project(f[1], f[2]); if (!p) continue;
        const s = toScreen(p); if (s[0] < 0 || s[0] > W || s[1] < 0 || s[1] > H) continue;
        const w = c.measureText(f[0]).width / 2 + 3, box = [s[0] - w, s[1] - 8, s[0] + w, s[1] + 8];
        if (taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        taken.push(box); text(f[0], s[0], s[1], '#f3f6fa'); n++;
      }
    }
    // human-made objects
    if (show.objects && objects) {
      for (const o of objects) { const p = project(o[3], o[4]); if (!p) continue; const s = toScreen(p); if (s[0] < -5 || s[0] > W + 5 || s[1] < -5 || s[1] > H + 5) continue;
        c.fillStyle = '#ff9d5c'; c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.moveTo(s[0], s[1] - 5); c.lineTo(s[0] + 5, s[1]); c.lineTo(s[0], s[1] + 5); c.lineTo(s[0] - 5, s[1]); c.closePath(); c.fill(); c.stroke();
        if (kmPerPx() < 0.35 || view === 'G' && k > 6) { c.textAlign = 'left'; text(o[0], s[0] + 8, s[1], '#ffd0b0'); c.textAlign = 'center'; } }
    }
    // preset sites and the selected site
    if (show.sites) for (const st of hooks.sites()) { const p = project(st.lat, st.lon); if (!p) continue; const s = toScreen(p);
      c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.arc(s[0], s[1], 3.2, 0, 7); c.fill(); c.stroke(); }
    if (site) { const p = project(site.lat, site.lon); if (p) { const s = toScreen(p);
      // arrows toward the Sun and the Earth right now (compass bearings turned into map directions)
      if (sunEarth) for (const [az, col, label, up] of [[sunEarth.sunAz, css('--sun'), 'Sun', sunEarth.sunUp], [sunEarth.earthAz, css('--earth'), 'Earth', sunEarth.earthUp]]) {
        const dd = Astro.destination(site.lat, site.lon, az, 20), q = project(dd.lat, dd.lon); if (!q) continue;      // a point 20 km along that bearing
        const t = toScreen(q), a = Math.atan2(t[1] - s[1], t[0] - s[0]), L = 46, ex = s[0] + L * Math.cos(a), ey = s[1] + L * Math.sin(a);
        c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2.5; c.setLineDash(up ? [] : [4, 4]); c.beginPath(); c.moveTo(s[0], s[1]); c.lineTo(ex, ey); c.stroke(); c.setLineDash([]);
        c.beginPath(); c.moveTo(ex + 7 * Math.cos(a), ey + 7 * Math.sin(a)); c.lineTo(ex + 6 * Math.cos(a + 2.4), ey + 6 * Math.sin(a + 2.4)); c.lineTo(ex + 6 * Math.cos(a - 2.4), ey + 6 * Math.sin(a - 2.4)); c.closePath(); c.fill();
        c.font = '600 11px ' + css('--font'); text(label + (up ? '' : ' (hidden)'), ex + 22 * Math.cos(a), ey + 14 * Math.sin(a), col);
      }
      c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.beginPath(); c.arc(s[0], s[1], 8, 0, 7); c.stroke(); c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.arc(s[0], s[1], 10, 0, 7); c.stroke();
    } }
    // dropped pin (a candidate custom site)
    if (pin) { const p = project(pin.lat, pin.lon); if (p) { const s = toScreen(p); c.strokeStyle = '#ff5c8a'; c.lineWidth = 2; c.beginPath(); c.moveTo(s[0] - 9, s[1]); c.lineTo(s[0] + 9, s[1]); c.moveTo(s[0], s[1] - 9); c.lineTo(s[0], s[1] + 9); c.stroke(); c.beginPath(); c.arc(s[0], s[1], 5, 0, 7); c.stroke(); } }

    // scale bar and colour legend
    const kpp = kmPerPx(), nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].find(v => v / kpp > 60) || 5000;
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(W - nice / kpp - 26, H - 30, nice / kpp + 18, 22);
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(W - 17 - nice / kpp, H - 13); c.lineTo(W - 17, H - 13); c.stroke();
    c.font = '11px ' + css('--mono'); c.textAlign = 'center'; c.fillStyle = '#fff'; c.fillText(nice + ' km' + (view === 'G' ? ' at equator' : ''), W - 17 - nice / kpp / 2, H - 22);
    const legends = [];
    if (view !== 'G' && show.sun) legends.push(['Sun visible, long-term average', RAMPS.sun, '0 %', '100 %']);
    if (view !== 'G' && show.earth) legends.push(['Earth visible, long-term average', RAMPS.earth, '0 %', '100 %']);
    if (base === 'elev') { const m = meta[view]; legends.push(['Elevation', [[20, 24, 82], [38, 76, 140], [35, 127, 142], [60, 170, 120], [150, 205, 90], [235, 225, 110], [250, 245, 215]], (m.elevMin / 1000).toFixed(1) + ' km', '+' + (m.elevMax / 1000).toFixed(1) + ' km']); }
    legends.forEach(([title, stops, a, b], i) => {
      const x = 10, y = H - 44 - i * 42, w = 170;
      c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x - 4, y - 4, w + 8, 38);
      const g = c.createLinearGradient(x, 0, x + w, 0); stops.forEach((s, j) => g.addColorStop(j / (stops.length - 1), `rgb(${s})`)); c.fillStyle = g; c.fillRect(x, y + 12, w, 8);
      c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(title, x, y + 4); c.fillText(a, x, y + 27); c.textAlign = 'right'; c.fillText(b, x + w, y + 27);
    });
  }

  // What is under a screen position: coordinates, overlay values, nearest named feature, Artemis region.
  function describe(sx, sy) {
    const ll = unproject((sx - ox) / k, (sy - oy) / k); if (!ll) return null;
    const out = { lat: ll[0], lon: ll[1] };
    if (view !== 'G') for (const kind of ['sun', 'earth', 'psr']) { const o = overlays[view + '_' + kind + '.png']; if (!o) continue;
      const x = Math.floor((sx - ox) / k / mapW() * o.w), y = Math.floor((sy - oy) / k / mapH() * o.h); if (x < 0 || y < 0 || x >= o.w || y >= o.h) continue;
      const v = o.vals[y * o.w + x]; if (kind === 'psr') out.psr = v > 127; else if (v !== 255) out[kind] = v / 2.5; }
    if (features) { let best = null; for (const f of features) { if (Math.abs(f[1] - ll[0]) > 12) continue;
        const d = Math.acos(Math.min(1, Math.sin(f[1] * D2R) * Math.sin(ll[0] * D2R) + Math.cos(f[1] * D2R) * Math.cos(ll[0] * D2R) * Math.cos((f[2] - ll[1]) * D2R))) * R_KM;
        if (d < f[3] / 2 && (!best || f[3] < best[3])) best = f; }            // smallest feature that contains the point
      if (best) out.feature = best[0]; }
    out.region = hooks.regionAt(ll[0], ll[1]);
    return out;
  }

  // ------------------------------------------------------------ interaction
  function init(canvas, h) {
    cv = canvas; hooks = h;
    let down = null, moved = false;
    cv.onpointerdown = e => { down = [e.clientX, e.clientY, ox, oy]; moved = false; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (down) { if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) moved = true; if (moved) { ox = down[2] + e.clientX - down[0]; oy = down[3] + e.clientY - down[1]; draw(); } }
      hover = describe(sx, sy); hooks.onHover && hooks.onHover(hover, e);
    };
    cv.onpointerup = e => {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (down && !moved) {
        // a click on a preset marker selects it; anywhere else drops a pin for a custom site
        let hit = null; if (show.sites) for (const st of hooks.sites()) { const p = project(st.lat, st.lon); if (!p) continue; const s = toScreen(p); if (Math.hypot(s[0] - sx, s[1] - sy) < 8) { hit = st; break; } }
        if (hit) hooks.onSelect(hit); else { const d = describe(sx, sy); if (d) { pin = d; hooks.onPick(d); draw(); } }
      }
      down = null;
    };
    cv.onpointerleave = () => { hover = null; hooks.onHover && hooks.onHover(null); };
    cv.ondblclick = e => { const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, 2); };
    // Ctrl + wheel (or a trackpad pinch) zooms; a plain wheel still scrolls the page
    cv.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01)); }, { passive: false });
    cv.addEventListener('keydown', e => {
      const step = 60, km = { '+': 1.4, '=': 1.4, '-': 1 / 1.4, '_': 1 / 1.4 };
      if (km[e.key]) { zoomAt(W / 2, H / 2, km[e.key]); e.preventDefault(); }
      else if (e.key.startsWith('Arrow')) { ox += e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0; oy += e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0; draw(); e.preventDefault(); e.stopPropagation(); }
    });
    return hooks.fetchJSON('data/map/meta.json').then(m => { meta = m; loadLists(); draw(); });
  }

  return {
    init, draw, project,
    setSite(s) { site = s; if (!meta) return; const v = viewFor(s.lat); view = v; hooks.onView && hooks.onView(v); fit(); if (v !== 'G') centreOn(s.lat, s.lon, 500); else draw(); },
    setSunEarth(x) { sunEarth = x; draw(); },
    setView, setBase(b) { base = b; draw(); }, setShow(key, on) { show[key] = on; draw(); }, setOpacity(v) { opacity = v; draw(); },
    zoom(f) { zoomAt(W / 2, H / 2, f); }, fitAll() { fit(); draw(); }, zoomToSite() { if (site) { if (viewFor(site.lat) !== view) setView(viewFor(site.lat)); centreOn(site.lat, site.lon, view === 'G' ? 1500 : 120); } },
    goTo(lat, lon, spanKm) { const v = viewFor(lat); if (v !== view) setView(v); centreOn(lat, lon, spanKm); },
    setPin(p) { pin = p; draw(); }, search(q) { q = q.trim().toLowerCase(); if (!features || q.length < 2) return []; const a = [], b = []; for (const f of features) { const n = f[0].toLowerCase(); if (n.startsWith(q)) a.push(f); else if (n.includes(q)) b.push(f); if (a.length >= 8) break; } return a.concat(b).slice(0, 8); },
    get show() { return show; }, get view() { return view; },
  };
})();
