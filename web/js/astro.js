const Astro = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MOON_R = 1737.4;          // km, IAU mean radius
  const AU = 149597870.7;         // km
  const DELTA_T = 69;             // s, TT-UT (approx. for 2020s)
  const norm = a => ((a % 360) + 360) % 360;
  const sin = a => Math.sin(a * D2R), cos = a => Math.cos(a * D2R);

  // [D, M, M', F, Σl, Σr]
  const LR = [
    [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],
    [0,0,2,0,213618,-569925],[0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],
    [2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],[2,0,1,0,53322,-170733],
    [2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
    [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],
    [0,0,1,-2,10980,79661],[4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],
    [4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],[2,1,0,0,-6766,30824],
    [1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
    [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],
    [0,1,-2,0,-2689,-7003],[2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],
    [1,0,1,0,-2348,6322],[2,-2,0,0,2236,-9884],[0,1,2,0,-2120,5751],
    [0,2,0,0,-2069,0],[2,-2,-1,0,2048,-4950],[2,0,1,-2,-1773,4130],
    [2,0,0,2,-1595,0],[4,-1,-1,0,1215,-3958],[0,0,2,2,-1110,0],
    [3,0,-1,0,-892,3258],[2,1,1,0,-810,2616],[4,-1,-2,0,759,-1897],
    [0,2,-1,0,-713,-2117],[2,2,-1,0,-700,2354],[2,1,-2,0,691,0],
    [2,-1,0,-2,596,0],[4,0,1,0,549,-1423],[0,0,4,0,537,-1117],
    [4,-1,0,0,520,-1571],[1,0,-2,0,-487,-1739],[2,1,0,-2,-399,0],
    [0,0,2,-2,-381,-4421],[1,1,1,0,351,0],[3,0,-2,0,-340,0],
    [4,0,-3,0,330,0],[2,-1,2,0,327,0],[0,2,1,0,-323,1165],
    [1,1,-1,0,299,0],[2,0,3,0,294,0],[2,0,-1,-2,0,8752]
  ];
  // [D, M, M', F, Σb]
  const B = [
    [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],
    [2,0,-1,1,55413],[2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],
    [2,0,1,-1,9266],[0,0,2,-1,8822],[2,-1,0,-1,8216],[2,0,-2,-1,4324],
    [2,0,1,1,4200],[2,1,0,-1,-3359],[2,-1,-1,1,2463],[2,-1,0,1,2211],
    [2,-1,-1,-1,2065],[0,1,-1,-1,-1870],[4,0,-1,-1,1828],[0,1,0,1,-1794],
    [0,0,0,3,-1749],[0,1,-1,1,-1565],[1,0,0,1,-1491],[0,1,1,1,-1475],
    [0,1,1,-1,-1410],[0,1,0,-1,-1344],[1,0,0,-1,-1335],[0,0,3,1,1107],
    [4,0,0,-1,1021],[4,0,-1,1,833]
  ];

  function jdFromDate(date) { return date.getTime() / 86400000 + 2440587.5; }

  // Core: selenographic coordinates of sub-Earth and sub-solar points + distances
  function geometry(date) {
    const jde = jdFromDate(date) + DELTA_T / 86400;
    const T = (jde - 2451545.0) / 36525;
    const Lp = norm(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T);
    const D  = norm(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T);
    const M  = norm(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T);
    const Mp = norm(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T);
    const F  = norm(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T);
    const A1 = norm(119.75 + 131.849 * T), A2 = norm(53.09 + 479264.290 * T), A3 = norm(313.45 + 481266.484 * T);
    const E = 1 - 0.002516 * T - 0.0000074 * T * T;
    let sl = 0, sr = 0, sb = 0;
    for (const [d, m, mp, f, cl, cr] of LR) {
      const arg = d * D + m * M + mp * Mp + f * F;
      const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
      sl += cl * e * sin(arg); sr += cr * e * cos(arg);
    }
    for (const [d, m, mp, f, cb] of B) {
      const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
      sb += cb * e * sin(d * D + m * M + mp * Mp + f * F);
    }
    sl += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
    sb += -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
    const lam = norm(Lp + sl / 1e6), bet = sb / 1e6, dist = 385000.56 + sr / 1000; // geometric, km
    const Om = norm(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T);

    // Sun (ch. 25, low precision)
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const Ms = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(Ms) + (0.019993 - 0.000101 * T) * sin(2 * Ms) + 0.000289 * sin(3 * Ms);
    const ecc = 0.016708634 - 0.000042037 * T;
    const nu = Ms + C;
    const Rau = 1.000001018 * (1 - ecc * ecc) / (1 + ecc * cos(nu));
    const lamSun = norm(L0 + C - 0.00569 - 0.00478 * sin(Om));
    const Rkm = Rau * AU;

    // Optical + physical libration (ch. 53)
    const I = 1.54242;
    const optical = (lm, bt) => {
      const W = lm - Om;
      const A = Math.atan2(sin(W) * cos(bt) * cos(I) - sin(bt) * sin(I), cos(W) * cos(bt)) * R2D;
      const l = norm(A - F + 180) - 180;
      const b = Math.asin(-sin(W) * cos(bt) * sin(I) - sin(bt) * cos(I)) * R2D;
      return { A, l, b };
    };
    const K1 = 119.75 + 131.849 * T, K2 = 72.56 + 20.186 * T;
    const rho = -0.02752 * cos(Mp) - 0.02245 * sin(F) + 0.00684 * cos(Mp - 2 * F) - 0.00293 * cos(2 * F)
      - 0.00085 * cos(2 * F - 2 * D) - 0.00054 * cos(Mp - 2 * D) - 0.00020 * sin(Mp + F) - 0.00020 * cos(Mp + 2 * F)
      - 0.00020 * cos(Mp - F) + 0.00014 * cos(Mp + 2 * F - 2 * D);
    const sig = -0.02816 * sin(Mp) + 0.02244 * cos(F) - 0.00682 * sin(Mp - 2 * F) - 0.00279 * sin(2 * F)
      - 0.00083 * sin(2 * F - 2 * D) + 0.00069 * sin(Mp - 2 * D) + 0.00040 * cos(Mp + F) - 0.00025 * sin(2 * Mp)
      - 0.00023 * sin(Mp + 2 * F) + 0.00020 * cos(Mp - F) + 0.00019 * sin(Mp - F) + 0.00013 * sin(Mp + 2 * F - 2 * D)
      - 0.00010 * cos(Mp - 3 * F);
    const tau = 0.02520 * E * sin(M) + 0.00473 * sin(2 * Mp - 2 * F) - 0.00467 * sin(Mp) + 0.00396 * sin(K1)
      + 0.00276 * sin(2 * Mp - 2 * D) + 0.00196 * sin(Om) - 0.00183 * cos(Mp - F) + 0.00115 * sin(Mp - 2 * D)
      - 0.00096 * sin(Mp - D) + 0.00046 * sin(2 * F - 2 * D) - 0.00039 * sin(Mp - F) - 0.00032 * sin(Mp - M - D)
      + 0.00027 * sin(2 * Mp - M - 2 * D) + 0.00023 * sin(K2) - 0.00014 * sin(2 * D) + 0.00014 * cos(2 * Mp - 2 * F)
      - 0.00012 * sin(Mp - 2 * F) - 0.00012 * sin(2 * Mp) + 0.00011 * sin(2 * Mp - 2 * M - 2 * D);
    const physical = (o) => ({
      l: o.l + (-tau + (rho * cos(o.A) + sig * sin(o.A)) * Math.tan(o.b * D2R)),
      b: o.b + (sig * cos(o.A) - rho * sin(o.A))
    });
    const earth = physical(optical(lam, bet));
    // Sun as seen from the Moon (Meeus 53, selenographic Sun)
    const lamH = lamSun + 180 + (dist / Rkm) * R2D * cos(bet) * sin(lamSun - lam);
    const betH = (dist / Rkm) * bet;
    const sun = physical(optical(lamH, betH));
    return {
      earth: { lon: earth.l, lat: earth.b, dist },
      sun: { lon: norm(sun.l + 180) - 180, lat: sun.b, dist: Rkm },
      moonLon: lam, moonLat: bet, sunLon: lamSun
    };
  }

  // Local horizontal coordinates of a body for a site (lat, lon in deg, hKm above mean radius)
  function topo(body, lat, lon, hKm) {
    const cb = cos(body.lat);
    const bx = body.dist * cb * cos(body.lon), by = body.dist * cb * sin(body.lon), bz = body.dist * sin(body.lat);
    const r = MOON_R + (hKm || 0);
    const sx = cos(lat) * cos(lon), sy = cos(lat) * sin(lon), sz = sin(lat);
    const rx = bx - r * sx, ry = by - r * sy, rz = bz - r * sz;
    const rn = Math.hypot(rx, ry, rz);
    const up = (rx * sx + ry * sy + rz * sz) / rn;
    const east = (-sin(lon) * rx + cos(lon) * ry) / rn;
    const north = (-sin(lat) * cos(lon) * rx - sin(lat) * sin(lon) * ry + cos(lat) * rz) / rn;
    return { el: Math.asin(Math.max(-1, Math.min(1, up))) * R2D, az: norm(Math.atan2(east, north) * R2D), range: rn };
  }

  // Fraction of a disc of angular radius r (deg) above an horizon at height hz, centre at el
  function discFraction(el, hz, r) {
    const d = (el - hz) / r;
    if (d >= 1) return 1; if (d <= -1) return 0;
    // circular segment area fraction above a chord at distance -d from centre
    const a = Math.acos(-d);
    return (a - Math.sin(a) * Math.cos(a)) / Math.PI;
  }

  // Move a point dKm along bearing (deg from north) on the Moon
  function destination(lat, lon, bearing, dKm) {
    const d = dKm / MOON_R, p1 = lat * D2R, l1 = lon * D2R, b = bearing * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * R2D, lon: norm(l2 * R2D + 180) - 180 };
  }

  return { geometry, topo, discFraction, destination, MOON_R, AU, norm, D2R, R2D };
})();
if (typeof module !== 'undefined') module.exports = Astro;
