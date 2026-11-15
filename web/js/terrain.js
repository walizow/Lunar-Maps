// =============================================================================
// terrain.js - elevation grids in the browser, used ONLY for custom sites.
//
// Preset sites ship horizons computed in Python from the full 80 m data.
// For a custom site we load lighter grids (400 m near the poles, ~7.6 km
// elsewhere) and trace the horizon here. That is why custom-site results are
// labelled "approximate".
// =============================================================================
const Terrain = (() => {
  const R = 1737400, D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const grids = {};          // 'S', 'N', 'G' -> decoded grid
  const loading = {};        // promises, so each file is fetched once
  let fetchJSON = async (p) => (await fetch(p)).json();

  // base64 -> bytes -> gunzip (DecompressionStream is built into browsers)
  async function gunzipB64(b64) {
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  let fetchBytes = async (p) => new Uint8Array(await (await fetch(p)).arrayBuffer());
  async function inflate(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()); }

  // Read the raw bytes stored in one of our greyscale PNG files.
  // The PNG is only a container, so it is unpacked by hand rather than drawn: that guarantees
  // every byte comes back exactly (drawing to a canvas can alter values on some screens).
  // A PNG is a series of chunks; the IDAT chunks hold compressed rows, each starting with a
  // "filter" byte saying how the row was predicted from its neighbours - undone below.
  async function readPng(path) {
    const b = await fetchBytes(path), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), parts = [];
    let w = 0, h = 0, o = 8, len = 0;
    while (o < b.length) {
      const n = dv.getUint32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); if (b[o + 16] !== 8 || b[o + 17] !== 0) throw new Error('unexpected PNG format in ' + path); }
      else if (type === 'IDAT') { parts.push(b.subarray(o + 8, o + 8 + n)); len += n; }
      o += 12 + n;
    }
    const z = new Uint8Array(len); let k = 0; for (const p of parts) { z.set(p, k); k += p.length; }
    const raw = await inflate(z), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (w + 1)], src = y * (w + 1) + 1, dst = y * w;
      for (let x = 0; x < w; x++) {
        const a = x ? out[dst + x - 1] : 0, up = y ? out[dst - w + x] : 0, c = x && y ? out[dst - w + x - 1] : 0;
        let pr = 0;
        if (f === 1) pr = a; else if (f === 2) pr = up; else if (f === 3) pr = (a + up) >> 1;
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        out[dst + x] = (raw[src + x] + pr) & 255;
      }
    }
    return out;
  }

  // Reverse of pack_png() in pipeline/common.py:
  // low-byte plane + high-byte plane -> residuals -> add back the predictor.
  function unpack(bytes, w, h) {
    const n = w * h, z = new Int16Array(n);
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const k = i * w + j;
      const res = bytes[k] | (bytes[n + k] << 8);
      const left = j > 0 ? z[k - 1] : 0, up = i > 0 ? z[k - w] : 0, ul = (i > 0 && j > 0) ? z[k - w - 1] : 0;
      z[k] = res + left + up - ul;      // Int16Array wraps the same way the encoder did
    }
    return z;
  }

  function load(key) {
    if (!loading[key]) loading[key] = (async () => {
      // polar caps have their own 400 m grids; everywhere else reuses the 3D map's global grid
      const j = await fetchJSON(key === 'G' ? 'data/globe_G.json' : 'data/terrain_' + key + '.json');
      grids[key] = Object.assign({}, j, { z: await decodeGrid(j) });
    })();
    return loading[key];
  }
  // Load what a site at this latitude needs (its polar cap, plus the global grid).
  async function ensureFor(lat) {
    const need = [load('G')];
    if (lat < -74) need.push(load('S'));
    if (lat > 74) need.push(load('N'));
    await Promise.all(need);
  }

  function bilinear(g, y, x, wrap) {
    let x0 = Math.floor(x), y0 = Math.floor(y);
    if (y0 < 0) { y0 = 0; y = 0; } if (y0 > g.h - 2) { y0 = g.h - 2; y = g.h - 1; }
    const fy = y - y0;
    let x1, fx;
    if (wrap) { fx = x - x0; x0 = ((x0 % g.w) + g.w) % g.w; x1 = (x0 + 1) % g.w; }
    else { if (x0 < 0) { x0 = 0; x = 0; } if (x0 > g.w - 2) { x0 = g.w - 2; x = g.w - 1; } fx = x - x0; x1 = x0 + 1; }
    const z = g.z, a = y0 * g.w, b = a + g.w;
    return (z[a + x0] * (1 - fx) + z[a + x1] * fx) * (1 - fy) + (z[b + x0] * (1 - fx) + z[b + x1] * fx) * fy;
  }

  // Height in metres above the 1737.4 km sphere.
  function height(lat, lon) {
    const key = lat < -75.05 ? 'S' : lat > 75.05 ? 'N' : null;
    if (key && grids[key]) {
      const g = grids[key];
      // polar stereographic: rho = distance from the pole on the map, in pixels
      const rho = 2 * R * Math.tan((90 - Math.abs(lat)) * D2R / 2) / g.scale;
      const sample = g.centre + rho * Math.sin(lon * D2R);
      const line = g.south ? g.centre - rho * Math.cos(lon * D2R) : g.centre + rho * Math.cos(lon * D2R);
      return bilinear(g, line, sample, false);
    }
    const g = grids.G;                                   // global grid: columns run from 180 W to 180 E
    const lo = (((lon + 180) % 360) + 360) % 360;
    return bilinear(g, (90 - lat) * g.ppd - 0.5, lo * g.ppd - 0.5, true);
  }

  // Horizon mask for a custom site: for 720 compass directions, the steepest
  // upward angle to any terrain along that direction (same maths as Python).
  function horizon(lat, lon, mastM) {
    const polar = Math.abs(lat) > 75.1;
    // 600 m / 1.5 km start: on these coarse grids, closer samples are just the
    // smoothed slope under the lander and would block the sky falsely.
    const start = polar ? 600 : 1500, cell = polar ? 400 : 7600, end = polar ? 300e3 : 600e3;
    const hSite = height(lat, lon), r0 = R + hSite + mastM;
    const p1 = lat * D2R, l1 = lon * D2R, sp = Math.sin(p1), cp = Math.cos(p1);
    const mask = new Float32Array(720);
    for (let k = 0; k < 720; k++) {
      const b = k * 0.5 * D2R, sb = Math.sin(b), cb = Math.cos(b);
      let best = -90;
      for (let d = start; d <= end; d += Math.max(cell, 0.005 * d)) {
        const th = d / R, st = Math.sin(th), ct = Math.cos(th);
        const p2 = Math.asin(Math.max(-1, Math.min(1, sp * ct + cp * st * cb)));
        const l2 = l1 + Math.atan2(sb * st * cp, ct - sp * Math.sin(p2));
        const r = R + height(p2 * R2D, l2 * R2D);
        const el = Math.atan2(r * ct - r0, r * st) * R2D;
        if (el > best) best = el;
      }
      mask[k] = best;
    }
    return { mask, h: hSite };
  }

  // Decode any packed grid file (used by the 3D globe for its own, coarser grids).
  async function decodeGrid(j) { return unpack(j.file ? await readPng('data/' + j.file) : await gunzipB64(j.data), j.w, j.h); }

  return { ensureFor, height, horizon, gunzipB64, decodeGrid, setFetch: (f, fb) => { fetchJSON = f; if (fb) fetchBytes = fb; } };
})();
if (typeof module !== 'undefined') module.exports = Terrain;
