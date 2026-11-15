// =============================================================================
// globe.js - the 3D Moon explorer (WebGL2).
//
// How it draws: there are no triangles. For every pixel the shader asks "does
// a ray through this pixel hit the Moon's sphere, and where?" (ray tracing).
// The hit point gives a latitude and longitude, which is looked up in the same
// pictures the 2D map uses. Heights are stored as number textures and used for
//   - shading: the slope at the point decides how directly sunlight hits it;
//   - cast shadows: step from the point toward the Sun and check whether any
//     terrain along the way rises above the line of sight.
// Near the poles the shader switches from the global (longitude/latitude)
// pictures to the polar-stereographic ones, which are sharp there.
//
// Labels, site markers and region outlines are drawn on an ordinary 2D canvas
// laid on top of the WebGL canvas.
// =============================================================================
const Globe = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  let gl, cv, ov, prog, hooks, ready = false, failed = null, pending = false;
  const cam = { lat: -80, lon: 0, zoom: 1 };               // view centre and zoom (1 = whole Moon fits)
  const opt = { base: 'wac', light: true, sun: false, earth: false, psr: true, regions: true, objects: true, names: true, grid: true, sites: true, opacity: 0.65 };
  let sunDir = [1, 0, 0], subSun = null, subEarth = null, site = null, pin = null, features = [], objects = [];
  const tex = {};                                          // WebGL textures by name
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ------------------------------------------------------------ shaders
  const VS = `#version 300 es
in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;            // canvas size in pixels
uniform float uRadius;        // Moon radius on screen, in pixels
uniform mat3 uRot;            // view frame -> Moon frame
uniform vec3 uSun;            // direction to the Sun in the Moon frame
uniform bool uLight, uShowSun, uShowEarth, uShowPsr, uGrid;
uniform float uOpacity;
uniform sampler2D uBaseG, uBaseS, uBaseN;      // pictures: global, south polar, north polar
uniform sampler2D uHG, uHS, uHN;               // heights in km
uniform sampler2D uSunS, uSunN, uEarthS, uEarthN, uPsrS, uPsrN;
const float PI = 3.14159265, R = 1737.4, POLE_KM = 457.44;

// longitude/latitude picture: u runs -180..180 deg, v runs +90..-90 deg
vec2 eqUV(vec3 d) { return vec2(atan(d.y, d.x) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.z, -1.0, 1.0)) / PI); }
// polar stereographic picture (s = -1 south, +1 north); matches the LOLA convention:
// 0 deg longitude points up on the south map and down on the north map, 90 deg E to the right
vec2 polUV(vec3 d, float s) {
  float colat = atan(length(d.xy), s * d.z), rho = 2.0 * R * tan(colat * 0.5) / POLE_KM;
  vec2 h = normalize(d.xy + vec2(1e-9, 0.0));               // (cos lon, sin lon)
  return vec2(0.5 + 0.5 * rho * h.y, 0.5 + 0.5 * rho * h.x * s);
}
// how much to trust the polar pictures: 0 below 75.5 deg latitude, 1 above 77.5 deg
float polarW(vec3 d) { return smoothstep(sin(radians(75.5)), sin(radians(77.5)), abs(d.z)); }
float heightKm(vec3 d) {
  float w = polarW(d), hg = texture(uHG, eqUV(d)).r;
  if (w <= 0.0) return hg;
  float hp = d.z < 0.0 ? texture(uHS, polUV(d, -1.0)).r : texture(uHN, polUV(d, 1.0)).r;
  return mix(hg, hp, w);
}
vec3 ramp(vec3 a, vec3 b, vec3 c, vec3 d4, vec3 e, float f) {
  f = clamp(f, 0.0, 1.0) * 4.0;
  return f < 1.0 ? mix(a, b, f) : f < 2.0 ? mix(b, c, f - 1.0) : f < 3.0 ? mix(c, d4, f - 2.0) : mix(d4, e, f - 3.0);
}
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRadius;        // position in Moon radii, centre of screen = 0
  float r2 = dot(p, p);
  if (r2 > 1.0) { outColor = vec4(0.012, 0.016, 0.027, 1.0); return; }      // space
  vec3 d = uRot * vec3(p, sqrt(1.0 - r2));                  // point on the sphere, Moon frame
  float w = polarW(d), sgn = d.z < 0.0 ? -1.0 : 1.0;
  vec2 pu = polUV(d, sgn);
  vec3 base = texture(uBaseG, eqUV(d)).rgb;
  if (w > 0.0) base = mix(base, d.z < 0.0 ? texture(uBaseS, pu).rgb : texture(uBaseN, pu).rgb, w);
  vec3 col = base;

  // data overlays (polar maps only)
  float lit = 1.0;
  if (w > 0.99) {
    if (uShowSun) { float v = (d.z < 0.0 ? texture(uSunS, pu) : texture(uSunN, pu)).r * 255.0;
      if (v < 254.5) col = mix(col, ramp(vec3(.08,.04,.16), vec3(.47,.12,.43), vec3(.86,.35,.24), vec3(.98,.71,.2), vec3(1.,.98,.75), v / 250.0), uOpacity); }
    if (uShowEarth) { float v = (d.z < 0.0 ? texture(uEarthS, pu) : texture(uEarthN, pu)).r * 255.0;
      if (v < 254.5) col = mix(col, ramp(vec3(.03,.08,.24), vec3(.08,.31,.59), vec3(.24,.59,.82), vec3(.59,.84,.94), vec3(.92,.98,1.), v / 250.0), uOpacity); }
    if (uShowPsr) { float v = (d.z < 0.0 ? texture(uPsrS, pu) : texture(uPsrN, pu)).r; col = mix(col, vec3(0.0, 0.82, 1.0), step(0.5, v) * min(1.0, uOpacity + 0.15)); }
  }

  // sunlight and cast shadows at the current time
  if (uLight) {
    float h0 = heightKm(d);
    // local east and north directions on the sphere
    vec3 e = normalize(cross(vec3(0.0, 0.0, 1.0), d) + vec3(1e-7, 0.0, 0.0)), n = cross(d, e);
    float eps = max(1.5 / uRadius, 0.0012);                 // sample spacing: about a screen pixel, at least ~2 km
    float de = (heightKm(normalize(d + e * eps)) - heightKm(normalize(d - e * eps))) / (2.0 * eps * R);
    float dn = (heightKm(normalize(d + n * eps)) - heightKm(normalize(d - n * eps))) / (2.0 * eps * R);
    vec3 nrm = normalize(d - 2.0 * (de * e + dn * n));      // surface normal (slopes exaggerated 2x so relief reads)
    float sunUp = dot(d, uSun), lambert = max(dot(nrm, uSun), 0.0);
    float shadow = 1.0;
    if (sunUp > -0.03 && lambert > 0.0) {
      // march toward the Sun; if terrain is higher than the ray, the point is in shadow
      vec3 q0 = d * (1.0 + (h0 + 0.03) / R); float s = eps * 0.8;
      for (int i = 0; i < 40; i++) {
        vec3 q = q0 + uSun * s; float rq = length(q);
        if (1.0 + heightKm(q / rq) / R > rq) { shadow = 0.0; break; }
        if (rq > 1.006) break;                              // above the highest mountains: nothing can block now
        s *= 1.18;
      }
    }
    lit = lambert * shadow * smoothstep(-0.01, 0.02, sunUp);
    // night side and shadows are dimmed, not hidden, so the data stays readable
    // Near the poles the Sun grazes the ground, so true brightness is only a few percent.
    // A soft tone curve (power 0.45) lifts those low values so polar terrain is readable.
    col *= 0.14 + 1.15 * pow(lit, 0.45);
  }

  // graticule: latitude circles every 10 deg; meridians thin out toward the poles so they do not crowd
  if (uGrid) {
    float lat = degrees(asin(clamp(d.z, -1.0, 1.0))), lon = degrees(atan(d.y, d.x));
    float stepLon = abs(lat) > 88.0 ? 90.0 : abs(lat) > 80.0 ? 30.0 : abs(lat) > 60.0 ? 15.0 : 10.0;
    float stepLat = uRadius > 2500.0 && abs(lat) > 78.0 ? 1.0 : 10.0;
    float fl = fwidth(lat), fo = min(fwidth(lon), 2.0) ;
    float a = 1.0 - smoothstep(0.0, 1.3 * fl, abs(fract(lat / stepLat + 0.5) - 0.5) * stepLat);
    float b = abs(lat) > 89.7 ? 0.0 : 1.0 - smoothstep(0.0, 1.3 * fo, abs(fract(lon / stepLon + 0.5) - 0.5) * stepLon);
    col = mix(col, vec3(1.0), 0.28 * max(a, b));
  }
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.25, sqrt(1.0 - r2)));          // slight darkening at the limb for a round look
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.92)), 1.0);
}`;

  // ------------------------------------------------------------ setup
  function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function loadImage(name) { return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('could not load ' + name)); im.src = 'data/map/' + name; }); }
  function imageTexture(key, im, repeatX) {
    const t = tex[key] || (tex[key] = gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatX ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  // heights as a 16-bit float texture, in km (smoothly interpolated by the GPU)
  async function heightTexture(key, file, repeatX) {
    const j = await hooks.fetchJSON('data/' + file), z = await Terrain.decodeGrid(j), f = new Float32Array(z.length);
    for (let i = 0; i < z.length; i++) f[i] = z[i] / 1000;
    const t = tex[key] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, j.w, j.h, 0, gl.RED, gl.FLOAT, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatX ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  async function loadBase(b) {
    const [g, s, n] = await Promise.all([loadImage('G_' + b + '.webp'), loadImage('S_' + b + '.webp'), loadImage('N_' + b + '.webp')]);
    imageTexture('baseG', g, true); imageTexture('baseS', s); imageTexture('baseN', n);
  }
  const overlayLoaded = {};
  async function loadOverlay(kind) {
    if (overlayLoaded[kind]) return; overlayLoaded[kind] = true;
    const [s, n] = await Promise.all([loadImage('S_' + kind + '.png'), loadImage('N_' + kind + '.png')]);
    imageTexture(kind + 'S', s); imageTexture(kind + 'N', n); render();
  }

  async function init(canvas, overlayCanvas, h) {
    cv = canvas; ov = overlayCanvas; hooks = h;
    gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) { failed = 'This browser or device does not offer WebGL2, which the 3D view needs. Everything else on the page still works; the 2D map shows the same layers.'; hooks.onStatus(failed); return; }
    try {
      prog = gl.createProgram(); gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);   // one rectangle covering the canvas
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      hooks.onStatus('Loading the 3D map (about 9 MB the first time)…');
      // 1x1 placeholders so the overlay samplers always have something bound
      for (const k of ['sunS', 'sunN', 'earthS', 'earthN', 'psrS', 'psrN']) { tex[k] = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex[k]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255])); }
      await Promise.all([loadBase(opt.base), heightTexture('hG', 'globe_G.json', true), heightTexture('hS', 'globe_S.json'), heightTexture('hN', 'globe_N.json')]);
      const [f, o] = await Promise.all([hooks.fetchJSON('data/map/features.json'), hooks.fetchJSON('data/map/objects.json')]); features = f; objects = o;
      ready = true; hooks.onStatus(''); if (opt.psr) loadOverlay('psr'); wire(); render();
    } catch (e) { failed = 'The 3D view could not start (' + e.message + ').'; hooks.onStatus(failed); }
  }

  // ------------------------------------------------------------ camera maths
  // Columns of the rotation: east, north and outward directions at the view centre.
  function rot() {
    const p = cam.lat * D2R, l = cam.lon * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    return { e: [-sl, cl, 0], n: [-sp * cl, -sp * sl, cp], u: [cp * cl, cp * sl, sp] };
  }
  const vec = (lat, lon) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function radiusPx() { const r = cv.getBoundingClientRect(); return Math.min(r.width, r.height) * 0.46 * cam.zoom; }
  // lat/lon -> screen position (CSS pixels), or null when on the far side
  function project(lat, lon) {
    const m = rot(), v = vec(lat, lon), z = dot(v, m.u); if (z < 0.02) return null;
    const r = cv.getBoundingClientRect(), R = radiusPx();
    return [r.width / 2 + dot(v, m.e) * R, r.height / 2 - dot(v, m.n) * R, z];
  }
  function unproject(sx, sy) {
    const r = cv.getBoundingClientRect(), R = radiusPx(), x = (sx - r.width / 2) / R, y = -(sy - r.height / 2) / R, r2 = x * x + y * y;
    if (r2 > 1) return null;
    const z = Math.sqrt(1 - r2), m = rot(), d = [0, 1, 2].map(i => x * m.e[i] + y * m.n[i] + z * m.u[i]);
    return [Math.asin(Math.max(-1, Math.min(1, d[2]))) * R2D, Math.atan2(d[1], d[0]) * R2D];
  }

  // ------------------------------------------------------------ drawing
  function render() { if (!ready || pending) return; pending = true; requestAnimationFrame(() => { pending = false; drawGL(); drawOverlay(); }); }
  function drawGL() {
    const r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2); if (!r.width) return;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h); gl.useProgram(prog);
    const m = rot(), U = n => gl.getUniformLocation(prog, n);
    gl.uniform2f(U('uRes'), w, h); gl.uniform1f(U('uRadius'), radiusPx() * dpr);
    gl.uniformMatrix3fv(U('uRot'), false, new Float32Array([...m.e, ...m.n, ...m.u]));       // columns: east, north, out
    gl.uniform3fv(U('uSun'), new Float32Array(sunDir));
    gl.uniform1i(U('uLight'), opt.light ? 1 : 0); gl.uniform1i(U('uShowSun'), opt.sun && overlayLoaded.sun ? 1 : 0); gl.uniform1i(U('uShowEarth'), opt.earth && overlayLoaded.earth ? 1 : 0);
    gl.uniform1i(U('uShowPsr'), opt.psr && overlayLoaded.psr ? 1 : 0); gl.uniform1i(U('uGrid'), opt.grid ? 1 : 0); gl.uniform1f(U('uOpacity'), opt.opacity);
    [['uBaseG', 'baseG'], ['uBaseS', 'baseS'], ['uBaseN', 'baseN'], ['uHG', 'hG'], ['uHS', 'hS'], ['uHN', 'hN'], ['uSunS', 'sunS'], ['uSunN', 'sunN'], ['uEarthS', 'earthS'], ['uEarthN', 'earthN'], ['uPsrS', 'psrS'], ['uPsrN', 'psrN']]
      .forEach(([u, k], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[k]); gl.uniform1i(U(u), i); });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function drawOverlay() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(r.width * dpr) || ov.height !== Math.round(r.height * dpr)) { ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr); }
    const c = ov.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height);
    c.textBaseline = 'middle'; c.textAlign = 'center';
    const text = (s, x, y, col) => { const ss = c.strokeStyle, lw = c.lineWidth; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.8)'; c.strokeText(s, x, y); c.fillStyle = col; c.fillText(s, x, y); c.strokeStyle = ss; c.lineWidth = lw; };
    const kmPerPx = 1737.4 / radiusPx();
    if (opt.regions) { c.strokeStyle = '#ffd34d'; c.lineWidth = 1.5; c.font = '600 11px ' + css('--font');
      for (const rg of hooks.regions()) { const pts = rg.ring.map(q => project(q[1], q[0])); if (pts.some(p => !p)) continue;
        c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.stroke();
        if (kmPerPx < 3) text(rg.code, pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length, '#ffd34d'); } }
    if (opt.names) { c.font = '11.5px ' + css('--font'); const taken = []; let n = 0;
      for (const f of features) { if (f[3] / kmPerPx < 30 || n > 60) break; const p = project(f[1], f[2]); if (!p || p[2] < 0.25) continue;
        if (p[0] < 0 || p[0] > r.width || p[1] < 0 || p[1] > r.height) continue;
        const w = c.measureText(f[0]).width / 2 + 3, box = [p[0] - w, p[1] - 8, p[0] + w, p[1] + 8];
        if (taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue; taken.push(box); text(f[0], p[0], p[1], '#f3f6fa'); n++; } }
    if (opt.objects) for (const o of objects) { const p = project(o[3], o[4]); if (!p) continue;
      c.fillStyle = '#ff9d5c'; c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.moveTo(p[0], p[1] - 4.5); c.lineTo(p[0] + 4.5, p[1]); c.lineTo(p[0], p[1] + 4.5); c.lineTo(p[0] - 4.5, p[1]); c.closePath(); c.fill(); c.stroke(); }
    if (opt.sites) for (const s of hooks.sites()) { const p = project(s.lat, s.lon); if (!p) continue; c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.arc(p[0], p[1], 3, 0, 7); c.fill(); c.stroke(); }
    c.font = '600 11.5px ' + css('--font');
    // where the Sun and the Earth are straight overhead right now
    for (const [pt, col, label] of [[subSun, css('--sun'), 'Sun overhead'], [subEarth, css('--earth'), 'Earth overhead']]) { if (!pt) continue; const p = project(pt.lat, pt.lon); if (!p) continue;
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], 6, 0, 7); c.moveTo(p[0] - 10, p[1]); c.lineTo(p[0] + 10, p[1]); c.moveTo(p[0], p[1] - 10); c.lineTo(p[0], p[1] + 10); c.stroke(); text(label, p[0], p[1] - 18, col); }
    if (site) { const p = project(site.lat, site.lon); if (p) { c.strokeStyle = '#fff'; c.lineWidth = 2.5; c.beginPath(); c.arc(p[0], p[1], 8, 0, 7); c.stroke(); c.strokeStyle = '#000'; c.lineWidth = 1; c.beginPath(); c.arc(p[0], p[1], 10, 0, 7); c.stroke(); text(site.name.replace(/ \(.*/, ''), p[0], p[1] + 20, '#fff'); } }
    if (pin) { const p = project(pin.lat, pin.lon); if (p) { c.strokeStyle = '#ff5c8a'; c.lineWidth = 2; c.beginPath(); c.moveTo(p[0] - 9, p[1]); c.lineTo(p[0] + 9, p[1]); c.moveTo(p[0], p[1] - 9); c.lineTo(p[0], p[1] + 9); c.stroke(); } }
    // scale bar
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(v => v / kmPerPx > 60) || 2000;
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(r.width - nice / kmPerPx - 26, r.height - 30, nice / kmPerPx + 18, 22);
    c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(r.width - 17 - nice / kmPerPx, r.height - 13); c.lineTo(r.width - 17, r.height - 13); c.stroke();
    c.font = '11px ' + css('--mono'); c.fillStyle = '#fff'; c.fillText(nice + ' km at centre', r.width - 17 - nice / kmPerPx / 2, r.height - 22);
  }

  // ------------------------------------------------------------ interaction
  let flyId = 0;
  // Smoothly turn and zoom to a place (the shortest way round in longitude).
  function flyTo(lat, lon, zoom) {
    const from = { lat: cam.lat, lon: cam.lon, zoom: cam.zoom }, dl = ((lon - from.lon + 540) % 360) - 180, id = ++flyId, t0 = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cam.lat = lat; cam.lon = lon; cam.zoom = zoom; render(); return; }
    const step = tn => { if (id !== flyId) return; const u = Math.min(1, (tn - t0) / 900), e = u * u * (3 - 2 * u);
      cam.lat = from.lat + (lat - from.lat) * e; cam.lon = from.lon + dl * e; cam.zoom = Math.exp(Math.log(from.zoom) + (Math.log(zoom) - Math.log(from.zoom)) * e); drawGL(); drawOverlay(); if (u < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function zoomBy(f) { cam.zoom = Math.max(0.6, Math.min(90, cam.zoom * f)); render(); }
  function wire() {
    let down = null, moved = false;
    cv.onpointerdown = e => { down = [e.clientX, e.clientY, cam.lat, cam.lon]; moved = false; flyId++; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => {
      const r = cv.getBoundingClientRect();
      if (down) { const dx = e.clientX - down[0], dy = e.clientY - down[1]; if (Math.hypot(dx, dy) > 4) moved = true;
        if (moved) { const k = R2D / radiusPx(); cam.lat = Math.max(-90, Math.min(90, down[2] + dy * k)); cam.lon = down[3] - dx * k / Math.max(0.2, Math.cos(cam.lat * D2R)); render(); } }
      const ll = unproject(e.clientX - r.left, e.clientY - r.top); hooks.onHover(ll ? { lat: ll[0], lon: ll[1] } : null);
    };
    cv.onpointerup = e => {
      const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (down && !moved) { let hit = null; if (opt.sites) for (const s of hooks.sites()) { const p = project(s.lat, s.lon); if (p && Math.hypot(p[0] - sx, p[1] - sy) < 8) { hit = s; break; } }
        if (hit) hooks.onSelect(hit); else { const ll = unproject(sx, sy); if (ll) { pin = { lat: ll[0], lon: ll[1] }; hooks.onPick(pin); render(); } } }
      down = null;
    };
    cv.onpointerleave = () => hooks.onHover(null);
    cv.ondblclick = e => { const r = cv.getBoundingClientRect(), ll = unproject(e.clientX - r.left, e.clientY - r.top); if (ll) flyTo(ll[0], ll[1], Math.min(90, cam.zoom * 2)); };
    cv.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.01)); }, { passive: false });
    cv.addEventListener('keydown', e => { const st = 12 / cam.zoom;
      if (e.key === '+' || e.key === '=') zoomBy(1.4); else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.4);
      else if (e.key === 'ArrowLeft') cam.lon -= st; else if (e.key === 'ArrowRight') cam.lon += st; else if (e.key === 'ArrowUp') cam.lat = Math.min(90, cam.lat + st); else if (e.key === 'ArrowDown') cam.lat = Math.max(-90, cam.lat - st); else return;
      e.preventDefault(); e.stopPropagation(); render(); });
  }

  return {
    init, render, flyTo, zoomBy,
    get ready() { return ready; }, get failed() { return failed; },
    setSite(s) { site = s; if (ready) flyTo(s.lat, s.lon, Math.abs(s.lat) > 75 ? 5 : 1.6); },
    // sub-solar and sub-Earth points for the current time (from Astro.geometry)
    setTime(g) { subSun = { lat: g.sun.lat, lon: g.sun.lon }; subEarth = { lat: g.earth.lat, lon: g.earth.lon }; sunDir = vec(g.sun.lat, g.sun.lon); render(); },
    setOption(key, v) { opt[key] = v; if (!ready) return; if (key === 'base') loadBase(v).then(render); else if ((key === 'sun' || key === 'earth' || key === 'psr') && v) loadOverlay(key); render(); },
    setPin(p) { pin = p; render(); },
    startAt(s) { site = s; cam.lat = s.lat; cam.lon = s.lon; cam.zoom = Math.abs(s.lat) > 75 ? 5 : 1.6; },
  };
})();
