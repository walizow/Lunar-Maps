// =============================================================================
// pov.js - the lander's point of view (WebGL2).
//
// A first-person picture from the top of the mast. For every pixel the shader
// sends a ray out from the lander and walks along it ("ray marching") until it
// either goes below the terrain (a hit: that pixel shows ground) or climbs
// clear of the highest mountains (a miss: that pixel shows sky).
//   Terrain near the lander comes from a per-site tile (80 m cells); beyond
//   the tile it comes from the same coarser grids the 3D map uses.
//   Ground pixels are lit by the Sun at the current time, and a second march
//   toward the Sun decides whether each one is in shadow.
//   Sky pixels show the Sun and the Earth at their true positions and sizes
//   (Earth with its phase), and stars.
// The curvature of the Moon is included: all geometry is done in kilometres
// from the Moon's centre, in a frame whose axes are east, north and up at the site.
// =============================================================================
const Pov = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, R_KM = 1737.4;
  let gl, cv, ov, prog, hooks, ready = false, failed = null, pending = false;
  const cam = { az: 0, el: 2, fov: 28 };                   // looking direction (compass bearing, elevation) and vertical field of view
  const opt = { names: true, skyline: false, stars: true };
  let site = null, mast = 2, sun = null, earth = null, starSpin = 0, tile = null, features = [], mask = null;
  const tex = {};
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  const VS = `#version 300 es
in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform vec3 uF, uR, uUp;          // camera: forward, right, up (east-north-up frame)
uniform float uTanH;               // tan(half the vertical field of view)
uniform vec3 uE, uN, uU;           // the site's east, north and up directions in the Moon frame
uniform float uSiteH, uMast;       // km
uniform vec3 uSun, uEarth;         // directions to Sun and Earth (east-north-up frame)
uniform float uSunR, uEarthR;      // angular radii, radians
uniform float uTileKm, uTileN;     // width of the close-range tile in km, and its number of cells per side
uniform float uStarSpin; uniform bool uStars;
uniform sampler2D uNear, uHG, uHS, uHN;
const float PI = 3.14159265, R = 1737.4, POLE_KM = 457.44;

vec2 eqUV(vec3 d) { return vec2(atan(d.y, d.x) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / PI); }
vec2 polUV(vec3 d, float s) {
  float colat = atan(length(d.xy), s * d.z), rho = 2.0 * R * tan(colat * 0.5) / POLE_KM;
  vec2 h = normalize(d.xy + vec2(1e-9, 0.0));
  return vec2(0.5 + 0.5 * rho * h.y, 0.5 + 0.5 * rho * h.x * s);
}
// far terrain: global grid, replaced by the sharper polar grid beyond about 76 deg latitude
float farKm(vec3 d) {
  float w = smoothstep(sin(radians(75.5)), sin(radians(77.5)), abs(d.z)), hg = texture(uHG, eqUV(d)).r;
  if (w <= 0.0) return hg;
  return mix(hg, d.z < 0.0 ? texture(uHS, polUV(d, -1.0)).r : texture(uHN, polUV(d, 1.0)).r, w);
}
// Points are kept in a LOCAL frame: kilometres east, north and up from the camera.
// (Using coordinates measured from the Moon's centre, about 1739 km away, would leave 32-bit
// numbers accurate only to ~12 cm, which shows up as stair-steps in ground seen at a grazing angle.)
float R0() { return R + uSiteH + uMast; }                        // camera's distance from the Moon's centre
// Height of a local point above the reference sphere, computed without subtracting two huge numbers:
// r - R0 = (r^2 - R0^2) / (r + R0), and r^2 - R0^2 expands to small terms only.
float altKm(vec3 q) {
  float r = length(vec3(q.xy, R0() + q.z));
  return uSiteH + uMast + (dot(q.xy, q.xy) + q.z * q.z + 2.0 * R0() * q.z) / (r + R0());
}
// Terrain height (km above the reference sphere) under local point q.
float terrainKm(vec3 q) {
  float zc = R0() + q.z, r = length(vec3(q.xy, zc));
  float ground = R * atan(length(q.xy), zc);                      // distance along the ground from the site (atan stays accurate at short range)
  vec2 dir = normalize(q.xy + vec2(1e-9, 0.0));
  vec2 en = ground * dir;                                         // east and north offsets on the local map
  vec2 t = abs(en) / (0.5 * uTileKm);
  float wNear = 1.0 - smoothstep(0.8, 0.98, max(t.x, t.y));       // 1 inside the tile, fading to 0 at its edge
  float h = 0.0;
  if (wNear < 1.0) h = farKm((q.x * uE + q.y * uN + zc * uU) / r);
  if (wNear > 0.0) {
    // Smooth the blend between neighbouring cells (instead of straight-line blending), so the
    // 80 m cells do not show up as flat facets with sharp creases when seen at a grazing angle.
    vec2 st = vec2(0.5 + en.x / uTileKm, 0.5 - en.y / uTileKm) * uTileN - 0.5, i = floor(st), f = fract(st);
    f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    h = mix(h, texture(uNear, (i + f + 0.5) / uTileN).r + uSiteH, wNear);
  }
  return h;
}
// Smooth random pattern (value noise), used only to give the ground a fine, illustrative texture:
// the real elevation data has 80 m cells, so anything smaller than that is not measured.
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i), hash2(i + vec2(0.0, 1.0)), f.x) * 0.0 + mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y); }
float bumps(vec2 m) { return 0.5 * noise(m / 4.0) + 0.3 * noise(m / 17.0) + 0.2 * noise(m / 60.0); }     // m in metres: ripples of about 4, 17 and 60 m
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

void main() {
  vec2 p = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 D = normalize(uF + uR * p.x * uTanH * uRes.x / uRes.y + uUp * p.y * uTanH);

  // ---- walk along the ray until it dips below the terrain
  // Step size adapts to how far the ray is above the ground: rays skimming the surface take
  // small steps (so thin ridges are not jumped over), rays high above it take long ones.
  float t = 0.03, tPrev = 0.0; bool hit = false;
  for (int i = 0; i < 520; i++) {
    vec3 q = D * t; float alt = altKm(q), clear = alt - terrainKm(q);
    if (clear < 0.0) { hit = true; break; }
    if (alt > 9.5 && D.z + t / R > 0.0) break;                    // above every mountain and still climbing: it is sky
    if (t > 420.0) break;
    tPrev = t; t += max(max(0.02, t * 0.004), min(clear * 3.0, t * 0.03 + 0.05));
  }
  vec3 col;
  if (hit) {
    // narrow down the exact hit distance by halving the last step a few times
    float a = tPrev, b = t;
    for (int i = 0; i < 9; i++) { float m = 0.5 * (a + b); vec3 q = D * m; if (altKm(q) < terrainKm(q)) b = m; else a = m; }
    t = b; vec3 q = D * t; vec3 up = normalize(vec3(q.xy, R0() + q.z));
    // slope of the ground at the hit point -> surface normal
    vec3 ta = normalize(cross(vec3(0.0, 1.0, 0.0), up)), tb = cross(up, ta);
    float e = max(0.04, t * 0.004);
    float da = (terrainKm(q + ta * e) - terrainKm(q - ta * e)) / (2.0 * e), db = (terrainKm(q + tb * e) - terrainKm(q - tb * e)) / (2.0 * e);
    // fine texture, fading out with distance (beyond a few km it would be smaller than a pixel)
    vec2 m = (q.xy) * 1000.0; float fade = 1.0 / (1.0 + t * 0.8), k = 0.012 * fade;
    da += k * (bumps(m + vec2(2.0, 0.0)) - bumps(m - vec2(2.0, 0.0))) * 6.0; db += k * (bumps(m + vec2(0.0, 2.0)) - bumps(m - vec2(0.0, 2.0))) * 6.0;
    vec3 nrm = normalize(up - ta * da - tb * db);
    float lambert = max(dot(nrm, uSun), 0.0), shadow = 1.0;
    if (lambert > 0.0) {
      // Second march, from the ground toward the Sun. Track how closely the ray clears the terrain,
      // measured against the Sun's apparent size: a near miss means part of the Sun's disc is
      // covered, which gives soft shadow edges instead of hard ones.
      vec3 s0 = q + up * 0.004; float s = max(0.08, t * 0.01);
      for (int i = 0; i < 56; i++) {
        vec3 w = s0 + uSun * s; float aw = altKm(w), clear = aw - terrainKm(w);
        shadow = min(shadow, clear / (s * 2.0 * uSunR) + 0.5);
        if (shadow <= 0.0 || aw > 9.5) break;
        s *= 1.16;
      }
      shadow = clamp(shadow, 0.0, 1.0);
    }
    // Auto-exposure: with the Sun a degree or two up, level ground receives only a few percent of
    // full sunlight. Scale so level ground comes out mid-grey, then compress highlights softly.
    float sunEl = asin(clamp(uSun.z, -1.0, 1.0));
    float expo = 0.55 / max(sin(max(sunEl, 0.0) + 0.012), 0.02);
    float light = lambert * shadow * expo * 0.9;
    float tone = 1.0 - exp(-1.6 * light);
    // faint fill light so shadowed ground is a dark silhouette rather than pure black (earthshine and glow from lit slopes)
    float grain = 0.9 + 0.2 * noise(q.xy * 1000.0 / 1.5);
    col = vec3(0.045, 0.047, 0.052) + vec3(0.78, 0.76, 0.72) * tone * grain;
  } else {
    col = vec3(0.0);
    // stars: a sparse random sprinkle fixed to the sky (illustrative, not a real catalogue)
    if (uStars) {
      vec3 b = D.x * uE + D.y * uN + D.z * uU; float c = cos(uStarSpin), s = sin(uStarSpin);
      b = vec3(c * b.x + s * b.y, -s * b.x + c * b.y, b.z);
      vec3 g = b * 260.0, cell = floor(g); float h = hash(cell);
      if (h > 0.985) { float dd = length(fract(g) - 0.5); col += vec3(0.9, 0.93, 1.0) * smoothstep(0.22, 0.0, dd) * (h - 0.985) * 60.0; }
    }
    // the Sun: a disc of its true angular size, with a soft glow
    float as = acos(clamp(dot(D, uSun), -1.0, 1.0));
    col += vec3(1.0, 0.95, 0.82) * 0.55 * exp(-as / (uSunR * 6.0));
    if (as < uSunR) col = vec3(1.0, 0.98, 0.92);
    // the Earth: a disc lit from the Sun's side (its phase)
    float ae = acos(clamp(dot(D, uEarth), -1.0, 1.0));
    if (ae < uEarthR) {
      vec3 off = (D - uEarth * dot(D, uEarth)) / sin(uEarthR);           // position across the disc, length 0..1
      float z = sqrt(max(0.0, 1.0 - dot(off, off)));
      vec3 n = normalize(off - uEarth * z);                              // surface normal on Earth's near side
      float day = smoothstep(-0.05, 0.25, dot(n, uSun));
      float cloud = hash(floor((off + 3.0) * 9.0)) * 0.35;
      col = mix(vec3(0.015, 0.03, 0.06), mix(vec3(0.16, 0.36, 0.72), vec3(0.95), cloud), day) * (0.35 + 0.65 * z);
    }
  }
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.9)), 1.0);
}`;

  // ------------------------------------------------------------ setup
  function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function floatTexture(key, w, h, data, repeatX) {
    const t = tex[key] || (tex[key] = gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatX ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  async function gridTexture(key, file, repeatX) {
    const j = await hooks.fetchJSON('data/' + file), z = await Terrain.decodeGrid(j), f = new Float32Array(z.length);
    for (let i = 0; i < z.length; i++) f[i] = z[i] / 1000;
    floatTexture(key, j.w, j.h, f, repeatX);
  }
  // Close-range tile for the current site. Presets have one precomputed from the 80 m data;
  // for a custom site it is built here from the coarser grids already in the browser.
  async function loadTile(s) {
    let n, spacing, f;
    if (s.custom) {
      n = 256; spacing = Math.abs(s.lat) > 75.1 ? 400 : 7600; f = new Float32Array(n * n); const c = (n - 1) / 2;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const e = (j - c) * spacing, no = (c - i) * spacing, d = Astro.destination(s.lat, s.lon, Math.atan2(e, no) * R2D, Math.hypot(e, no) / 1000);
        f[i * n + j] = (Terrain.height(d.lat, d.lon) - s.h) / 1000;
      }
    } else {
      const j = await hooks.fetchJSON('data/pov/' + s.id + '.json'), z = await Terrain.decodeGrid(j);
      n = j.n; spacing = j.spacing_m; f = new Float32Array(z.length); for (let i = 0; i < z.length; i++) f[i] = z[i] / 1000;
    }
    floatTexture('near', n, n, f); tile = { km: n * spacing / 1000, spacing, n };
  }

  async function init(canvas, overlayCanvas, h) {
    cv = canvas; ov = overlayCanvas; hooks = h;
    gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) { failed = 'This browser or device does not offer WebGL2, which the lander view needs. The sky view above shows the same Sun, Earth and skyline as a chart.'; hooks.onStatus(failed); return; }
    try {
      prog = gl.createProgram(); gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      hooks.onStatus('Loading terrain for the lander view…');
      await Promise.all([gridTexture('hG', 'globe_G.json', true), gridTexture('hS', 'globe_S.json'), gridTexture('hN', 'globe_N.json'), loadTile(site)]);
      features = await hooks.fetchJSON('data/map/features.json');
      ready = true; hooks.onStatus(''); wire(); render();
    } catch (e) { failed = 'The lander view could not start (' + e.message + ').'; hooks.onStatus(failed); }
  }

  // ------------------------------------------------------------ camera
  const dirOf = (az, el) => [Math.cos(el * D2R) * Math.sin(az * D2R), Math.cos(el * D2R) * Math.cos(az * D2R), Math.sin(el * D2R)];   // east, north, up
  function camVectors() {
    const f = dirOf(cam.az, cam.el), r = [Math.cos(cam.az * D2R), -Math.sin(cam.az * D2R), 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { f, r, u };
  }
  // (bearing, elevation) -> position on the canvas in CSS pixels, or null if behind the camera
  function project(az, el) {
    const { f, r, u } = camVectors(), d = dirOf(az, el), z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]; if (z < 0.05) return null;
    const b = cv.getBoundingClientRect(), th = Math.tan(cam.fov * D2R / 2);
    const x = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / (th * b.width / b.height), y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / th;
    return [(x + 1) / 2 * b.width, (1 - y) / 2 * b.height];
  }
  function unproject(sx, sy) {
    const { f, r, u } = camVectors(), b = cv.getBoundingClientRect(), th = Math.tan(cam.fov * D2R / 2);
    const x = (sx / b.width * 2 - 1) * th * b.width / b.height, y = (1 - sy / b.height * 2) * th;
    const d = [0, 1, 2].map(i => f[i] + r[i] * x + u[i] * y), n = Math.hypot(d[0], d[1], d[2]);
    return { az: Astro.norm(Math.atan2(d[0], d[1]) * R2D), el: Math.asin(d[2] / n) * R2D };
  }

  // ------------------------------------------------------------ drawing
  function render() { if (!ready || pending) return; pending = true; requestAnimationFrame(() => { pending = false; drawGL(); drawOverlay(); }); }
  function drawGL() {
    const b = cv.getBoundingClientRect(); if (!b.width || !sun) return;
    // The picture is computed at slightly reduced resolution: each pixel costs hundreds of terrain look-ups.
    const sc = Math.min(1, 900 / b.width), w = Math.round(b.width * sc), h = Math.round(b.height * sc);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h); gl.useProgram(prog);
    const U = n => gl.getUniformLocation(prog, n), { f, r, u } = camVectors();
    const p = site.lat * D2R, l = site.lon * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    gl.uniform2f(U('uRes'), w, h); gl.uniform3fv(U('uF'), f); gl.uniform3fv(U('uR'), r); gl.uniform3fv(U('uUp'), u); gl.uniform1f(U('uTanH'), Math.tan(cam.fov * D2R / 2));
    gl.uniform3f(U('uE'), -sl, cl, 0); gl.uniform3f(U('uN'), -sp * cl, -sp * sl, cp); gl.uniform3f(U('uU'), cp * cl, cp * sl, sp);
    gl.uniform1f(U('uSiteH'), site.h / 1000); gl.uniform1f(U('uMast'), mast / 1000); gl.uniform1f(U('uTileKm'), tile.km); gl.uniform1f(U('uTileN'), tile.n);
    gl.uniform3fv(U('uSun'), dirOf(sun.az, sun.el)); gl.uniform3fv(U('uEarth'), dirOf(earth.az, earth.el));
    gl.uniform1f(U('uSunR'), sun.radius * D2R); gl.uniform1f(U('uEarthR'), earth.radius * D2R);
    gl.uniform1f(U('uStarSpin'), starSpin * D2R); gl.uniform1i(U('uStars'), opt.stars ? 1 : 0);
    [['uNear', 'near'], ['uHG', 'hG'], ['uHS', 'hS'], ['uHN', 'hN']].forEach(([un, k], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[k]); gl.uniform1i(U(un), i); });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function drawOverlay() {
    const b = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(b.width * dpr) || ov.height !== Math.round(b.height * dpr)) { ov.width = Math.round(b.width * dpr); ov.height = Math.round(b.height * dpr); }
    const c = ov.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, b.width, b.height);
    if (!sun) return;
    c.textBaseline = 'middle'; c.textAlign = 'center';
    const text = (s, x, y, col) => { c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.8)'; c.strokeText(s, x, y); c.fillStyle = col; c.fillText(s, x, y); };
    const inView = p => p && p[0] > -40 && p[0] < b.width + 40 && p[1] > -40 && p[1] < b.height + 40;
    // the precomputed skyline (the one used for all the numbers), as a cross-check on the 3D terrain
    if (opt.skyline && mask) { c.strokeStyle = 'rgba(80,220,255,.9)'; c.lineWidth = 1.2; c.beginPath(); let pen = false;
      for (let a = cam.az - 100; a <= cam.az + 100; a += 0.5) { const p = project(a, Engine.maskAt(mask, a)); if (!inView(p)) { pen = false; continue; } pen ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); pen = true; } c.stroke(); }
    // Sun and Earth markers (so they can be found when small, or located when hidden behind terrain)
    c.font = '600 12px ' + css('--font');
    for (const [body, col, name] of [[sun, css('--sun'), 'Sun'], [earth, css('--earth'), 'Earth']]) { const p = project(body.az, body.el); if (!inView(p)) continue;
      const rr = Math.max(8, body.radius * D2R / Math.tan(cam.fov * D2R / 2) * b.height / 2 + 6);
      c.strokeStyle = col; c.lineWidth = 1.5; c.setLineDash(body.up ? [] : [4, 4]); c.beginPath(); c.arc(p[0], p[1], rr, 0, 7); c.stroke(); c.setLineDash([]);
      text(name + (body.up ? '' : ' (behind terrain)'), p[0], p[1] - rr - 10, col); }
    // names of features in view, hung just above the skyline in their direction
    if (opt.names && mask) { c.font = '11.5px ' + css('--font'); const taken = []; let n = 0;
      for (const ft of features) { if (n >= 14) break;
        const dLat = (ft[1] - site.lat) * D2R, cosd = Math.sin(site.lat * D2R) * Math.sin(ft[1] * D2R) + Math.cos(site.lat * D2R) * Math.cos(ft[1] * D2R) * Math.cos((ft[2] - site.lon) * D2R);
        const dist = Math.acos(Math.max(-1, Math.min(1, cosd))) * R_KM; if (dist > 320 || dist < 3 || ft[3] / dist < 0.12) continue;      // near enough and big enough to pick out
        const az = Astro.norm(Math.atan2(Math.sin((ft[2] - site.lon) * D2R) * Math.cos(ft[1] * D2R), Math.cos(site.lat * D2R) * Math.sin(ft[1] * D2R) - Math.sin(site.lat * D2R) * Math.cos(ft[1] * D2R) * Math.cos((ft[2] - site.lon) * D2R)) * R2D);
        const p = project(az, Engine.maskAt(mask, az)); if (!inView(p) || p[0] < 30 || p[0] > b.width - 30) continue;
        const label = `${ft[0]} · ${Math.round(dist)} km`, w = c.measureText(label).width / 2 + 4; let y = p[1] - 26;
        while (taken.some(q => Math.abs(q[0] - p[0]) < q[2] + w && Math.abs(q[1] - y) < 14) && y > 20) y -= 15;
        taken.push([p[0], y, w]); c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.beginPath(); c.moveTo(p[0], p[1] - 3); c.lineTo(p[0], y + 8); c.stroke(); text(label, p[0], y, '#f3f6fa'); n++; } }
    // compass strip along the bottom
    c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(0, b.height - 24, b.width, 24); c.font = '11px ' + css('--mono');
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }, stepA = cam.fov > 50 ? 15 : cam.fov > 20 ? 5 : 1;
    for (let a = 0; a < 360; a += stepA) { const p = project(a, cam.el); if (!p || p[0] < 0 || p[0] > b.width) continue;
      c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.moveTo(p[0], b.height - 24); c.lineTo(p[0], b.height - (names[a] ? 17 : 20)); c.stroke(); c.fillStyle = names[a] ? '#fff' : 'rgba(255,255,255,.7)'; c.fillText(names[a] || a + '°', p[0], b.height - 9); }
    // level line (0 deg elevation) tick marks at the sides
    const pz = project(cam.az, 0); if (pz && pz[1] > 0 && pz[1] < b.height - 24) { c.strokeStyle = 'rgba(255,255,255,.6)'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, pz[1]); c.lineTo(26, pz[1]); c.moveTo(b.width - 26, pz[1]); c.lineTo(b.width, pz[1]); c.stroke(); c.setLineDash([]); c.textAlign = 'left'; c.fillStyle = 'rgba(255,255,255,.8)'; c.fillText('level 0°', 30, pz[1]); c.textAlign = 'center'; }
    drawInset(c, b);
  }
  // Small compass in the corner: which way the camera faces, and where the Sun and Earth are.
  function drawInset(c, b) {
    const cx = b.width - 62, cy = 62, r = 44;
    c.fillStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.arc(cx, cy, r + 10, 0, 7); c.fill(); c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
    const half = Math.atan(Math.tan(cam.fov * D2R / 2) * b.width / b.height), a0 = cam.az * D2R - Math.PI / 2;
    c.fillStyle = 'rgba(255,255,255,.28)'; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, a0 - half, a0 + half); c.closePath(); c.fill();       // the wedge the camera sees
    c.font = '600 10px ' + css('--font'); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [a, n] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) c.fillText(n, cx + (r + 5) * Math.sin(a * D2R), cy - (r + 5) * Math.cos(a * D2R));
    for (const [body, col] of [[sun, css('--sun')], [earth, css('--earth')]]) { const x = cx + (r - 7) * Math.sin(body.az * D2R), y = cy - (r - 7) * Math.cos(body.az * D2R); c.fillStyle = col; c.beginPath(); c.arc(x, y, 4.5, 0, 7); c.fill(); }
  }

  // ------------------------------------------------------------ interaction
  let flyId = 0;
  function lookAt(az, el) {
    const from = { az: cam.az, el: cam.el }, da = ((az - from.az + 540) % 360) - 180, id = ++flyId, t0 = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cam.az = Astro.norm(az); cam.el = el; render(); return; }
    const step = tn => { if (id !== flyId) return; const u = Math.min(1, (tn - t0) / 700), e = u * u * (3 - 2 * u); cam.az = Astro.norm(from.az + da * e); cam.el = from.el + (el - from.el) * e; drawGL(); drawOverlay(); if (u < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function zoomBy(f) { cam.fov = Math.max(3, Math.min(100, cam.fov / f)); hooks.onView(cam); render(); }
  function wire() {
    let down = null;
    cv.onpointerdown = e => { down = [e.clientX, e.clientY, cam.az, cam.el]; flyId++; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => {
      const b = cv.getBoundingClientRect();
      if (down) { const k = cam.fov / b.height; cam.az = Astro.norm(down[2] - (e.clientX - down[0]) * k); cam.el = Math.max(-60, Math.min(89, down[3] + (e.clientY - down[1]) * k)); hooks.onView(cam); render(); }
      hooks.onHover(unproject(e.clientX - b.left, e.clientY - b.top));
    };
    cv.onpointerup = () => { down = null; };
    cv.onpointerleave = () => hooks.onHover(null);
    cv.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.01)); }, { passive: false });
    cv.addEventListener('keydown', e => { const st = cam.fov / 8;
      if (e.key === '+' || e.key === '=') zoomBy(1.3); else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.3);
      else if (e.key === 'ArrowLeft') cam.az = Astro.norm(cam.az - st); else if (e.key === 'ArrowRight') cam.az = Astro.norm(cam.az + st); else if (e.key === 'ArrowUp') cam.el = Math.min(89, cam.el + st); else if (e.key === 'ArrowDown') cam.el = Math.max(-60, cam.el - st); else return;
      e.preventDefault(); e.stopPropagation(); hooks.onView(cam); render(); });
  }

  return {
    init, render, lookAt, zoomBy,
    get ready() { return ready; }, get cam() { return cam; },
    startAt(s, m, mk) { site = s; mast = m; mask = mk; },
    async setSite(s, mk) { site = s; mask = mk; if (!ready) return; hooks.onStatus('Loading terrain for this site…'); try { await loadTile(s); hooks.onStatus(''); } catch (e) { hooks.onStatus('Terrain for this site could not be loaded (' + e.message + ').'); } render(); },
    setMast(m, mk) { mast = m; mask = mk; render(); },
    // sun / earth: { az, el, radius, up } in degrees; spin: slow turn of the star field (degrees)
    setSky(s, e, spin) { const first = !sun; sun = s; earth = e; starSpin = spin; if (first && ready) { cam.az = s.up ? s.az : e.az; cam.el = 3; } render(); },
    face(which) { const b = which === 'sun' ? sun : earth; if (b) lookAt(b.az, Math.max(-20, Math.min(60, b.el + (cam.fov > 30 ? 4 : 0)))); },
    setOption(k, v) { opt[k] = v; render(); },
  };
})();
