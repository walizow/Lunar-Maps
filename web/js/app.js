// =============================================================================
// app.js - the screen: controls, sky view, timelines, cards, lander drawing.
// All numbers come from engine.js; this file only reads controls and draws.
//
// One shared state object (`st`) holds the scenario. Two kinds of update:
//   recompute()  - site / window / settings changed: rebuild the time series
//   setTime(t)   - only the current time moved: redraw the "now" parts
// =============================================================================
(() => {
  const $ = id => document.getElementById(id);
  const D2R = Math.PI / 180, HOUR = 3600000;
  const GROUPS = [['artemis3', 'Artemis III candidate regions'], ['illumination', 'Illumination study points'],
    ['mission', 'Recent and planned missions'], ['historic', 'Apollo and other landers'], ['north', 'North pole'],
    ['demo', 'Demo custom site'], ['custom', 'Your custom site']];

  const st = {
    site: null, t0: 0, hours: 708.72, t: 0, playing: false, speed: 24,
    mast: 2, earthEdge: 0, dsnMinEl: 10,
    lander: Object.assign({ preset: 'nova-c', heading: 0, tilt: 0, tiltDir: 0 }, Engine.LANDERS['nova-c']),
    loadW: 200, batteryWh: 1500,
    skyMode: 'pano', skyP: 0,          // skyP animates 0 (panorama) -> 1 (dial)
    hoverT: null, hoverAz: null, topDown: false,
    show: { sun: true, earth: true, dsn: true, green: true, power: true, batt: true },   // timeline rows
  };
  let S = null;                        // current time series (Engine.series)
  let now = null;                      // everything about the current instant
  const beyond = {};                   // cache: first events after the window ends
  let inspectedBody = 'earth';
  let checkpoint = null;

  // ------------------------------------------------------------ formatting
  const pad = n => String(n).padStart(2, '0');
  const fmtUTC = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`; };
  const fmtDay = t => { const d = new Date(t); return `${d.getUTCDate()} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getUTCMonth()]}`; };
  const deg = (x, n = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(n) + '°';
  function fmtDur(h) {
    if (h == null) return '—';
    if (h < 1) return Math.round(h * 60) + ' min';
    if (h < 48) return Math.floor(h) + ' h ' + pad(Math.round((h % 1) * 60)) + ' min';
    return Math.floor(h / 24) + ' d ' + Math.round(h % 24) + ' h';
  }
  const compass = az => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Prepare a canvas for sharp drawing on high-resolution screens.
  function fit(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w: r.width, h: r.height };
  }

  // ------------------------------------------------------------ scenario
  const opt = () => ({ t0: st.t0, hours: st.hours, mast: st.mast, earthEdge: st.earthEdge, dsnMinEl: st.dsnMinEl, lander: st.lander, loadW: st.loadW, batteryWh: st.batteryWh });

  function recompute() {
    if (!st.site) return;
    checkpoint = null;
    $('clearanceStatus').textContent = '';
    $('trialStatus').textContent = '';
    S = Engine.series(st.site, opt());
    for (const k in beyond) delete beyond[k];
    st.t = Math.min(Math.max(st.t, st.t0), st.t0 + st.hours * HOUR);
    tlCache = null;
    drawWindowCards(); setTime(st.t);
  }

  function setTime(t) {
    st.t = Math.min(Math.max(t, st.t0), st.t0 + st.hours * HOUR);
    const p = Engine.pos(st.site, st.t), mask = Engine.maskOf(st.site, st.mast);
    const hs = Engine.maskAt(mask, p.sun.az), he = Engine.maskAt(mask, p.earth.az);
    const frac = Astro.discFraction(p.sun.el, hs, p.sun.radius);
    const pl = Engine.panels(st.lander), per = new Float32Array(pl.length);
    const watts = Engine.power(st.lander, pl, p.sun.az, p.sun.el, frac, p.sun.range, per);
    const dsnEl = Engine.dsnElevations(p.g, st.t);
    const i = Math.min(S.n - 1, Math.round((st.t - st.t0) / S.dt));
    now = { p, hs, he, frac, pl, per, watts, dsnEl, i,
      sunUp: frac > 0, earthUp: p.earth.el + st.earthEdge * p.earth.radius > he,
      stations: Engine.DSN.filter((c, k) => dsnEl[k] >= st.dsnMinEl), soc: S.soc[i] };
    $('scrub').value = Math.round(1000 * (st.t - st.t0) / (st.hours * HOUR));
    $('nowText').textContent = fmtUTC(st.t);
    Workspace.setSite(st.site.name);
    drawNowCards(); drawClearance(); drawSky(); drawTimeline(); drawLander(); drawScale();
    MapView.setSunEarth({ sunAz: p.sun.az, earthAz: p.earth.az, sunUp: now.sunUp, earthUp: now.earthUp });
    Globe.setTime(p.g);
    Pov.setMast(st.mast, mask);
    Pov.setSky({ az: p.sun.az, el: p.sun.el, radius: p.sun.radius, up: now.sunUp }, { az: p.earth.az, el: p.earth.el, radius: p.earth.radius, up: now.earthUp }, p.g.moonLon);
  }

  // Next rise/set after the current time. Looks through the series first
  // (fast), then refines to the minute; past the window end it asks the engine
  // to search further ahead, once, and remembers the answer.
  function nextEvent(kind) {
    const isSun = kind.startsWith('sun'), wantUp = kind.endsWith('rise');
    const up = isSun ? (t => Engine.sunUp(st.site, opt(), t)) : (t => Engine.earthUp(st.site, opt(), t));
    const arr = isSun ? S.sunFrac : S.earthVis;
    let prev = isSun ? now.sunUp : now.earthUp, tPrev = st.t;
    for (let j = Math.floor((st.t - st.t0) / S.dt) + 1; j < S.n; j++) {
      const cur = arr[j] > 0, tj = st.t0 + j * S.dt;
      if (cur !== prev && cur === wantUp) {
        let a = tPrev, b = tj;
        while (b - a > 30000) { const m = (a + b) / 2; if (up(m) === wantUp) b = m; else a = m; }
        return b;
      }
      prev = cur; tPrev = tj;
    }
    if (!(kind in beyond)) beyond[kind] = Engine.nextEvent(st.site, opt(), st.t0 + st.hours * HOUR, kind);
    return beyond[kind];
  }

  function trialConfig(config) {
    const value = Number($('trialValue').value);
    return $('trialKind').value === 'mast'
      ? { ...config, mast: value }
      : { ...config, t0: config.t0 + value * 24 * HOUR };
  }

  function setTrialChoices() {
    const mast = $('trialKind').value === 'mast';
    const choices = mast ? Engine.DB.masts : [1, 3, 7, 14];
    $('trialValueLabel').textContent = mast ? 'Trial mast (m)' : 'Days later';
    $('trialValue').replaceChildren(...choices.map(value => new Option(value, value)));
    $('trialValue').value = mast ? '10' : '3';
  }

  function drawClearance() {
    if ($('clearanceDock').hidden || $('workspace-explore').hidden) return;
    const body = now.p[inspectedBody];
    const isEarth = inspectedBody === 'earth';
    const label = isEarth ? 'Earth' : 'Sun';
    const skyline = isEarth ? now.he : now.hs;
    const visible = isEarth ? now.earthUp : now.sunUp;
    const clearance = body.el - skyline;
    const event = visible ? 'set' : 'rise';
    const next = nextEvent(inspectedBody + event);
    $('clearanceBearing').textContent = body.az.toFixed(1) + '° ' + compass(body.az);
    $('clearanceElevation').textContent = deg(body.el, 3);
    $('clearanceSkyline').textContent = deg(skyline, 3);
    $('clearanceValue').textContent = deg(clearance, 3);
    $('clearanceValue').className = clearance > 0 ? 'good' : 'bad';
    $('clearanceVisibility').textContent = label + (visible ? ' visible' : ' hidden');
    $('clearanceVisibility').className = 'pill ' + (visible ? 'good' : 'bad');
    $('clearanceContact').textContent = now.earthUp && now.stations.length
      ? 'Potential DSN contact · ' + now.stations.map(station => station.name).join(', ')
      : 'No potential DSN contact';
    $('clearanceNext').textContent = next == null
      ? 'No modeled ' + label + event + ' found ahead'
      : 'Next ' + label + event + ' · ' + fmtUTC(next) + ' (estimated)';
    $('clearanceRule').textContent = isEarth
      ? 'Clearance uses the center. Earth visibility rule: ' + $('earthEdge').selectedOptions[0].textContent + '.'
      : 'Clearance uses the center. Sunlight is possible when any part of the disc clears the skyline.';
    $('clearanceSet').textContent = 'Jump to next ' + label + 'set';
    const set = checkpoint ?? (visible ? next : nextEvent(inspectedBody + 'set'));
    for (const [id, minutes] of [['clearanceBefore', -10], ['clearanceAfter', 10]]) {
      const time = set + minutes * 60000;
      $(id).disabled = set == null || time < st.t0 || time > st.t0 + st.hours * HOUR;
    }
    if ($('tryChange').open) drawTrial();
  }

  function drawTrial() {
    const original = snapshot();
    const alternate = trialConfig(original);
    const alternateTime = alternate.t0 + (st.t - original.t0);
    const body = Engine.pos(st.site, alternateTime)[inspectedBody];
    const nextClearance = body.el - Engine.maskAt(Engine.maskOf(st.site, alternate.mast), body.az);
    const clearance = now.p[inspectedBody].el - (inspectedBody === 'earth' ? now.he : now.hs);
    const change = $('trialKind').value === 'mast'
      ? `${original.mast} m → ${alternate.mast} m mast`
      : `${fmtUTC(original.t0)} → ${fmtUTC(alternate.t0)}`;
    const mastTrial = $('trialKind').value === 'mast' && original.mast !== alternate.mast;
    $('trialRead').textContent = `${change} · Center clearance ${deg(clearance, 3)} → ${deg(nextClearance, 3)} at the same elapsed mission time.`
      + (mastTrial && !$('view-lander').hidden ? ' Dashed mint shows the trial skyline.' : '');
    Pov.setTrialMask(mastTrial ? Engine.maskOf(st.site, alternate.mast) : null);
    $('trialCompare').disabled = encodeScenario(alternate) === encodeScenario(original);
  }

  function inspectBody(which) {
    if (which !== inspectedBody) {
      inspectedBody = which;
      checkpoint = null;
      $('clearanceStatus').textContent = '';
    }
    $('inspectEarth').setAttribute('aria-pressed', String(which === 'earth'));
    $('inspectSun').setAttribute('aria-pressed', String(which === 'sun'));
    Pov.setInspection(which);
    Pov.face(which);
    drawClearance();
  }

  function visitClearanceCheckpoint(minutes) {
    if (!now) return;
    const event = checkpoint ?? nextEvent(inspectedBody + 'set');
    if (event == null) {
      $('clearanceStatus').textContent = 'No modeled set event was found ahead.';
      return;
    }
    const time = event + minutes * 60000;
    if (time < st.t0 || time > st.t0 + st.hours * HOUR) {
      $('clearanceStatus').textContent = 'That checkpoint is outside this mission window. Extend the window to visit it.';
      return;
    }
    checkpoint = event;
    stop();
    setTime(time);
    Pov.face(inspectedBody);
    $('clearanceStatus').textContent = `Checkpoint anchored to the modeled set at ${fmtUTC(event)}.`;
  }

  async function loadClearanceDemo() {
    const config = {
      site: 'derosa2012-cr1-connecting-ridge', t0: Date.UTC(2026, 10, 15), hours: 708.72,
      mast: 2, earthEdge: 0, dsnMinEl: 10, loadW: 200, batteryWh: 1500,
      lander: { ...Engine.LANDERS['nova-c'], preset: 'nova-c', heading: 0, tilt: 0, tiltDir: 0 }
    };
    await applyScenario(config);
    setTime(Date.UTC(2026, 10, 17, 2, 30));
    inspectBody('earth');
    $('trialKind').value = 'mast';
    setTrialChoices();
    $('tryChange').open = true;
    drawTrial();
    $('clearanceStatus').textContent = 'Connecting Ridge · 17 Nov 2026, 02:30 UTC. Preview a 10 m mast or jump to Earthset.';
  }

  function wireClearance() {
    setTrialChoices();
    $('inspectEarth').onclick = () => inspectBody('earth');
    $('inspectSun').onclick = () => inspectBody('sun');
    $('clearanceSet').onclick = () => { checkpoint = null; visitClearanceCheckpoint(0); };
    $('clearanceBefore').onclick = () => visitClearanceCheckpoint(-10);
    $('clearanceAfter').onclick = () => visitClearanceCheckpoint(10);
    $('clearanceDemo').onclick = async () => {
      $('clearanceDemo').disabled = true;
      try { await loadClearanceDemo(); }
      catch (error) { $('clearanceStatus').textContent = 'Could not load the demo: ' + error.message; }
      finally { $('clearanceDemo').disabled = false; }
    };
    $('trialKind').onchange = () => { setTrialChoices(); drawTrial(); };
    $('trialValue').onchange = drawTrial;
    $('tryChange').ontoggle = () => {
      if (now && $('tryChange').open) drawTrial();
      else Pov.setTrialMask(null);
    };
    $('trialCompare').onclick = () => {
      const original = snapshot();
      const mast = $('trialKind').value === 'mast';
      showScenarioPair(original, trialConfig(original), st.site, ['original', mast ? 'mast trial' : 'arrival trial'], 'trialStatus');
    };
    Pov.setInspection(inspectedBody);
  }

  function copilotContext() {
    if (!now || !st.site) return null;
    const stats = S.stats;
    const lines = [
      `${st.site.name} · ${fmtUTC(st.t)}`,
      `Mission starts ${fmtUTC(st.t0)}, lasts ${fmtDur(st.hours)}, mast ${st.mast} m. Earth visibility rule: ${$('earthEdge').selectedOptions[0].textContent}.`,
      `Sun elevation ${deg(now.p.sun.el, 3)}, terrain skyline ${deg(now.hs, 3)}, center clearance ${deg(now.p.sun.el - now.hs, 3)}, ${now.sunUp ? 'visible' : 'hidden'}.`,
      `Earth elevation ${deg(now.p.earth.el, 3)}, terrain skyline ${deg(now.he, 3)}, center clearance ${deg(now.p.earth.el - now.he, 3)}, ${now.earthUp ? 'visible' : 'hidden'}.`,
      `Potential DSN contact now: ${now.earthUp && now.stations.length ? now.stations.map(station => station.name).join(', ') : 'none'}.`,
      `Current generation ${Math.round(now.watts)} W, load ${st.loadW} W, battery ${Math.round(now.soc)} Wh.`,
      `Mission totals: ${stats.pctLink.toFixed(1)}% potential DSN contact, ${stats.pctGreen.toFixed(1)}% simultaneous sunlight and potential contact, ${fmtDur(stats.emptyH)} with an empty battery.`
    ];
    if (found) {
      lines.push(`Last search for ${found.site.name}, original start ${fmtUTC(found.original.t0)}. Shortlist: `
        + found.shortlist.map(candidate => `${fmtUTC(candidate.t0)}: ${candidate.stats.pctLink.toFixed(1)}% potential contact, ${fmtDur(candidate.stats.emptyH)} empty battery`).join('; '));
    }
    return lines.join('\n');
  }

  function openLanderEvidence() {
    stop();
    Workspace.show('explore');
    Workspace.showView('lander');
    inspectBody('earth');
  }

  function showCopilotEarthset() {
    openLanderEvidence();
    const event = nextEvent('earthset');
    const offset = 10 * 60000;
    if (event == null || event - offset < st.t0 || event + offset > st.t0 + st.hours * HOUR) {
      return { title: 'Earthset outside this window', text: 'Extend the mission window to include ten minutes on either side of a modeled Earthset, or load the Connecting Ridge demo in Horizon clearance.' };
    }
    const readingAt = time => {
      const earth = Engine.pos(st.site, time).earth;
      return earth.el - Engine.maskAt(Engine.maskOf(st.site, st.mast), earth.az);
    };
    checkpoint = event;
    visitClearanceCheckpoint(-10);
    const before = deg(readingAt(event - offset), 3);
    const after = deg(readingAt(event + offset), 3);
    return {
      title: 'Earth crosses the terrain skyline',
      text: `Earth center clearance is ${before} ten minutes before and ${after} ten minutes after modeled Earthset. Use the checkpoint buttons below the lander view to step across it.`,
      evidence: `${st.site.name} · ${fmtUTC(event)} · ${st.mast} m mast · NASA LOLA + ${now.p.src === 'horizons' ? 'JPL Horizons' : 'computed ephemeris'}`,
      narration: st.site.id === 'derosa2012-cr1-connecting-ridge' && st.mast === 2 && st.earthEdge === 0
        && Math.abs(event - Date.UTC(2026, 10, 29, 20, 13)) < 60000 * 3
    };
  }

  function showCopilotMast() {
    openLanderEvidence();
    $('trialKind').value = 'mast';
    setTrialChoices();
    $('trialValue').value = '10';
    $('tryChange').open = true;
    drawTrial();
    return {
      title: 'Trial skyline at 10 m',
      text: $('trialRead').textContent + ' Compare outcomes saves the two mission configurations.',
      evidence: `${st.site.name} · ${fmtUTC(st.t)} · NASA LOLA terrain`
    };
  }

  function showCopilotDelay() {
    stop();
    Workspace.show('find');
    $('findGoal').value = 'green';
    $('findGoal').onchange();
    $('findRange').value = '90';
    $('batteryLimit').value = '0';
    runFind();
    if (!found) return { title: 'Choose a mission window', text: $('findOut').textContent };
    const best = found.shortlist.find(candidate => candidate.best);
    const passing = found.shortlist.filter(candidate => !candidate.original && candidate.stats.emptyH <= 1e-8);
    return {
      title: 'Contact and battery across the shortlist',
      text: `The top search result has ${best.stats.pctLink.toFixed(1)}% modeled potential contact and ${fmtDur(best.stats.emptyH)} with an empty battery. ${passing.length ? passing.length + ' later shortlisted dates meet the zero-hour battery limit.' : 'None of the later dates in this shortlist meet the zero-hour battery limit.'}`,
      evidence: `${found.site.name} · Top candidate ${fmtUTC(best.t0)} · ${found.shortlist.length} evaluated shortlist entries`
    };
  }

  function showCopilotBrief() {
    stop();
    Workspace.show('compare');
    if (cmp.length < 2) return { title: 'Two scenarios needed', text: 'Save a second scenario to produce a mission brief.' };
    const [baseline, alternative] = [cmp[0], cmp.at(-1)];
    const describe = entry => `${entry.site.name}, ${fmtUTC(entry.cfg.t0)}, ${entry.cfg.mast} m mast`;
    const first = baseline.S.stats, last = alternative.S.stats;
    const text = `Compare A (${describe(baseline)}) with ${'ABCD'[cmp.length - 1]} (${describe(alternative)}). Potential DSN contact is ${first.pctLink.toFixed(1)}% versus ${last.pctLink.toFixed(1)}%. Empty-battery time is ${fmtDur(first.emptyH)} versus ${fmtDur(last.emptyH)} under the saved assumptions.`;
    return { title: 'Mission comparison brief', text, evidence: 'Source · Saved comparison scenarios and aligned timelines', copy: text };
  }

  const copilotActions = {
    earthset: showCopilotEarthset, mast: showCopilotMast, delay: showCopilotDelay, brief: showCopilotBrief
  };

  // ------------------------------------------------------------ cards
  const card = (cls, k, tip, v, s) => `<div class="card ${cls}"><div class="k" title="${tip}">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

  function drawNowCards() {
    const { p } = now, sunset = nextEvent('sunset'), sunrise = nextEvent('sunrise'), eset = nextEvent('earthset'), erise = nextEvent('earthrise');
    const until = t => t == null ? 'none within 120 days' : 'in ' + fmtDur((t - st.t) / HOUR);
    const html = [
      card('sun', 'Sun above terrain', 'Angle between the Sun\'s centre and the terrain skyline in the Sun\'s direction. Positive means the centre is clear of the hills.',
        deg(p.sun.el - now.hs, 2), `${now.sunUp ? `<span class="pill good">sunlit</span> ${Math.round(now.frac * 100)} % of disc visible` : '<span class="pill bad">in shadow</span>'}<br>` +
        (now.sunUp ? `Sunset <b>${until(sunset)}</b>` : `Sunrise <b>${until(sunrise)}</b>`)),
      card('sun', 'Solar elevation', 'Height of the Sun above a perfectly flat horizon (no terrain), and its compass bearing.',
        deg(p.sun.el, 2), `bearing ${p.sun.az.toFixed(1)}° (${compass(p.sun.az)})<br>terrain there: ${deg(now.hs, 2)}`),
      card('earth', 'Earth above terrain', 'Angle between Earth\'s centre and the terrain skyline in Earth\'s direction.',
        deg(p.earth.el - now.he, 2), `${now.earthUp ? '<span class="pill good">visible</span>' : '<span class="pill bad">hidden</span>'} elevation ${deg(p.earth.el, 2)}, bearing ${p.earth.az.toFixed(1)}°<br>` +
        (now.earthUp ? `Earthset <b>${until(eset)}</b>` : `Earthrise <b>${until(erise)}</b>`)),
      card('link', 'Potential contact with Earth', 'Needs Earth above the terrain here AND the Moon high enough at a Deep Space Network complex.',
        now.earthUp && now.stations.length ? now.stations.map(c => c.name).join(' + ') : 'No geometric contact',
        !now.earthUp ? 'Earth is behind terrain' : now.stations.length ? 'DSN complexes with the Moon in view' : 'No DSN complex has the Moon high enough'),
      card('pow' + (now.soc <= 0 && st.batteryWh > 0 ? ' alert' : ''), 'Power now', 'Electrical output of the solar array at this moment, and the simulated battery charge.',
        Math.round(now.watts) + ' W', `load ${st.loadW} W · battery <b>${st.batteryWh > 0 ? Math.round(100 * now.soc / st.batteryWh) + ' %' : 'none'}</b>`),
    ];
    $('nowCards').innerHTML = html.join('');
    // Text version of the sky view for screen readers (the canvas itself cannot be read)
    $('sky').setAttribute('aria-label', `Sky view at ${fmtUTC(st.t)}. Sun ${deg(p.sun.el - now.hs, 1)} relative to the terrain on bearing ${p.sun.az.toFixed(0)} degrees, ${now.sunUp ? 'visible' : 'hidden'}. Earth ${deg(p.earth.el - now.he, 1)} relative to the terrain on bearing ${p.earth.az.toFixed(0)} degrees, ${now.earthUp ? 'visible' : 'hidden'}.`);
    const r = (k, ...v) => `<tr><td>${k}</td>${v.map(x => `<td>${x}</td>`).join('')}</tr>`;
    $('rawNow').innerHTML = `<tr><th></th><th>Sun</th><th>Earth</th></tr>` +
      r('azimuth °', p.sun.az.toFixed(3), p.earth.az.toFixed(3)) + r('elevation °', p.sun.el.toFixed(3), p.earth.el.toFixed(3)) +
      r('terrain horizon °', now.hs.toFixed(2), now.he.toFixed(2)) + r('angular radius °', p.sun.radius.toFixed(4), p.earth.radius.toFixed(4)) +
      r('range km', Math.round(p.sun.range).toLocaleString('en'), Math.round(p.earth.range).toLocaleString('en')) +
      r('disc fraction / phase', now.frac.toFixed(3), p.earth.phase.toFixed(3)) +
      r('source', p.src, p.src) + r('Moon elev. at DSN °', Engine.DSN.map((c, k) => c.id + ' ' + now.dsnEl[k].toFixed(1)).join(', '), '');
  }

  function drawWindowCards() {
    const s = S.stats, pct = x => x.toFixed(x < 10 || x > 90 ? 1 : 0) + ' %';
    $('winCards').innerHTML = [
      card('sun', 'Sunlit', 'Share of the window with any part of the Sun above the terrain.', pct(s.pctLit),
        `longest sunlit stretch <b>${fmtDur(s.longestLit)}</b>`),
      card('sun' + (s.longestDark > 24 * 6 ? ' alert' : ''), 'Longest darkness', 'Longest unbroken stretch with no sunlight. This sizes the battery (or decides whether the lander survives).', fmtDur(s.longestDark),
        `${s.outages} dark period${s.outages === 1 ? '' : 's'} in the window`),
      card('earth', 'Earth visible', 'Share of the window with Earth above the terrain.', pct(s.pctEarth), `longest gap <b>${fmtDur(s.longestNoEarth)}</b>`),
      card('link', 'Potential DSN contact', 'Share of the window when Earth is visible AND at least one DSN complex has the Moon in view.', pct(s.pctLink), `longest gap <b>${fmtDur(s.longestNoLink)}</b>`),
      card('link' + (s.dsnGaps.length ? ' alert' : ''), 'DSN coverage gaps', 'Periods when none of the three DSN complexes (Goldstone, Madrid, Canberra) has the Moon above the minimum elevation. No direct link is possible then, whatever the terrain.',
        s.dsnGaps.length ? s.dsnGaps.length + (s.dsnGaps.length === 1 ? ' gap' : ' gaps') : 'None',
        s.dsnGaps.length ? `longest <b>${fmtDur(s.dsnGapLongest)}</b>, total ${fmtDur(s.dsnGapHours)}` : 'a complex always has the Moon in view'),
      card('link', 'Green windows', 'Sunlight and a DSN link at the same time: the best periods for surface operations.', pct(s.pctGreen), `longest <b>${fmtDur(s.longestGreen)}</b>`),
      card('pow', 'Energy generated', 'Total electrical energy from the array over the window.', (s.energyWh / 1000).toFixed(s.energyWh > 1e5 ? 0 : 1) + ' kWh', `peak ${Math.round(s.peakW)} W · average ${Math.round(s.energyWh / st.hours)} W`),
      card('pow' + (s.emptyH > 0 ? ' alert' : ''), 'Battery', 'Lowest simulated battery charge. The battery starts full; it drains whenever the load exceeds generation.',
        s.emptyH > 0 ? 'Runs out' : (st.batteryWh > 0 ? Math.round(100 * s.minSoc / st.batteryWh) + ' % min' : '—'),
        s.emptyH > 0 ? `empty for <b>${fmtDur(s.emptyH)}</b>, first at ${fmtUTC(s.firstEmpty)}` : 'never empty in this window'),
    ].join('');
    // Flag above the timelines
    const fl = $('dsnFlag');
    if (s.dsnGaps.length) {
      const g = s.dsnGaps[0];
      fl.className = 'flag bad';
      fl.innerHTML = `<b>DSN coverage gaps.</b> In ${s.dsnGaps.length} period${s.dsnGaps.length === 1 ? '' : 's'} of this window none of the three DSN complexes has the Moon at least ${st.dsnMinEl}° up, so no direct link is possible. Longest ${fmtDur(s.dsnGapLongest)}, total ${fmtDur(s.dsnGapHours)}. First: ${fmtUTC(g.t0)} for ${fmtDur(g.hours)}. <button id="gapNext">Go to next gap</button>`;
      $('gapNext').onclick = () => { const nx = s.dsnGaps.find(q => q.t0 > st.t + 1) || s.dsnGaps[0]; setTime(nx.t0); };
    } else {
      fl.className = 'flag good';
      fl.innerHTML = `<b>No DSN coverage gaps.</b> At least one of the three complexes has the Moon ${st.dsnMinEl}° or more above its horizon throughout this window.`;
    }
    const src = { horizons: 'JPL Horizons hourly table (interpolated)', computed: 'computed in your browser (Meeus formulas, within about 0.03° of JPL Horizons)', mixed: 'JPL Horizons inside 2026–2028, computed in your browser outside it' }[S.src];
    $('srcLine').textContent = `Sun and Earth positions: ${src}. Horizon: ${st.site.horizonSource}${Engine.mastExact(st.site, st.mast) ? '' : `; ${st.mast} m mast blended from the ${Engine.DB.masts.filter(h => h < st.mast).pop()} m and ${Engine.DB.masts.find(h => h > st.mast)} m skylines (approximate)`}. Sampled every ${S.dt / 60000} min.`;
  }

  function drawSiteInfo() {
    const s = st.site, reg = s.region !== undefined ? s.region : Engine.regionAt(s.lat, s.lon);
    const rows = [['Coordinates', `${Math.abs(s.lat).toFixed(4)}° ${s.lat < 0 ? 'S' : 'N'}, ${Math.abs(s.lon).toFixed(4)}° ${s.lon < 0 ? 'W' : 'E'}`],
      ['Height', `${Math.round(s.h).toLocaleString('en')} m above the Moon's reference sphere`, 'Elevation of the ground at the site, like height above sea level on Earth. The Moon has no sea, so heights are measured from an imaginary sphere of radius 1,737.4 km (about the Moon\'s average radius). Negative means below that sphere. Measured by LOLA, the laser altimeter on NASA\'s Lunar Reconnaissance Orbiter. The mast height is added on top of this.'],
      ['Artemis III', reg ? `inside region ${reg.code}, ${reg.name}` : 'not inside a candidate region'],
      ['Horizon', s.horizonSource],
      ['Ephemeris', s.eph ? 'JPL Horizons 2026–2028' : 'computed in browser']];
    if (s.longterm) rows.push(['NASA long-term average', `Sun visible ${s.longterm.sun} %, Earth visible ${s.longterm.earth} % of the time${s.longterm.psr ? ' · permanently shadowed' : ''}`, 'Published by NASA\'s LOLA team (Mazarico and colleagues): the share of time the Sun and the Earth are visible from this 120 m patch of ground, averaged over many years so that every season and lighting cycle is included. It is a fixed property of the place, shown as a cross-check. The numbers in the rest of this app are computed for your chosen dates and mast height, so they will differ.']);
    if (s.note) rows.push(['Note', s.note]);
    // rows with a third entry get a hover explanation (dotted underline)
    $('siteInfo').innerHTML = rows.map(([k, v, tip]) => `<dt${tip ? ` class="tip" title="${tip}"` : ''}>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ------------------------------------------------------------ sky view
  // One drawing routine serves both layouts. Every point (azimuth, elevation)
  // has a panorama position and a dial position; `st.skyP` blends between them,
  // which is what makes the "unroll" animation.
  let sky = null;       // geometry of the last draw, for hover hit-testing
  function skyGeom(w, h) {
    const s = st.site, polar = Math.abs(s.lat) > 70, mask = Engine.maskOf(s, st.mast);
    let lo, hi;
    if (polar) {
      let mn = 0, mx = 0, sm = -90, em = -90;
      for (const v of mask) { if (v < mn) mn = v; if (v > mx) mx = v; }
      let sl = 90, el = 90;      // lowest Sun and Earth elevations in the window
      for (let i = 0; i < S.n; i++) { if (S.sunEl[i] > sm) sm = S.sunEl[i]; if (S.earthEl[i] > em) em = S.earthEl[i]; if (S.sunEl[i] < sl) sl = S.sunEl[i]; if (S.earthEl[i] < el) el = S.earthEl[i]; }
      // The range covers the whole Sun and Earth paths (plus room for their discs),
      // so neither is cut off at the bottom when it sinks far below the terrain.
      lo = Math.floor(Math.min(-4, mn - 1, sl - 0.8, el - 1.5)); hi = Math.ceil(Math.max(8, mx + 1.5, sm + 1, em + 1.5));
    } else { lo = -10; hi = 90; }
    // Centre the panorama on Earth's side of the sky (north at the south pole).
    let ce = 0, cn = 0; for (let i = 0; i < S.n; i += 8) { ce += Math.sin(S.earthAz[i] * D2R); cn += Math.cos(S.earthAz[i] * D2R); }
    const azC = Math.round(Astro.norm(Math.atan2(ce, cn) / D2R) / 90) * 90 % 360;
    const L = 46, T = 12, W = w - L - 12, H = h - T - 30, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 26;
    const p = st.skyP;
    const map = (az, el) => {
      const e = Math.min(hi, Math.max(lo, el)), u = (hi - e) / (hi - lo);
      const px = L + (((az - azC + 540) % 360)) / 360 * W, py = T + u * H;
      const dx = cx + R * u * Math.sin(az * D2R), dy = cy - R * u * Math.cos(az * D2R);
      return [px + (dx - px) * p, py + (dy - py) * p];
    };
    const scale = (H / (hi - lo)) * (1 - p) + (R / (hi - lo)) * p;     // pixels per degree of elevation
    return { lo, hi, azC, L, T, W, H, cx, cy, R, map, scale, p };
  }

  function drawSky() {
    const cv = $('sky'), { c, w, h } = fit(cv), g = skyGeom(w, h), mask = Engine.maskOf(st.site, st.mast);
    sky = g;
    const sun = css('--sun'), earth = css('--earth'), ground = css('--ground'), edge = css('--ground-edge');
    c.fillStyle = css('--sky'); c.fillRect(0, 0, w, h);
    c.font = '11px ' + css('--mono'); c.textBaseline = 'middle';

    // helper: draw a line through many (az, el) points, lifting the pen where
    // the panorama wraps round from its right edge to its left edge
    const line = (n, get) => {
      c.beginPath(); let px = null, py = null;
      for (let i = 0; i < n; i++) {
        const [az, el] = get(i), [x, y] = g.map(az, el);
        if (px === null || (g.p < 0.5 && Math.abs(x - px) > g.W / 2)) c.moveTo(x, y); else c.lineTo(x, y);
        px = x; py = y;
      }
      c.stroke();
    };

    // grid: elevation rings / lines
    const stepEl = g.hi - g.lo > 40 ? 15 : g.hi - g.lo > 16 ? 5 : 2;
    c.lineWidth = 1;
    for (let e = Math.ceil(g.lo / stepEl) * stepEl; e <= g.hi; e += stepEl) {
      c.strokeStyle = e === 0 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.12)';
      c.setLineDash(e === 0 ? [5, 4] : []);
      line(361, i => [g.azC - 180 + i * 0.999, e]);
      const [x, y] = g.map(g.azC - 180, e);
      c.fillStyle = 'rgba(255,255,255,.6)'; c.textAlign = 'right';
      c.fillText((e > 0 ? '+' : '') + e + '°', x - 5 + g.p * 2, y);
    }
    c.setLineDash([]);
    // grid: compass directions
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    c.textAlign = 'center';
    for (let a = 0; a < 360; a += 45) {
      c.strokeStyle = 'rgba(255,255,255,.12)';
      const [x0, y0] = g.map(a, g.hi), [x1, y1] = g.map(a, g.lo);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      const out = 13; const dx = (x1 - g.cx), dy = (y1 - g.cy), dl = Math.hypot(dx, dy) || 1;
      c.fillStyle = a % 90 === 0 ? '#fff' : 'rgba(255,255,255,.6)';
      c.fillText(names[a], x1 + g.p * out * dx / dl, y1 + (1 - g.p) * 16 + g.p * out * dy / dl);
    }

    // Sun and Earth discs, drawn to the elevation scale. They go UNDER the
    // terrain so the skyline hides them exactly as it would in reality.
    const disc = (b, color) => { const [x, y] = g.map(b.az, b.el); return { x, y, r: b.radius * g.scale }; };
    const sd = disc(now.p.sun), ed = disc(now.p.earth);
    const grd = c.createRadialGradient(sd.x, sd.y, 0, sd.x, sd.y, Math.max(sd.r * 4, 14));
    grd.addColorStop(0, 'rgba(255,214,120,.55)'); grd.addColorStop(1, 'rgba(255,214,120,0)');
    c.fillStyle = grd; c.beginPath(); c.arc(sd.x, sd.y, Math.max(sd.r * 4, 14), 0, 7); c.fill();
    c.fillStyle = '#ffe9a8'; c.beginPath(); c.arc(sd.x, sd.y, Math.max(sd.r, 1.5), 0, 7); c.fill();
    // Earth with its phase: the lit side faces the Sun
    c.save(); c.translate(ed.x, ed.y); c.rotate(Math.atan2(sd.y - ed.y, sd.x - ed.x));
    const er = Math.max(ed.r, 3), k = now.p.earth.phase;
    c.fillStyle = '#16293d'; c.beginPath(); c.arc(0, 0, er, 0, 7); c.fill();
    c.fillStyle = '#7cc4f2'; c.beginPath(); c.arc(0, 0, er, -Math.PI / 2, Math.PI / 2);
    if (k < 0.5) c.ellipse(0, 0, er * (1 - 2 * k), er, 0, Math.PI / 2, -Math.PI / 2, true);
    else c.ellipse(0, 0, er * (2 * k - 1), er, 0, Math.PI / 2, 3 * Math.PI / 2, false);
    c.fill(); c.restore();

    // terrain: a filled shape from the skyline down to the bottom of the plot
    c.beginPath();
    for (let i = 0; i <= 720; i++) { const az = g.azC - 180 + i * 0.4999, [x, y] = g.map(az, Engine.maskAt(mask, az)); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    for (let i = 720; i >= 0; i--) { const [x, y] = g.map(g.azC - 180 + i * 0.4999, g.lo); c.lineTo(x, y); }
    c.closePath(); c.fillStyle = ground; c.fill();
    c.strokeStyle = edge; c.lineWidth = 1.3;
    line(721, i => { const az = g.azC - 180 + i * 0.4999; return [az, Engine.maskAt(mask, az)]; });

    // paths over the window: bright where the body is above the terrain
    const path = (az, el, vis, color) => {
      c.lineWidth = 1.6;
      for (const on of [0, 1]) {
        c.strokeStyle = color; c.globalAlpha = on ? 0.95 : 0.3; c.beginPath(); let px = null;
        for (let i = 0; i < S.n; i++) {
          const [x, y] = g.map(az[i], el[i]);
          const show = (vis[i] > 0) === !!on || (i > 0 && (vis[i - 1] > 0) === !!on);
          if (px === null || !show || (g.p < 0.5 && Math.abs(x - px) > g.W / 2)) c.moveTo(x, y); else c.lineTo(x, y);
          px = x;
        }
        c.stroke();
      }
      c.globalAlpha = 1;
    };
    path(S.sunAz, S.sunEl, S.sunFrac, sun); path(S.earthAz, S.earthEl, S.earthVis, earth);

    // markers so the Sun and Earth can be found even when hidden or tiny
    const mark = (d, color, label, up) => {
      c.strokeStyle = color; c.lineWidth = 1.5; c.setLineDash(up ? [] : [3, 3]);
      c.beginPath(); c.arc(d.x, d.y, Math.max(d.r, 3) + 4, 0, 7); c.stroke(); c.setLineDash([]);
      c.fillStyle = color; c.textAlign = 'left'; c.font = '600 12px ' + css('--font');
      c.fillText(label + (up ? '' : ' (hidden)'), d.x + Math.max(d.r, 3) + 8, d.y - 8);
    };
    mark(sd, sun, 'Sun', now.sunUp); mark(ed, earth, 'Earth', now.earthUp);
    // Which DSN complexes are turned toward the Moon right now (written under the Earth label)
    const facing = now.stations.map(q => q.name);
    c.font = '11.5px ' + css('--font'); c.fillStyle = facing.length ? '#dfe6ee' : 'rgba(255,255,255,.6)'; c.textAlign = 'left';
    c.fillText(facing.length ? 'DSN facing: ' + facing.join(' + ') : 'No DSN complex facing', ed.x + Math.max(ed.r, 3) + 8, ed.y + 7);
    $('skyDsn').innerHTML = '<span class="hint">DSN complexes now:</span>' + Engine.DSN.map((q, k) => {
      const on = now.dsnEl[k] >= st.dsnMinEl;
      return `<span class="pill ${on ? '' : 'off'}" title="${on ? 'This complex has the Moon above its minimum elevation, so it can point at the lander.' : 'The Moon is too low or below the horizon at this complex.'}"><i style="background:${on ? css('--dsn' + (k + 1)) : 'transparent'};border:1px solid ${css('--dsn' + (k + 1))}"></i>${q.name}: ${on ? 'facing' : 'not facing'} (Moon ${deg(now.dsnEl[k], 0)})</span>`;
    }).join('') + (now.stations.length && !now.earthUp ? '<span class="pill bad">but Earth is behind terrain here</span>' : '');

    // ghost positions for the time being hovered on the timeline
    if (st.hoverT != null) {
      const q = Engine.pos(st.site, st.hoverT);
      for (const [b, color] of [[q.sun, sun], [q.earth, earth]]) {
        const [x, y] = g.map(b.az, b.el); c.strokeStyle = color; c.lineWidth = 1; c.setLineDash([2, 2]);
        c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke(); c.setLineDash([]);
      }
    }
    // hovered compass bearing
    if (st.hoverAz != null) {
      const [x0, y0] = g.map(st.hoverAz, g.hi), [x1, y1] = g.map(st.hoverAz, g.lo);
      c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    }

    const polar = Math.abs(st.site.lat) > 70;
    $('skyCaption').textContent = (st.skyMode === 'pano'
      ? `Panorama: the full horizon unrolled, centred on ${names[g.azC] || g.azC + '°'}. Up is higher in the sky. `
      : `Dial: looking up, north at the top. The centre is ${g.hi === 90 ? 'straight overhead' : '+' + g.hi + '° elevation'}; the dashed ring is the flat horizon. `) +
      `Elevation ${g.lo}° to +${g.hi}°. Sun and Earth sizes follow the elevation scale.`;
    $('skyGuide').innerHTML = polar
      ? '<b>What you are looking at.</b> The grey shape is the real skyline from this spot, traced from NASA laser altimetry. The Sun travels sideways along the horizon rather than rising overhead, so it keeps ducking behind hills. Wherever the orange path dips into the grey, the site is in shadow.'
      : '<b>What you are looking at.</b> Away from the poles the Sun rises in the east, climbs high and sets in the west over about two weeks of daylight, followed by two weeks of night. Earth stays almost fixed in the sky, wobbling slightly.';
  }

  function animateSky(target) {
    st.skyMode = target ? 'dial' : 'pano';
    $('skyPano').classList.toggle('on', !target); $('skyDial').classList.toggle('on', !!target);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { st.skyP = target; drawSky(); return; }
    const from = st.skyP, t0 = performance.now();
    const step = tn => {
      const u = Math.min(1, (tn - t0) / 650), e = u * u * (3 - 2 * u);   // ease in and out
      st.skyP = from + (target - from) * e; drawSky();
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ timelines
  const TL = { left: 150, right: 14, rows: [
    { id: 'sun', grp: 'sun', label: 'Sun elevation', h: 78 }, { id: 'earth', grp: 'earth', label: 'Earth elevation', h: 66 },
    { id: 'gds', grp: 'dsn', label: 'DSN Goldstone', h: 13 }, { id: 'mad', grp: 'dsn', label: 'DSN Madrid', h: 13 }, { id: 'cbr', grp: 'dsn', label: 'DSN Canberra', h: 13 },
    { id: 'green', grp: 'green', label: 'Sun + link', h: 15 }, { id: 'power', grp: 'power', label: 'Power (W)', h: 60 }, { id: 'batt', grp: 'batt', label: 'Battery (%)', h: 54 }] };
  // Which rows are switched on (the "Show rows" checkboxes), and the canvas height they need.
  const tlRows = () => TL.rows.filter(r => st.show[r.grp]);
  const rowGap = r => (r.id === 'gds' || r.id === 'mad' ? 2 : 9);
  const tlHeight = () => 8 + tlRows().reduce((a, r) => a + r.h + rowGap(r), 0) + 30;
  let tlCache = null;      // the static part of the timeline, drawn once per series

  function tlX(w, t) { return TL.left + (t - st.t0) / (st.hours * HOUR) * (w - TL.left - TL.right); }
  function tlT(w, x) { return st.t0 + Math.min(1, Math.max(0, (x - TL.left) / (w - TL.left - TL.right))) * st.hours * HOUR; }

  function renderTimeline(w, h, dpr) {
    const off = document.createElement('canvas'); off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
    const c = off.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css('--ink'), muted = css('--muted'), lineC = css('--line'), sun = css('--sun'), earth = css('--earth'), green = css('--green'), warn = css('--warn'), accent = css('--accent');
    const X = i => TL.left + i / (S.n - 1) * (w - TL.left - TL.right), x0 = TL.left, x1 = w - TL.right;
    c.font = '12px ' + css('--font'); c.textBaseline = 'middle';
    // Fill the stretches of the series where test(i) is true.
    const bands = (y, hh, test, color, alpha) => {
      c.fillStyle = color; c.globalAlpha = alpha; let a = -1;
      for (let i = 0; i <= S.n; i++) {
        const on = i < S.n && test(i);
        if (on && a < 0) a = i;
        if (!on && a >= 0) { c.fillRect(X(Math.max(0, a - 0.5)), y, Math.max(1, X(Math.min(S.n - 1, i - 0.5)) - X(Math.max(0, a - 0.5))), hh); a = -1; }
      }
      c.globalAlpha = 1;
    };
    const curve = (y, hh, arr, lo, hi, color, width, dash) => {
      c.strokeStyle = color; c.lineWidth = width; c.setLineDash(dash || []); c.beginPath();
      for (let i = 0; i < S.n; i++) { const yy = y + hh - (Math.min(hi, Math.max(lo, arr[i])) - lo) / (hi - lo) * hh; i ? c.lineTo(X(i), yy) : c.moveTo(X(i), yy); }
      c.stroke(); c.setLineDash([]);
    };
    const range = (...arrs) => { let lo = 1e9, hi = -1e9; for (const a of arrs) for (let i = 0; i < S.n; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } const pad = Math.max(0.5, (hi - lo) * 0.08); return [Math.max(-90, lo - pad), Math.min(90, hi + pad)]; };
    const yTicks = (y, hh, lo, hi, unit) => { c.fillStyle = muted; c.textAlign = 'right'; c.font = '10.5px ' + css('--mono'); c.fillText(hi.toFixed(Math.abs(hi) < 20 ? 1 : 0) + unit, x0 - 5, y + 6); c.fillText(lo.toFixed(Math.abs(lo) < 20 ? 1 : 0) + unit, x0 - 5, y + hh - 6); c.font = '12px ' + css('--font'); };

    let y = 8; const pos = {};
    for (const r of tlRows()) {
      pos[r.id] = y;
      c.fillStyle = ink; c.textAlign = 'left'; c.fillText(r.label, 4, y + (r.h > 20 ? 10 : r.h / 2));
      c.strokeStyle = lineC; c.lineWidth = 1; c.strokeRect(x0 + .5, y + .5, x1 - x0, r.h);
      if (r.id === 'sun') {
        const [lo, hi] = range(S.sunEl, S.sunHz);
        bands(y, r.h, i => S.sunFrac[i] > 0, sun, 0.22);
        curve(y, r.h, S.sunHz, lo, hi, muted, 1, [3, 3]); curve(y, r.h, S.sunEl, lo, hi, sun, 1.8);
        yTicks(y, r.h, lo, hi, '°'); c.fillStyle = muted; c.textAlign = 'left'; c.font = '10.5px ' + css('--font');
        c.fillText('dashed = terrain', 4, y + 26); c.fillText('shaded = sunlit', 4, y + 40);
      } else if (r.id === 'earth') {
        const [lo, hi] = range(S.earthEl, S.earthHz);
        bands(y, r.h, i => S.earthVis[i], earth, 0.22);
        curve(y, r.h, S.earthHz, lo, hi, muted, 1, [3, 3]); curve(y, r.h, S.earthEl, lo, hi, earth, 1.8);
        yTicks(y, r.h, lo, hi, '°'); c.fillStyle = muted; c.textAlign = 'left'; c.font = '10.5px ' + css('--font'); c.fillText('shaded = visible', 4, y + 26);
      } else if (r.id === 'gds' || r.id === 'mad' || r.id === 'cbr') {
        const k = ['gds', 'mad', 'cbr'].indexOf(r.id), col = css('--dsn' + (k + 1));
        bands(y + 2, r.h - 3, i => S.dsn[i] >> k & 1, col, 0.25);                       // Moon in view of the complex
        bands(y + 2, r.h - 3, i => (S.dsn[i] >> k & 1) && S.earthVis[i], col, 1);      // ...and Earth visible from the site
        bands(y, r.h + (k < 2 ? 2 : 0), i => S.dsn[i] === 0, warn, 0.75);                  // coverage gap: no complex at all (red, across all three lanes)
      } else if (r.id === 'green') {
        bands(y + 2, r.h - 3, i => S.green[i], green, 1);
      } else if (r.id === 'power') {
        const hi = Math.max(S.stats.peakW, st.loadW) * 1.1 || 1;
        c.fillStyle = accent; c.globalAlpha = 0.3; c.beginPath(); c.moveTo(X(0), y + r.h);
        for (let i = 0; i < S.n; i++) c.lineTo(X(i), y + r.h - S.power[i] / hi * r.h);
        c.lineTo(X(S.n - 1), y + r.h); c.fill(); c.globalAlpha = 1;
        curve(y, r.h, S.power, 0, hi, accent, 1.5);
        const yl = y + r.h - st.loadW / hi * r.h; c.strokeStyle = warn; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(x0, yl); c.lineTo(x1, yl); c.stroke(); c.setLineDash([]);
        yTicks(y, r.h, 0, hi, ''); c.fillStyle = muted; c.textAlign = 'left'; c.font = '10.5px ' + css('--font'); c.fillText('dashed = load', 4, y + 26);
      } else if (r.id === 'batt' && st.batteryWh > 0) {
        bands(y, r.h, i => S.soc[i] <= 0, warn, 0.3);
        const pc = Float32Array.from(S.soc, v => 100 * v / st.batteryWh);
        curve(y, r.h, pc, 0, 104, green, 1.8); yTicks(y, r.h, 0, 100, '');
        c.fillStyle = muted; c.textAlign = 'left'; c.font = '10.5px ' + css('--font'); c.fillText('red = empty', 4, y + 26);
      }
      c.font = '12px ' + css('--font');
      y += r.h + rowGap(r);
    }
    // time axis: choose a tick spacing that gives roughly 6-12 labels
    const spanH = st.hours, stepH = [1, 2, 3, 6, 12, 24, 48, 120, 240, 720, 1440].find(s => spanH / s <= 12) || 2160;
    c.fillStyle = muted; c.textAlign = 'center'; c.font = '11px ' + css('--mono');
    for (let t = Math.ceil(st.t0 / (stepH * HOUR)) * stepH * HOUR; t <= st.t0 + spanH * HOUR; t += stepH * HOUR) {
      const x = tlX(w, t), d = new Date(t);
      c.strokeStyle = lineC; c.beginPath(); c.moveTo(x, 8); c.lineTo(x, y - 6); c.globalAlpha = 0.5; c.stroke(); c.globalAlpha = 1;
      c.fillText(stepH < 24 ? `${pad(d.getUTCHours())}:00` : fmtDay(t), x, y + 4);
      if (stepH < 24 && d.getUTCHours() === 0) c.fillText(fmtDay(t), x, y + 17);
    }
    return { off, pos, bottom: y };
  }

  function drawTimeline() {
    const cv = $('tl'); cv.style.height = tlHeight() + 'px';      // the canvas shrinks when rows are hidden
    if (!cv.clientWidth) return;
    const { c, w, h } = fit(cv), dpr = window.devicePixelRatio || 1;
    if (!tlCache || tlCache.w !== w || tlCache.h !== h) { tlCache = renderTimeline(w, h, dpr); tlCache.w = w; tlCache.h = h; }
    c.clearRect(0, 0, w, h); c.drawImage(tlCache.off, 0, 0, w, h);
    const vline = (t, color, width, dash) => { const x = tlX(w, t); c.strokeStyle = color; c.lineWidth = width; c.setLineDash(dash || []); c.beginPath(); c.moveTo(x, 4); c.lineTo(x, tlCache.bottom - 4); c.stroke(); c.setLineDash([]); };
    if (st.hoverT != null) vline(st.hoverT, css('--muted'), 1, [3, 3]);
    vline(st.t, css('--ink'), 2);
  }

  // ------------------------------------------------------------ lander drawing
  // A tiny 3D renderer: every shape is a flat polygon; we turn the scene to the
  // camera, sort polygons far-to-near, and fill them in that order.
  function drawLander() {
    const cv = $('lander'), { c, w, h } = fit(cv), cfg = st.lander;
    c.clearRect(0, 0, w, h);
    const camAz = 205 * D2R, camEl = (st.topDown ? 90 : 36) * D2R, sc = Math.min(w, h * 1.5) / 7.6, ox = w / 2, oy = h * (st.topDown ? 0.5 : 0.66);
    // world (east, north, up) -> screen x, y and depth (bigger = nearer)
    const proj = v => {
      const xr = st.topDown ? v[0] : v[0] * Math.cos(camAz) - v[1] * Math.sin(camAz);
      const yr = st.topDown ? v[1] : v[0] * Math.sin(camAz) + v[1] * Math.cos(camAz);
      return [ox + xr * sc, oy - (yr * Math.sin(camEl) + v[2] * Math.cos(camEl)) * sc, -yr * Math.cos(camEl) + v[2] * Math.sin(camEl)];
    };
    const B = v => Engine.bodyToWorld(cfg, v);
    const faces = [], labels = [];
    const add = (pts, fill, stroke) => { const q = pts.map(proj); faces.push({ q, fill, stroke, z: q.reduce((a, b) => a + b[2], 0) / q.length }); };
    const ramp = f => { f = Math.max(0, Math.min(1, f)); const a = [38, 48, 64], b = [255, 205, 70]; return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * Math.sqrt(f))).join(',')})`; };
    const fluxMax = 1361 * cfg.eff, bodyCol = css('--muted'), lineC = css('--ink');

    // ground disc with compass marks
    c.strokeStyle = css('--line'); c.fillStyle = css('--panel'); c.lineWidth = 1; c.beginPath();
    for (let a = 0; a <= 360; a += 6) { const [x, y] = proj([3.3 * Math.sin(a * D2R), 3.3 * Math.cos(a * D2R), 0]); a ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.closePath(); c.fill(); c.stroke();
    c.fillStyle = css('--muted'); c.font = '600 12px ' + css('--font'); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [a, n] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) { const [x, y] = proj([3.65 * Math.sin(a * D2R), 3.65 * Math.cos(a * D2R), 0]); c.fillText(n, x, y); }

    if (cfg.kind === 'mast') {
      // small base, a mast, and one tall panel that turns to face the Sun's bearing
      const az = now.p.sun.az * D2R, wv = [Math.cos(az), -Math.sin(az), 0], hw = 0.9, ph = Math.min(4.5, cfg.mastArea / (2 * hw));
      for (let k = 0; k < 4; k++) { const a0 = (k * 90 + 45) * D2R, a1 = a0 + Math.PI / 2; add([[0.6 * Math.sin(a0), 0.6 * Math.cos(a0), 0.2], [0.6 * Math.sin(a1), 0.6 * Math.cos(a1), 0.2], [0.6 * Math.sin(a1), 0.6 * Math.cos(a1), 0.9], [0.6 * Math.sin(a0), 0.6 * Math.cos(a0), 0.9]], bodyCol, lineC); }
      add([[-0.05, 0, 0.9], [0.05, 0, 0.9], [0.05, 0, 1.6], [-0.05, 0, 1.6]], bodyCol, lineC);
      const f = now.watts / (fluxMax * cfg.mastArea || 1);
      add([[-hw * wv[0], -hw * wv[1], 1.6], [hw * wv[0], hw * wv[1], 1.6], [hw * wv[0], hw * wv[1], 1.6 + ph], [-hw * wv[0], -hw * wv[1], 1.6 + ph]], ramp(f), lineC);
    } else {
      const N = cfg.sides >= 4 ? cfg.sides : cfg.sides * 2, rb = 0.9, rv = rb / Math.cos(Math.PI / N), z0 = 0.55, z1 = 1.75;
      const vert = (k, z, r) => { const a = ((k - 0.5) * 360 / N) * D2R; return B([r * Math.sin(a), r * Math.cos(a), z]); };
      for (let k = 0; k < N; k++) add([vert(k, z0, rv), vert(k + 1, z0, rv), vert(k + 1, z1, rv), vert(k, z1, rv)], bodyCol, lineC);          // body walls
      add(Array.from({ length: N }, (_, k) => vert(k, z1, rv)), bodyCol, lineC);                                                                // body top
      for (let k = 0; k < 4; k++) { const a = (k * 90 + 45) * D2R; add([B([0.7 * Math.sin(a), 0.7 * Math.cos(a), z0]), B([1.5 * Math.sin(a), 1.5 * Math.cos(a), 0]), B([1.55 * Math.sin(a), 1.55 * Math.cos(a), 0])], lineC, lineC); }   // legs
      // panels, coloured by output: index 0 is the top deck, then the sides
      now.pl.forEach((p, k) => {
        const f = now.per[k] / (fluxMax * p.area || 1);
        if (p.bodyAz === null) {
          if (p.area <= 0) return;
          const r = Math.min(rv * 0.95, Math.sqrt(p.area / (N / 2 * Math.sin(2 * Math.PI / N))));
          add(Array.from({ length: N }, (_, j) => vert(j, z1 + 0.04, r)), ramp(f), lineC);
        } else {
          const a = p.bodyAz * D2R, half = rb * Math.tan(Math.PI / N) * 0.9, ph = Math.max(0.4, Math.min(2.2, p.area / (2 * half)));
          const n = [Math.sin(a), Math.cos(a)], tv = [Math.cos(a), -Math.sin(a)], r = rb + 0.05;
          add([B([r * n[0] - half * tv[0], r * n[1] - half * tv[1], z0]), B([r * n[0] + half * tv[0], r * n[1] + half * tv[1], z0]),
            B([r * n[0] + half * tv[0], r * n[1] + half * tv[1], z0 + ph]), B([r * n[0] - half * tv[0], r * n[1] - half * tv[1], z0 + ph])], ramp(f), lineC);
          labels.push({ at: proj(B([(r + 0.55) * n[0], (r + 0.55) * n[1], z0 + ph / 2])), text: String(k) });
        }
      });
    }
    faces.sort((a, b) => a.z - b.z);
    for (const f of faces) { c.beginPath(); f.q.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fillStyle = f.fill; c.fill(); c.strokeStyle = f.stroke; c.lineWidth = 0.8; c.stroke(); }

    c.fillStyle = css('--ink'); c.font = '600 11px ' + css('--font'); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of labels) {   // panel number on a small chip so it stays readable over anything behind it
      c.fillStyle = css('--panel'); c.strokeStyle = css('--line'); c.beginPath(); c.arc(l.at[0], l.at[1], 8, 0, 7); c.fill(); c.stroke();
      c.fillStyle = css('--ink'); c.fillText(l.text, l.at[0], l.at[1] + 0.5);
    }
    // Sun arrow: from the Sun's direction toward the lander
    const s = now.p.sun, ce = Math.cos(s.el * D2R), dir = [ce * Math.sin(s.az * D2R), ce * Math.cos(s.az * D2R), Math.sin(s.el * D2R)];
    const A = proj([dir[0] * 3.4, dir[1] * 3.4, dir[2] * 3.4 + 1.1]), Bp = proj([dir[0] * 1.9, dir[1] * 1.9, dir[2] * 1.9 + 1.1]);
    const sunC = css('--sun'); c.strokeStyle = sunC; c.fillStyle = sunC; c.lineWidth = 2.5; c.globalAlpha = now.sunUp ? 1 : 0.4; c.setLineDash(now.sunUp ? [] : [5, 4]);
    c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(Bp[0], Bp[1]); c.stroke(); c.setLineDash([]);
    const ang = Math.atan2(Bp[1] - A[1], Bp[0] - A[0]);
    c.beginPath(); c.moveTo(Bp[0], Bp[1]); c.lineTo(Bp[0] - 10 * Math.cos(ang - 0.4), Bp[1] - 10 * Math.sin(ang - 0.4)); c.lineTo(Bp[0] - 10 * Math.cos(ang + 0.4), Bp[1] - 10 * Math.sin(ang + 0.4)); c.closePath(); c.fill();
    c.beginPath(); c.arc(A[0], A[1], 6, 0, 7); c.fill(); c.globalAlpha = 1;
    c.font = '600 12px ' + css('--font'); c.textAlign = 'center'; c.fillText('Sun', A[0], A[1] - 14);
    c.fillStyle = css('--ink'); c.textAlign = 'left'; c.font = '600 13px ' + css('--font');
    c.fillText(now.sunUp ? `${Math.round(now.watts)} W now` : 'Sun behind terrain: 0 W', 10, 14);

    // per-panel bars under the drawing
    const rows = cfg.kind === 'mast' ? [['Mast array (tracks the Sun)', now.watts, fluxMax * cfg.mastArea]]
      : now.pl.map((p, k) => [p.bodyAz === null ? 'Top deck' : `${p.name} (faces ${Math.round(Astro.norm(p.bodyAz + cfg.heading))}°)`, now.per[k], fluxMax * p.area]);
    $('panelBars').innerHTML = rows.map(([n, wv, mx]) => `<span>${n}</span><span class="bar"><i style="width:${mx > 0 ? Math.min(100, 100 * wv / mx) : 0}%"></i></span><span class="num">${Math.round(wv)} W</span>`).join('');
  }

  // ------------------------------------------------------------ slider date scale
  // Tick marks under the time slider. The left end is the window start; ticks
  // then step forward by a round interval (1 day for a 7-day window, and so on).
  const SCALE_PAD = 8;        // the slider's handle stops half its width short of each end
  // Spacing of labelled ticks and of the small ticks between them, in hours, for a scale `w` pixels wide.
  function scaleSteps(w) {
    const maxLabels = Math.max(2, Math.floor(w / 78));
    const step = [1, 2, 3, 6, 12, 24, 48, 72, 120, 168, 336, 720, 1440, 2160, 4320, 8766].find(sx => st.hours / sx <= maxLabels) || 8766;
    const minor = step >= 720 ? step / 4 : step >= 168 ? 24 : step >= 24 ? step / 4 : step > 1 ? step / (step % 3 === 0 ? 3 : 2) : 0.25;
    return { step, minor };
  }
  function drawScale() {
    const { c, w, h } = fit($('scale')); c.clearRect(0, 0, w, h);
    const X = hrs => SCALE_PAD + hrs / st.hours * (w - 2 * SCALE_PAD), { step, minor } = scaleSteps(w);
    const ink = css('--ink'), muted = css('--muted');
    c.strokeStyle = muted; c.lineWidth = 1; c.beginPath();
    for (let x = 0; x <= st.hours + 1e-6; x += minor) { c.moveTo(X(x) + .5, 0); c.lineTo(X(x) + .5, 4); }
    c.stroke();
    c.strokeStyle = ink; c.fillStyle = ink; c.font = '11px ' + css('--mono'); c.textBaseline = 'top';
    const showTime = step < 24 || new Date(st.t0).getUTCHours() !== 0 || new Date(st.t0).getUTCMinutes() !== 0;
    // labelled ticks: every `step`, plus one at the very end of the window
    // (a regular tick that would crowd the end label is left unlabelled)
    const marks = []; for (let x = 0; x < st.hours - 1e-6; x += step) marks.push(x); marks.push(st.hours);
    marks.forEach((x, k) => {
      const px = X(x), d = new Date(st.t0 + x * HOUR), last = k === marks.length - 1;
      c.beginPath(); c.moveTo(px + .5, 0); c.lineTo(px + .5, 8); c.stroke();
      if (!last && X(st.hours) - px < 62) return;
      c.textAlign = px < 30 ? 'left' : px > w - 30 ? 'right' : 'center';
      const lx = px < 30 ? 0 : px > w - 30 ? w : px, hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const offGrid = last && (d.getUTCMinutes() !== 0 || (step >= 24 && d.getUTCHours() !== new Date(st.t0).getUTCHours()));   // end not on a whole step: show its time too
      if (step < 24) { c.fillText(hm, lx, 10); if (x === 0 || last || d.getUTCHours() < step) c.fillText(fmtDay(d.getTime()), lx, 22); }
      else { c.fillText(fmtDay(d.getTime()) + (step >= 2160 ? ' ' + d.getUTCFullYear() : ''), lx, 10); if ((showTime && x === 0) || offGrid) { c.fillStyle = muted; c.fillText(hm, lx, 22); c.fillStyle = ink; } }
    });
    // marker under the slider handle
    const px = X((st.t - st.t0) / HOUR); c.fillStyle = css('--accent'); c.beginPath(); c.moveTo(px, 0); c.lineTo(px - 4, 7); c.lineTo(px + 4, 7); c.closePath(); c.fill();
  }
  // Show a window length in the number + unit boxes, picking the unit that reads best.
  function showWin(hours) {
    const lun = hours / 708.72, yr = hours / 8766, near = v => Math.abs(v - Math.round(v * 2) / 2) < 1e-3;
    const [n, u] = near(lun) ? [lun, '708.72'] : near(yr) ? [yr, '8766'] : hours % 24 === 0 || hours > 96 ? [hours / 24, '24'] : [hours, '1'];
    $('winN').value = +n.toFixed(2); $('winU').value = u;
  }

  // ------------------------------------------------------------ controls
  const toLocalInput = t => new Date(t).toISOString().slice(0, 16);
  function setWindow(t0, keepT) {
    st.t0 = t0; if (!keepT) st.t = t0;
    $('start').value = toLocalInput(t0);
    recompute();
  }

  async function selectSite(site) {
    st.site = site;
    $('status').textContent = site.eph && !site.table ? 'Loading JPL Horizons table…' : '';
    await Engine.ensureTable(site);
    $('status').textContent = '';
    // Smart default: panorama near the poles, dial at mid-latitudes
    const dial = Math.abs(site.lat) <= 70 ? 1 : 0;
    st.skyMode = dial ? 'dial' : 'pano'; st.skyP = dial;
    $('skyPano').classList.toggle('on', !dial); $('skyDial').classList.toggle('on', !!dial);
    drawSiteInfo(); MapView.setSite(site); Globe.setSite(site); Pov.setSite(site, Engine.maskOf(site, st.mast)); recompute();
  }

  function readLander() {
    const num = (id, lo, hi) => Math.min(hi, Math.max(lo, parseFloat($(id).value) || 0));
    Object.assign(st.lander, { heading: num('heading', 0, 360), tilt: num('tilt', 0, 45), tiltDir: num('tiltDir', 0, 360),
      sides: Math.round(num('sides', 2, 6)), sideArea: num('sideArea', 0.1, 20), topArea: num('topArea', 0, 20), mastArea: num('mastArea', 0.5, 100), eff: num('eff', 5, 40) / 100 });
    st.loadW = num('load', 0, 20000); st.batteryWh = num('batt', 0, 500000);
    st.dsnMinEl = num('dsnEl', 0, 45); st.mast = Math.round(num('mast', 2, 30) * 10) / 10; $('mast').value = st.mast; st.earthEdge = +$('earthEdge').value;
    recompute();
  }
  function applyPreset(key) {
    const p = Engine.LANDERS[key];
    st.lander = Object.assign({ preset: key, heading: st.lander.heading, tilt: st.lander.tilt, tiltDir: st.lander.tiltDir }, p);
    $('presetNote').textContent = p.note + ' Edit any value below.';
    $('bodyFields').style.display = p.kind === 'body' ? '' : 'none'; $('mastFields').style.display = p.kind === 'mast' ? '' : 'none';
    if (p.kind === 'body') { $('sides').value = p.sides; $('sideArea').value = p.sideArea; $('topArea').value = p.topArea; } else $('mastArea').value = p.mastArea;
    $('eff').value = Math.round(p.eff * 100);
  }

  function showTip(e, text) { const t = $('tip'); t.textContent = text; t.style.display = 'block'; t.style.left = Math.min(window.innerWidth - 270, e.clientX + 14) + 'px'; t.style.top = (e.clientY + 14) + 'px'; }
  const hideTip = () => { $('tip').style.display = 'none'; };

  function wire() {
    // site list, grouped
    const sel = $('site');
    for (const [g, label] of GROUPS) {
      const list = Engine.DB.sites.filter(s => s.group === g); if (!list.length) continue;
      const og = document.createElement('optgroup'); og.label = label;
      for (const s of list) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; og.appendChild(o); }
      sel.appendChild(og);
    }
    sel.onchange = () => selectSite(Engine.DB.byId[sel.value]);
    $('cGo').onclick = async () => {
      const lat = parseFloat($('cLat').value), lon = parseFloat($('cLon').value);
      if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 360)) { $('status').textContent = 'Enter a latitude between −90 and 90 and a longitude between −180 and 360.'; return; }
      try { await selectSite(await makeCustom(lat, lon > 180 ? lon - 360 : lon)); }
      catch (err) { $('status').textContent = 'Could not load the terrain files (' + err.message + ').'; }
    };

    const ps = $('preset');
    for (const k in Engine.LANDERS) { const o = document.createElement('option'); o.value = k; o.textContent = Engine.LANDERS[k].label; ps.appendChild(o); }
    ps.onchange = () => { applyPreset(ps.value); readLander(); };
    for (const id of ['heading', 'tilt', 'tiltDir', 'sides', 'sideArea', 'topArea', 'mastArea', 'eff', 'load', 'batt', 'dsnEl', 'mast', 'earthEdge']) $(id).onchange = readLander;

    $('start').onchange = () => { const t = Date.parse($('start').value + ':00Z'); if (!isNaN(t)) setWindow(t); };
    // Window length: any number, in the chosen unit (1 hour to 3 years)
    const readWin = () => {
      const h = parseFloat($('winN').value) * +$('winU').value;
      if (!(h > 0)) { showWin(st.hours); return; }
      st.hours = Math.min(3 * 8766, Math.max(1, h)); if (st.hours !== h) showWin(st.hours);
      recompute();
    };
    $('winN').onchange = readWin; $('winU').onchange = readWin;
    // The date scale under the slider can be clicked or dragged too
    const sc = $('scale'); let scDrag = false;
    const scT = e => { const r = sc.getBoundingClientRect(); return st.t0 + Math.min(1, Math.max(0, (e.clientX - r.left - SCALE_PAD) / (r.width - 2 * SCALE_PAD))) * st.hours * HOUR; };
    // A click snaps to the nearest tick: on the date labels, to the labelled tick;
    // on the tick row, to the nearest small tick. Dragging afterwards moves freely.
    sc.onpointerdown = e => {
      scDrag = true; sc.setPointerCapture(e.pointerId); stop();
      const r = sc.getBoundingClientRect(), { step, minor } = scaleSteps(r.width), unit = (e.clientY - r.top > 9 ? step : minor) * HOUR;
      const tEnd = st.t0 + st.hours * HOUR, tc = scT(e), snap = Math.min(tEnd, st.t0 + Math.round((tc - st.t0) / unit) * unit);
      setTime(Math.abs(tEnd - tc) < Math.abs(snap - tc) ? tEnd : snap);      // the end of the window is a tick too
    };
    let scX = 0; sc.addEventListener('pointerdown', e => { scX = e.clientX; });
    sc.onpointermove = e => { if (scDrag && Math.abs(e.clientX - scX) > 3) { scX = -99; setTime(scT(e)); } };   // ignore tiny wobbles so a click stays snapped
    sc.onpointerup = () => { scDrag = false; };
    $('today').onclick = () => setWindow(Math.floor(Date.now() / 86400000) * 86400000);
    $('scrub').oninput = () => setTime(st.t0 + $('scrub').value / 1000 * st.hours * HOUR);
    $('speed').onchange = () => { st.speed = +$('speed').value; };
    $('play').onclick = togglePlay;
    // section shortcuts (buttons rather than #links, because the page address is used for scenario codes)
    document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { const h = $(b.dataset.go); h.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); });
    document.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => {
      const t = nextEvent(b.dataset.jump);
      if (t == null) { $('status').textContent = `No ${b.dataset.jump} within 120 days of the window.`; return; }
      $('status').textContent = '';
      // if the event lies beyond the window, slide the window so it is in view
      if (t > st.t0 + st.hours * HOUR) { st.t = t; setWindow(t - 0.15 * st.hours * HOUR, true); } else setTime(t);
    });

    $('skyPano').onclick = () => animateSky(0); $('skyDial').onclick = () => animateSky(1);
    $('topDown').onclick = () => { st.topDown = !st.topDown; $('topDown').setAttribute('aria-pressed', st.topDown); drawLander(); };
    const setMode = expert => { document.body.classList.toggle('expert', expert); $('modeExpert').setAttribute('aria-pressed', expert); $('modeGuide').setAttribute('aria-pressed', !expert); };
    $('modeGuide').onclick = () => setMode(false); $('modeExpert').onclick = () => setMode(true);

    // sky hover: which compass bearing is under the pointer?
    const skyCv = $('sky');
    skyCv.onpointermove = e => {
      const r = skyCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, g = sky; if (!g) return;
      let az;
      if (st.skyMode === 'pano') { if (x < g.L || x > g.L + g.W) { skyCv.onpointerleave(); return; } az = Astro.norm(g.azC - 180 + (x - g.L) / g.W * 360); }
      else az = Astro.norm(Math.atan2(x - g.cx, g.cy - y) / D2R);
      st.hoverAz = az;
      // nearest time (to the current time) at which the Sun is on this bearing -> shown on the timeline
      let best = null, bd = 1e18;
      for (let i = 0; i < S.n; i++) { const d = Math.abs(((S.sunAz[i] - az + 540) % 360) - 180); if (d < 0.6) { const dtm = Math.abs(st.t0 + i * S.dt - st.t); if (dtm < bd) { bd = dtm; best = i; } } }
      st.hoverT = best == null ? null : st.t0 + best * S.dt;
      showTip(e, `Bearing ${az.toFixed(1)}° (${compass(az)})\nTerrain skyline ${deg(Engine.maskAt(Engine.maskOf(st.site, st.mast), az), 2)}` + (best == null ? '' : `\nSun on this bearing: ${fmtUTC(st.hoverT)}, ${S.sunFrac[best] > 0 ? 'visible' : 'hidden'}`));
      drawSky(); drawTimeline();
    };
    skyCv.onpointerleave = () => { st.hoverAz = null; st.hoverT = null; hideTip(); drawSky(); drawTimeline(); };

    // timeline row checkboxes
    document.querySelectorAll('#tlChecks input').forEach(cb => cb.onchange = () => { st.show[cb.dataset.row] = cb.checked; tlCache = null; drawTimeline(); });
    // timeline: hover shows values, click/drag moves the time
    const tl = $('tl'); let dragging = false;
    const tAt = e => { const r = tl.getBoundingClientRect(); return tlT(r.width, e.clientX - r.left); };
    tl.onpointerdown = e => { dragging = true; tl.setPointerCapture(e.pointerId); stop(); setTime(tAt(e)); };
    tl.onpointerup = () => { dragging = false; };
    tl.onpointermove = e => {
      const t = tAt(e); if (dragging) setTime(t);
      const i = Math.min(S.n - 1, Math.round((t - st.t0) / S.dt));
      st.hoverT = t;
      const st3 = Engine.DSN.filter((c, k) => S.dsn[i] >> k & 1).map(c => c.name).join(', ') || 'none';
      showTip(e, `${fmtUTC(t)}\nSun ${deg(S.sunEl[i], 2)} (terrain ${deg(S.sunHz[i], 2)}): ${S.sunFrac[i] > 0 ? 'sunlit' : 'shadow'}\nEarth ${deg(S.earthEl[i], 2)} (terrain ${deg(S.earthHz[i], 2)}): ${S.earthVis[i] ? 'visible' : 'hidden'}\nDSN with Moon in view: ${st3}\nPower ${Math.round(S.power[i])} W · battery ${st.batteryWh > 0 ? Math.round(100 * S.soc[i] / st.batteryWh) + ' %' : '—'}`);
      drawSky(); drawTimeline();
    };
    tl.onpointerleave = () => { st.hoverT = null; hideTip(); drawSky(); drawTimeline(); };

    // keyboard: Space = play/pause, arrows = step, D = switch sky layout
    document.addEventListener('keydown', e => {
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || (e.key === ' ' && e.target.tagName === 'BUTTON')) return;   // let form controls keep their own keys
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') setTime(st.t + S.dt * (e.shiftKey ? 10 : 1));
      else if (e.key === 'ArrowLeft') setTime(st.t - S.dt * (e.shiftKey ? 10 : 1));
      else if (e.key === 'd' || e.key === 'D') animateSky(st.skyMode === 'pano' ? 1 : 0);
    });
    let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { tlCache = null; if (S) { setTime(st.t); drawCompare(); drawFind(); MapView.draw(); Globe.render(); Pov.render(); } }, 100); });
    // redraw when the viewer's light/dark theme changes (canvas colours come from CSS)
    const redraw = () => { tlCache = null; if (S) { setTime(st.t); drawCompare(); drawFind(); } };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // Build a custom site (loads terrain the first time) and list it in the site menu.
  async function makeCustom(lat, lon) {
    $('status').textContent = 'Loading terrain and tracing the horizon…';
    const site = await Engine.customSite(lat, lon), sel = $('site');
    site.name = `Custom site (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
    Engine.DB.byId.custom = site;
    let o = sel.querySelector('option[value=custom]');
    if (!o) { const og = document.createElement('optgroup'); og.label = 'Your custom site'; o = document.createElement('option'); o.value = 'custom'; og.appendChild(o); sel.appendChild(og); }
    o.textContent = site.name; sel.value = 'custom'; $('cLat').value = lat; $('cLon').value = lon;
    $('status').textContent = '';
    return site;
  }

  // ============================================================ step 4
  // A "scenario" is everything needed to reproduce a result: site, window and
  // settings, as plain data. Comparison, sharing and loading all use it.
  function snapshot() {
    const L = st.lander;
    return { site: st.site.custom ? { lat: st.site.lat, lon: st.site.lon } : st.site.id, t0: st.t0, hours: st.hours,
      mast: st.mast, earthEdge: st.earthEdge, dsnMinEl: st.dsnMinEl, loadW: st.loadW, batteryWh: st.batteryWh,
      lander: { preset: L.preset, heading: L.heading, tilt: L.tilt, tiltDir: L.tiltDir, sides: L.sides || 3, sideArea: L.sideArea || 1, topArea: L.topArea || 0, mastArea: L.mastArea || 4, eff: L.eff } };
  }
  const landerOf = c => Object.assign({}, Engine.LANDERS[c.lander.preset], c.lander);
  const optOf = c => ({ t0: c.t0, hours: c.hours, mast: c.mast, earthEdge: c.earthEdge, dsnMinEl: c.dsnMinEl, lander: landerOf(c), loadW: c.loadW, batteryWh: c.batteryWh });

  // Put a scenario into the main view: set the state, then make every control show it.
  async function applyScenario(c) {
    stop();
    let site;
    if (typeof c.site === 'string') { site = Engine.DB.byId[c.site]; if (!site) throw new Error('unknown site "' + c.site + '"'); $('site').value = c.site; }
    else site = await makeCustom(c.site.lat, c.site.lon);
    Object.assign(st, { mast: c.mast, earthEdge: c.earthEdge, dsnMinEl: c.dsnMinEl, loadW: c.loadW, batteryWh: c.batteryWh, t0: c.t0, hours: c.hours, t: c.t0 });
    $('preset').value = c.lander.preset; applyPreset(c.lander.preset); Object.assign(st.lander, c.lander);
    const set = (id, v) => { $(id).value = v; };
    set('mast', c.mast); set('earthEdge', c.earthEdge); set('dsnEl', c.dsnMinEl); set('load', c.loadW); set('batt', c.batteryWh);
    set('heading', c.lander.heading); set('tilt', c.lander.tilt); set('tiltDir', c.lander.tiltDir); set('sides', c.lander.sides);
    set('sideArea', c.lander.sideArea); set('topArea', c.lander.topArea); set('mastArea', c.lander.mastArea); set('eff', Math.round(c.lander.eff * 100));
    showWin(c.hours); $('start').value = toLocalInput(c.t0);
    await selectSite(site);
  }

  // ------------------------------------------------------------ comparison
  const cmp = [];                       // up to 4 saved scenarios: { cfg, site, S, name }
  const METRICS = [                     // [label, value(stats, cfg), text(value), +1 higher is better / -1 lower is better]
    ['Sunlit', s => s.pctLit, v => v.toFixed(1) + ' %', 1], ['Longest sunlit stretch', s => s.longestLit, fmtDur, 1],
    ['Longest darkness', s => s.longestDark, fmtDur, -1], ['Dark periods', s => s.outages, v => String(v), -1],
    ['Earth visible', s => s.pctEarth, v => v.toFixed(1) + ' %', 1], ['Potential DSN contact', s => s.pctLink, v => v.toFixed(1) + ' %', 1],
    ['Longest link gap', s => s.longestNoLink, fmtDur, -1], ['DSN coverage gaps', s => s.dsnGaps.length, v => String(v), -1],
    ['Sunlight + link', s => s.pctGreen, v => v.toFixed(1) + ' %', 1], ['Longest sunlight + link', s => s.longestGreen, fmtDur, 1],
    ['Energy generated', s => s.energyWh / 1000, v => v.toFixed(1) + ' kWh', 1], ['Average power', (s, c) => s.energyWh / c.hours, v => Math.round(v) + ' W', 1],
    ['Battery empty for', s => s.emptyH, v => v > 0 ? fmtDur(v) : 'never', -1]];

  function addScenario(cfg, site, tag) {
    if (cmp.length >= 4) { $('cmpHint').textContent = 'Four scenarios is the limit. Remove one first.'; return false; }
    cmp.push({ cfg, site, S: Engine.series(site, optOf(cfg)), tag: tag || '' });
    drawCompare();
    return true;
  }

  function savedScenario(cfg) {
    const code = encodeScenario(cfg);
    return cmp.some(entry => encodeScenario(entry.cfg) === code);
  }

  function showScenarioPair(original, alternative, site, labels, statusId) {
    const pair = [{ config: original, label: labels[0] }];
    if (encodeScenario(alternative) !== encodeScenario(original)) {
      pair.push({ config: alternative, label: labels[1] });
    }
    const additions = pair.filter(entry => !savedScenario(entry.config));
    if (cmp.length + additions.length > 4) {
      $(statusId).textContent = 'Remove a saved scenario in Compare to make room for this pair.';
      return;
    }
    $(statusId).textContent = '';
    additions.forEach(({ config, label }) => addScenario(config, site, label));
    Workspace.show('compare');
    $('hCmp').tabIndex = -1;
    $('hCmp').focus({ preventScroll: true });
  }

  function compareFoundDate(candidate, label) {
    if (!found) return;
    showScenarioPair(found.original, { ...found.original, t0: candidate.t0 }, found.site,
      ['original date', label], 'findStatus');
  }

  function drawCompare() {
    const letter = k => 'ABCD'[k];
    $('cmpHint').textContent = cmp.length ? `${cmp.length} of 4` : 'Nothing saved yet.';
    const head = '<thead><tr><th></th>' + cmp.map((x, k) => `<th>${letter(k)}. ${x.site.name.replace(/ \(.*/, '')}${x.tag ? ' <span class="pill">' + x.tag + '</span>' : ''}` +
      `<small>${fmtUTC(x.cfg.t0)} · ${fmtDur(x.cfg.hours)} · ${x.cfg.mast} m mast</small><small>${Engine.LANDERS[x.cfg.lander.preset].label.replace(' (approx.)', '')}, ${x.cfg.loadW} W load</small>` +
      `<small><button data-load="${k}">Load</button><button data-del="${k}">Remove</button></small></th>`).join('') + '</tr></thead>';
    const body = METRICS.map(([label, get, text, dir]) => {
      const vals = cmp.map(x => get(x.S.stats, x.cfg)), best = dir > 0 ? Math.max(...vals) : Math.min(...vals);
      const tie = vals.every(v => v === vals[0]);      // no winner if every scenario has the same value
      return `<tr><td>${label}</td>` + vals.map(v => `<td class="${cmp.length > 1 && !tie && v === best ? 'best' : ''}">${text(v)}</td>`).join('') + '</tr>';
    }).join('');
    $('cmpTable').innerHTML = cmp.length ? head + '<tbody>' + body + '</tbody>' : '';
    $('cmpTable').querySelectorAll('[data-load]').forEach(button => {
      button.onclick = async () => {
        await applyScenario(cmp[+button.dataset.load].cfg);
        Workspace.show('explore');
        $('screen-explore').focus();
      };
    });
    $('cmpTable').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { cmp.splice(+b.dataset.del, 1); drawCompare(); });

    // aligned timelines: one block of thin strips per scenario, x = time since that window started
    const cv = $('cmpTl'); cv.style.height = Math.max(40, cmp.length * 52 + 24) + 'px';
    const { c, w, h } = fit(cv); c.clearRect(0, 0, w, h);
    if (!cmp.length) return;
    const x0 = 34, x1 = w - 12, maxH = Math.max(...cmp.map(x => x.cfg.hours));
    const strips = [[x => x.S.sunFrac, css('--sun')], [x => x.S.earthVis, css('--earth')], [x => x.S.link, css('--dsn1')], [x => x.S.green, css('--green')], [x => x.S.soc, css('--warn')]];
    c.font = '600 13px ' + css('--font'); c.textBaseline = 'middle';
    cmp.forEach((x, k) => {
      const y = 4 + k * 52, wpx = (x1 - x0) * x.cfg.hours / maxH, n = x.S.n;
      c.fillStyle = css('--ink'); c.textAlign = 'left'; c.fillText(letter(k), 8, y + 22);
      strips.forEach(([arr, col], j) => {
        const a = arr(x), yy = y + j * 9, empty = j === 4;
        c.fillStyle = css('--soft'); c.fillRect(x0, yy, wpx, 7);
        c.fillStyle = col; let start = -1;
        for (let i = 0; i <= n; i++) {
          const on = i < n && (empty ? (a[i] <= 0 && x.cfg.batteryWh > 0) : a[i] > 0);
          if (on && start < 0) start = i;
          if (!on && start >= 0) { c.fillRect(x0 + start / n * wpx, yy, Math.max(1, (i - start) / n * wpx), 7); start = -1; }
        }
      });
    });
    // elapsed-time axis
    const days = maxH / 24, stepD = [0.25, 0.5, 1, 2, 5, 10, 30, 60].find(s => days / s <= 12) || 90, yb = 4 + cmp.length * 52;
    c.fillStyle = css('--muted'); c.font = '11px ' + css('--mono'); c.textAlign = 'center';
    for (let d = 0; d <= days + 1e-6; d += stepD) c.fillText(d < 1 && d > 0 ? (d * 24) + ' h' : 'day ' + d, x0 + (x1 - x0) * d / days, yb + 8);
  }

  // ------------------------------------------------------------ find a window
  let found = null, findHover = null;      // findHover: the candidate under the pointer on the score chart
  function buildShortlist(result) {
    const original = result.candidates[0];
    const direction = result.lowerIsBetter ? 1 : -1;
    const ranked = result.candidates.filter(candidate => candidate.t0 !== original.t0)
      .sort((a, b) => direction * (a.score - b.score) || a.t0 - b.t0);
    const alternatives = [];
    for (const candidate of ranked) {
      if (alternatives.every(selected => Math.abs(selected.t0 - candidate.t0) >= 24 * HOUR)) {
        alternatives.push(candidate);
      }
      if (alternatives.length === 3) break;
    }
    return [original, ...alternatives].map(candidate => ({
      ...candidate,
      original: candidate.t0 === original.t0,
      best: candidate.t0 === result.best.t0,
      stats: Engine.series(result.site, optOf({ ...result.original, t0: candidate.t0 })).stats
    }));
  }

  function drawShortlist() {
    if (!found) { $('shortlist').hidden = true; return; }
    const limit = $('batteryLimit').valueAsNumber;
    const rows = found.shortlist.map(candidate => {
      const stats = candidate.stats;
      const label = candidate.original ? 'Original' : candidate.best ? 'Top search score' : 'Alternative';
      const limitCell = Number.isFinite(limit) && limit >= 0
        ? `<td>${stats.emptyH <= limit + 1e-8 ? 'Within limit' : 'Over limit'}</td>`
        : '<td>—</td>';
      return `<tr><th scope="row">${fmtUTC(candidate.t0)}<small>${label}</small></th>
        <td>${stats.pctGreen.toFixed(1)}%</td><td>${stats.pctLink.toFixed(1)}%</td>
        <td>${fmtDur(stats.longestNoLink)}</td><td>${fmtDur(stats.emptyH)}</td>${limitCell}
        <td>${candidate.original ? '' : `<button data-shortlist-time="${candidate.t0}">Compare</button>`}</td></tr>`;
    });
    $('shortlistTable').innerHTML = `<thead><tr><th scope="col">Arrival</th>
      <th scope="col">Sunlight + contact</th><th scope="col">Potential contact</th>
      <th scope="col">Longest contact gap</th><th scope="col">Battery empty</th>
      <th scope="col">Battery limit</th><th scope="col">Action</th></tr></thead><tbody>${rows.join('')}</tbody>`;
    $('shortlistTable').querySelectorAll('[data-shortlist-time]').forEach(button => {
      button.onclick = () => compareFoundDate({ t0: Number(button.dataset.shortlistTime) }, 'shortlisted date');
    });
    $('shortlist').hidden = false;
  }

  function runFind() {
    if (!st.site) return;
    const goal = $('findGoal').value, range = +$('findRange').value;
    $('findStatus').textContent = '';
    if (st.hours < 0.5) {
      found = null;
      $('findOut').textContent = 'Choose a mission window of at least 30 minutes to search alternate dates.';
      $('findUse').disabled = true;
      $('findCompare').disabled = true;
      drawShortlist();
      drawFind();
      return;
    }
    found = Engine.findWindow(st.site, opt(), range, goal); found.t0 = st.t0; found.range = range; found.goal = goal;
    found.original = snapshot();
    found.site = st.site;
    found.shortlist = buildShortlist(found);
    const b = found.best, cur = found.candidates[0], f = v => found.unit === '%' ? v.toFixed(1) + ' %' : fmtDur(v);
    $('findOut').textContent = `Best start for ${found.site.name}: ${fmtUTC(b.t0)} with ${f(b.score)} (${$('findGoal').selectedOptions[0].textContent}). Original start: ${f(cur.score)}. Checked ${found.candidates.length} start dates spaced ${fmtDur(found.candidateStepMs / HOUR)} apart, using ${fmtDur(found.sampleStepMs / HOUR)} samples.`;
    $('findUse').disabled = false;
    $('findCompare').disabled = false;
    drawShortlist();
    drawFind();
  }
  function drawFind() {
    const cv = $('findCv'), { c, w, h } = fit(cv); c.clearRect(0, 0, w, h);
    if (!found) { c.fillStyle = css('--muted'); c.font = '13px ' + css('--font'); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('Press Search to score every start date', w / 2, h / 2); return; }
    // The vertical axis is the SCORE of the chosen goal; its title says what that score is.
    const AXIS = { green: 'Score: % of window with sunlight + DSN link together', greenRun: 'Score: longest unbroken sunlight + link stretch (hours)',
      sun: 'Score: % of window sunlit', link: 'Score: % of window with a DSN link', dark: 'Score: longest dark stretch (hours), lower is better' };
    const L = 44, R = 10, T = 24, B = 22, cs = found.candidates, top = Math.max(...cs.map(q => q.score), 1e-9);
    // round the top of the axis up to a tidy number so the tick labels are readable
    const mag = Math.pow(10, Math.floor(Math.log10(top))), mx = found.unit === '%' && top > 50 ? 100 : [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= top);
    c.fillStyle = css('--ink'); c.font = '600 12px ' + css('--font'); c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(AXIS[found.goal], L, 11);
    const X = t => L + (t - found.t0) / (found.range * 24 * HOUR) * (w - L - R), Y = v => T + (1 - v / mx) * (h - T - B);
    c.strokeStyle = css('--line'); c.strokeRect(L + .5, T + .5, w - L - R, h - T - B);
    c.fillStyle = css('--accent'); c.globalAlpha = 0.25; c.beginPath(); c.moveTo(X(cs[0].t0), Y(0)); cs.forEach(q => c.lineTo(X(q.t0), Y(q.score))); c.lineTo(X(cs[cs.length - 1].t0), Y(0)); c.fill(); c.globalAlpha = 1;
    c.strokeStyle = css('--accent'); c.lineWidth = 1.6; c.beginPath(); cs.forEach((q, i) => i ? c.lineTo(X(q.t0), Y(q.score)) : c.moveTo(X(q.t0), Y(q.score))); c.stroke();
    c.fillStyle = css('--green'); c.beginPath(); c.arc(X(found.best.t0), Y(found.best.score), 5, 0, 7); c.fill();          // best start
    if (st.t0 >= found.t0 && st.t0 <= found.t0 + found.range * 24 * HOUR) { c.strokeStyle = css('--ink'); c.lineWidth = 1.5; c.beginPath(); c.moveTo(X(st.t0), T); c.lineTo(X(st.t0), h - B); c.stroke(); }   // window start now
    if (findHover) {      // pointer position: a thin guide line and a dot where it meets the curve
      const hx = X(findHover.t0), hy = Y(findHover.score);
      c.strokeStyle = css('--muted'); c.lineWidth = 1; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(hx, T); c.lineTo(hx, h - B); c.stroke(); c.setLineDash([]);
      c.fillStyle = css('--panel'); c.strokeStyle = css('--accent'); c.lineWidth = 2; c.beginPath(); c.arc(hx, hy, 4.5, 0, 7); c.fill(); c.stroke();
    }
    c.fillStyle = css('--muted'); c.font = '11px ' + css('--mono'); c.textBaseline = 'middle'; c.textAlign = 'right';
    for (const f of [0, 0.5, 1]) {          // score ticks with faint grid lines
      const v = mx * f, yy = T + (1 - f) * (h - T - B);
      c.fillText((v >= 10 || v === 0 ? v.toFixed(0) : v.toFixed(1)) + (found.unit === '%' ? '%' : ' h'), L - 4, Math.min(h - B - 5, Math.max(T + 5, yy)));
      if (f === 0.5) { c.strokeStyle = css('--line'); c.lineWidth = 1; c.beginPath(); c.moveTo(L, yy + .5); c.lineTo(w - R, yy + .5); c.stroke(); }
    }
    c.textAlign = 'center'; const stepD = found.range <= 30 ? 5 : found.range <= 90 ? 15 : found.range <= 180 ? 30 : 60;
    for (let d = 0; d <= found.range; d += stepD) c.fillText(fmtDay(found.t0 + d * 24 * HOUR), Math.min(w - 24, Math.max(L + 16, X(found.t0 + d * 24 * HOUR))), h - 9);
  }

  // ------------------------------------------------------------ share and export
  // Scenario code: the scenario as a short list -> JSON -> base32 text using only
  // a-z and 2-7, so it survives being part of a web address.
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  function encodeScenario(c) {
    const L = c.lander, arr = [1, c.site, Math.round(c.t0 / 60000), c.hours, c.mast, c.earthEdge, c.dsnMinEl, c.loadW, c.batteryWh, L.preset, L.heading, L.tilt, L.tiltDir, L.sides, L.sideArea, L.topArea, L.mastArea, Math.round(L.eff * 100)];
    const bytes = new TextEncoder().encode(JSON.stringify(arr)); let out = '', bits = 0, val = 0;
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) out += B32[(val << (5 - bits)) & 31];
    return 's' + out;
  }
  function decodeScenario(code) {
    code = code.trim().replace(/^.*#/, '').toLowerCase();
    if (code[0] !== 's') throw new Error('codes start with "s"');
    const bytes = []; let bits = 0, val = 0;
    for (const ch of code.slice(1)) { const k = B32.indexOf(ch); if (k < 0) throw new Error('unexpected character'); val = (val << 5) | k; bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
    let a; try { a = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))); } catch (e) { a = null; }
    if (!Array.isArray(a) || a[0] !== 1 || !Engine.LANDERS[a[9]]) throw new Error('it is not a complete scenario code');
    return { site: a[1], t0: a[2] * 60000, hours: a[3], mast: a[4], earthEdge: a[5], dsnMinEl: a[6], loadW: a[7], batteryWh: a[8],
      lander: { preset: a[9], heading: a[10], tilt: a[11], tiltDir: a[12], sides: a[13], sideArea: a[14], topArea: a[15], mastArea: a[16], eff: a[17] / 100 } };
  }
  function seriesCsv() {
    const rows = ['time_utc,sun_azimuth_deg,sun_elevation_deg,sun_terrain_horizon_deg,sun_disc_fraction,earth_azimuth_deg,earth_elevation_deg,earth_terrain_horizon_deg,earth_visible,dsn_goldstone,dsn_madrid,dsn_canberra,dsn_link,sun_and_link,power_w,battery_wh'];
    for (let i = 0; i < S.n; i++) rows.push([new Date(st.t0 + i * S.dt).toISOString().slice(0, 16) + 'Z', S.sunAz[i].toFixed(3), S.sunEl[i].toFixed(3), S.sunHz[i].toFixed(2), S.sunFrac[i].toFixed(3),
      S.earthAz[i].toFixed(3), S.earthEl[i].toFixed(3), S.earthHz[i].toFixed(2), S.earthVis[i], S.dsn[i] & 1, S.dsn[i] >> 1 & 1, S.dsn[i] >> 2 & 1, S.link[i], S.green[i], S.power[i].toFixed(1), S.soc[i].toFixed(1)].join(','));
    return rows.join('\n');
  }
  // Clipboard access can be refused (for example inside an embedded frame); say so instead of failing silently.
  async function copyText(text, what) {
    try { await navigator.clipboard.writeText(text); $('shareOut').textContent = what + ' copied.'; }
    catch (e) { $('codeIn').value = text.length < 2000 ? text : ''; $('shareOut').textContent = 'Your browser blocked copying.' + (text.length < 2000 ? ' The text is in the box above: select it and copy.' : ''); }
  }

  // ------------------------------------------------------------ map panel
  const TYPE_NAMES = { AA: 'crater', SF: 'satellite crater', MO: 'mountain', ME: 'mare', LF: 'landing site name', VA: 'valley', RI: 'rille', DO: 'ridge', CA: 'crater chain', RU: 'scarp', PL: 'plain', PA: 'marsh', LC: 'lake', SI: 'bay', OC: 'ocean', PR: 'cape', AL: 'albedo feature', PM: 'plateau' };
  function wireMap() {
    const fmtLL = d => `${Math.abs(d.lat).toFixed(3)}° ${d.lat < 0 ? 'S' : 'N'}, ${Math.abs(d.lon).toFixed(3)}° ${d.lon < 0 ? 'W' : 'E'}`;
    const describe = d => fmtLL(d) + (d.feature ? ' · ' + d.feature : '') + (d.region ? ` · Artemis III region ${d.region.code}` : '') +
      (d.sun != null ? ` · Sun ${d.sun.toFixed(0)} %` : '') + (d.earth != null ? ` · Earth ${d.earth.toFixed(0)} %` : '') + (d.psr ? ' · permanently shadowed' : '');
    let pinned = null;
    const ready = MapView.init($('map'), {
      fetchJSON: async p => (await fetch(p)).json(),
      sites: () => Engine.DB.sites, regions: () => Engine.DB.regions, regionAt: Engine.regionAt,
      onView: v => { $('mapView').value = v; for (const id of ['mSun', 'mEarth', 'mPsr']) $(id).disabled = v === 'G'; },
      onHover: d => { $('mapRead').textContent = d ? describe(d) : pinned ? 'Pin: ' + describe(pinned) : 'Move over the map to read coordinates.'; },
      onSelect: site => { $('site').value = site.id; selectSite(site); },
      onPick: d => { pinned = d; $('cLat').value = d.lat.toFixed(4); $('cLon').value = d.lon.toFixed(4); $('mapUse').disabled = false; $('mapRead').textContent = 'Pin: ' + describe(d); },
    });
    $('mapView').onchange = () => MapView.setView($('mapView').value);
    $('mapBase').onchange = () => MapView.setBase($('mapBase').value);
    document.querySelectorAll('#mapChecks input[type=checkbox]').forEach(cb => cb.onchange = () => MapView.setShow(cb.dataset.k, cb.checked));
    $('mOpac').oninput = () => MapView.setOpacity($('mOpac').value / 100);
    $('mapIn').onclick = () => MapView.zoom(1.5); $('mapOut').onclick = () => MapView.zoom(1 / 1.5);
    $('mapFit').onclick = () => MapView.fitAll(); $('mapSite').onclick = () => MapView.zoomToSite();
    $('mapUse').onclick = () => $('cGo').click();
    // feature search: type part of a name, pick a result, the map flies there and drops a pin
    const res = $('mapResults');
    $('mapSearch').oninput = () => {
      const hits = MapView.search($('mapSearch').value);
      res.innerHTML = hits.map((f, i) => `<button role="option" data-i="${i}">${f[0]} <span class="hint">${TYPE_NAMES[f[4]] || 'feature'}, ${f[3] >= 1 ? Math.round(f[3]) + ' km' : 'small'}, ${Math.abs(f[1]).toFixed(1)}°${f[1] < 0 ? 'S' : 'N'} ${Math.abs(f[2]).toFixed(1)}°${f[2] < 0 ? 'W' : 'E'}</span></button>`).join('');
      res.style.display = hits.length ? 'block' : 'none';
      res.querySelectorAll('button').forEach(b => b.onclick = () => {
        const f = hits[+b.dataset.i]; res.style.display = 'none'; $('mapSearch').value = f[0];
        MapView.goTo(f[1], f[2], Math.max(60, f[3] * 4));
        const d = { lat: f[1], lon: f[2], feature: f[0], region: Engine.regionAt(f[1], f[2]) }; pinned = d; MapView.setPin(d);
        $('cLat').value = f[1]; $('cLon').value = f[2]; $('mapUse').disabled = false; $('mapRead').textContent = 'Pin: ' + describe(d);
      });
    };
    $('mapSearch').onkeydown = e => { if (e.key === 'Enter') { const b = res.querySelector('button'); if (b) b.click(); } else if (e.key === 'Escape') res.style.display = 'none'; };
    document.addEventListener('click', e => { if (!res.contains(e.target) && e.target !== $('mapSearch')) res.style.display = 'none'; });
    return ready;
  }

  // ------------------------------------------------------------ 3D globe panel
  function wireGlobe() {
    const fmtLL = d => `${Math.abs(d.lat).toFixed(3)}° ${d.lat < 0 ? 'S' : 'N'}, ${Math.abs(d.lon).toFixed(3)}° ${d.lon < 0 ? 'W' : 'E'}`;
    let status = '', started = false;
    const start = () => {
      if (started) return; started = true;
      Globe.startAt(st.site);
      Globe.init($('globe'), $('globeOv'), {
        fetchJSON: async p => (await fetch(p)).json(), sites: () => Engine.DB.sites, regions: () => Engine.DB.regions,
        onStatus: t => { status = t; $('globeRead').textContent = t || 'Move over the Moon to read coordinates.'; },
        onHover: d => { if (!status) $('globeRead').textContent = d ? fmtLL(d) + (Engine.regionAt(d.lat, d.lon) ? ' · Artemis III region ' + Engine.regionAt(d.lat, d.lon).code : '') : 'Move over the Moon to read coordinates.'; },
        onSelect: site => { $('site').value = site.id; selectSite(site); },
        onPick: d => { $('cLat').value = d.lat.toFixed(4); $('cLon').value = d.lon.toFixed(4); $('mapUse').disabled = false; MapView.setPin({ lat: d.lat, lon: d.lon }); Workspace.openCoordinates(); $('globeRead').textContent = 'Pinned ' + fmtLL(d) + '. Press "Use custom" under Landing site to make it the active site.'; },
      }).then(() => { if (now) Globe.setTime(now.p.g); });
    };
    // The 3D view downloads several megabytes, so it starts only when it scrolls into view.
    new IntersectionObserver((en, obs) => { if (en.some(x => x.isIntersecting)) { obs.disconnect(); start(); } }, { rootMargin: '200px' }).observe($('globe'));
    $('gBase').onchange = () => Globe.setOption('base', $('gBase').value);
    document.querySelectorAll('#globeChecks input').forEach(cb => cb.onchange = () => Globe.setOption(cb.dataset.k, cb.checked));
    $('gIn').onclick = () => Globe.zoomBy(1.5); $('gOut').onclick = () => Globe.zoomBy(1 / 1.5);
    $('gSite').onclick = () => Globe.flyTo(st.site.lat, st.site.lon, Math.abs(st.site.lat) > 75 ? 8 : 3);
    $('gSouth').onclick = () => Globe.flyTo(-90, 0, 4); $('gNorth').onclick = () => Globe.flyTo(90, 0, 4); $('gNear').onclick = () => Globe.flyTo(0, 0, 1);
  }

  // ------------------------------------------------------------ lander view panel
  function wirePov() {
    let status = '', started = false;
    const showFov = () => { const c = Pov.cam; $('povFov').textContent = `facing ${c.az.toFixed(0)}° (${compass(c.az)}), field of view ${c.fov.toFixed(0)}°`; };
    const start = () => {
      if (started) return; started = true;
      Pov.startAt(st.site, st.mast, Engine.maskOf(st.site, st.mast));
      Pov.init($('pov'), $('povOv'), {
        fetchJSON: async p => (await fetch(p)).json(),
        onStatus: t => { status = t; $('povRead').textContent = t || 'Move over the picture to read bearing and elevation.'; },
        onView: showFov,
        onHover: d => { if (status) return; $('povRead').textContent = d ? `bearing ${d.az.toFixed(1)}° (${compass(d.az)}), elevation ${deg(d.el, 2)} · precomputed terrain horizon on this bearing ${deg(Engine.maskAt(Engine.maskOf(st.site, st.mast), d.az), 2)}` : 'Move over the picture to read bearing and elevation.'; },
      }).then(() => { if (Pov.ready) { Pov.face(inspectedBody); showFov(); } });
    };
    new IntersectionObserver((en, obs) => { if (en.some(x => x.isIntersecting)) { obs.disconnect(); start(); } }, { rootMargin: '200px' }).observe($('pov'));
    $('pSun').onclick = () => { Pov.face('sun'); setTimeout(showFov, 750); }; $('pEarth').onclick = () => { Pov.face('earth'); setTimeout(showFov, 750); };
    $('pIn').onclick = () => Pov.zoomBy(1.5); $('pOut').onclick = () => Pov.zoomBy(1 / 1.5);
    document.querySelectorAll('#povChecks input').forEach(cb => cb.onchange = () => Pov.setOption(cb.dataset.k, cb.checked));
  }

  function wireStep4() {
    $('cmpAdd').onclick = () => addScenario(snapshot(), st.site);
    $('exploreCompare').onclick = () => {
      if (!st.site) return;
      Workspace.show('compare');
      const config = snapshot();
      if (!savedScenario(config)) addScenario(config, st.site);
      $('hCmp').tabIndex = -1;
      $('hCmp').focus({ preventScroll: true });
    };
    $('findCompare').onclick = () => { if (found) compareFoundDate(found.best, 'best date'); };
    $('batteryLimit').oninput = drawShortlist;
    // one-line description of the selected goal, shown under the menu
    const GOALS = {
      green: 'Scores each start date by the percentage of the window with sunlight and a DSN link at the same time. Higher is better.',
      greenRun: 'Scores each start date by its longest unbroken stretch, in hours, with sunlight and a DSN link throughout. Higher is better.',
      sun: 'Scores each start date by the percentage of the window with any part of the Sun above the terrain. Higher is better.',
      link: 'Scores each start date by the percentage of the window with Earth above the terrain and at least one DSN complex in view. Higher is better.',
      dark: 'Scores each start date by its longest unbroken dark stretch, in hours. Lower is better, so the best start date has the shortest night.' };
    const showGoal = () => { $('findDesc').textContent = GOALS[$('findGoal').value]; };
    $('findGoal').onchange = showGoal; showGoal();
    $('findGo').onclick = runFind;
    $('findUse').onclick = async () => {
      if (!found) return;
      await applyScenario({ ...found.original, t0: found.best.t0 });
      Workspace.show('explore');
    };
    $('findCv').onclick = async e => {
      if (!found) return;
      const r = $('findCv').getBoundingClientRect(), f = (e.clientX - r.left - 44) / (r.width - 54);
      const t = found.t0 + Math.min(1, Math.max(0, f)) * found.range * 24 * HOUR;
      const near = found.candidates.reduce((a, q) => Math.abs(q.t0 - t) < Math.abs(a.t0 - t) ? q : a);
      await applyScenario({ ...found.original, t0: near.t0 });
      drawFind();
    };
    // hovering the chart shows the exact score of the nearest start date
    $('findCv').onpointermove = e => {
      if (!found) return;
      const r = $('findCv').getBoundingClientRect(), t = found.t0 + Math.min(1, Math.max(0, (e.clientX - r.left - 44) / (r.width - 54))) * found.range * 24 * HOUR;
      findHover = found.candidates.reduce((a, q) => Math.abs(q.t0 - t) < Math.abs(a.t0 - t) ? q : a);
      const val = found.unit === '%' ? findHover.score.toFixed(2) + ' %' : findHover.score.toFixed(1) + ' h (' + fmtDur(findHover.score) + ')';
      showTip(e, `Start ${fmtUTC(findHover.t0)}\nScore ${val}` + (findHover === found.best ? '\nBest start date' : '') + (findHover.t0 === st.t0 ? '\nCurrent window start' : ''));
      drawFind();
    };
    $('findCv').onpointerleave = () => { findHover = null; hideTip(); drawFind(); };
    $('shareCode').onclick = () => copyText(encodeScenario(snapshot()), 'Scenario code');
    $('shareLink').onclick = () => { const code = encodeScenario(snapshot()); try { location.hash = code; } catch (e) { /* some viewers lock the address */ } copyText(location.href.replace(/#.*/, '') + '#' + code, 'Link'); };
    const loadCode = async text => {
      try { await applyScenario(decodeScenario(text)); $('shareOut').textContent = 'Scenario loaded.'; }
      catch (e) { $('shareOut').textContent = 'That code could not be read (' + e.message + '). Copy it again from "Copy scenario code".'; }
    };
    $('codeLoad').onclick = () => loadCode($('codeIn').value);
    window.addEventListener('hashchange', () => { if (/^#s[a-z2-7]+$/.test(location.hash) && location.hash.slice(1) !== encodeScenario(snapshot())) loadCode(location.hash); });
    $('csvCopy').onclick = () => copyText(seriesCsv(), `CSV (${S.n} rows)`);
    $('csvSave').onclick = () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([seriesCsv()], { type: 'text/csv' }));
      a.download = `lunar_${st.site.id}_${toLocalInput(st.t0).slice(0, 10)}.csv`; a.click();
      $('shareOut').textContent = 'Download started. If nothing was saved, this viewer blocks downloads: use "Copy time series as CSV" instead.';
    };
  }

  // ------------------------------------------------------------ playback
  let last = 0;
  function tick(tn) {
    if (!st.playing) return;
    const dt = Math.min(0.1, (tn - last) / 1000); last = tn;
    const t = st.t + st.speed * HOUR * dt;
    if (t >= st.t0 + st.hours * HOUR) { setTime(st.t0 + st.hours * HOUR); stop(); return; }
    setTime(t); requestAnimationFrame(tick);
  }
  function stop() { st.playing = false; $('play').textContent = '▶ Play'; }
  function togglePlay() {
    if (st.playing) { stop(); return; }
    if (st.t >= st.t0 + st.hours * HOUR - 1) st.t = st.t0;       // at the end: start over
    st.playing = true; $('play').textContent = '❚❚ Pause'; last = performance.now(); requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ start
  (async () => {
    try { await Engine.load(); }
    catch (err) { $('status').textContent = 'Could not load data/sites.json. If you opened this file directly from disk, serve the folder instead: python -m http.server'; return; }
    wire(); wireClearance(); applyPreset('nova-c');
    st.t0 = Math.floor(Date.now() / 86400000) * 86400000; st.t = st.t0 + 3 * 24 * HOUR;
    $('start').value = toLocalInput(st.t0);
    wireStep4(); await wireMap();
    $('site').value = 'derosa2012-cr1-connecting-ridge';
    await selectSite(Engine.DB.byId[$('site').value]);
    // Two examples so the comparison is not empty on first view
    const ex = Engine.DB.byId['derosa2012-mp1-malapert-peak']; await Engine.ensureTable(ex);
    addScenario(snapshot(), st.site, 'example'); addScenario(Object.assign(snapshot(), { site: ex.id }), ex, 'example');
    drawFind(); wireGlobe(); wirePov();
    // A scenario in the page address (#s...) replaces the default view
    const route = new URLSearchParams(location.search);
    if (/^#s[a-z2-7]+$/.test(location.hash)) {
      try { await applyScenario(decodeScenario(location.hash)); }
      catch (e) { $('shareOut').textContent = 'The scenario in the link could not be read.'; }
    } else if (['clearance', 'earthset'].includes(route.get('demo'))) {
      Workspace.showView('lander');
      await loadClearanceDemo();
      if (route.get('demo') === 'earthset') {
        $('tryChange').open = false;
        setTime(Date.UTC(2026, 10, 18));
        visitClearanceCheckpoint(-10);
      }
    } else if (['compare', 'find'].includes(route.get('view'))) {
      Workspace.show(route.get('view'));
    }
    Copilot.init({ context: copilotContext, summary: context => context.split('\n')[0], run: action => copilotActions[action]() });
  })();
})();
