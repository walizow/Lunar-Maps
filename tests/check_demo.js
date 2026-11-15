// Reproduce the three demo outcomes using the shipped data and browser engine.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const web = path.join(__dirname, '../web');

async function main() {
  for (const name of ['Astro', 'Terrain', 'Engine']) {
    const source = await fs.readFile(path.join(web, 'js', name.toLowerCase() + '.js'), 'utf8');
    global[name] = new Function(source + '\nreturn ' + name)();
  }
  Engine.setFetch(
    async file => JSON.parse(await fs.readFile(path.join(web, file), 'utf8')),
    file => fs.readFile(path.join(web, file))
  );
  const db = await Engine.load();
  const ridge = db.byId['derosa2012-cr1-connecting-ridge'];
  const malapert = db.byId['derosa2012-mp1-malapert-peak'];
  await Promise.all([Engine.ensureTable(ridge), Engine.ensureTable(malapert)]);
  const options = {
    t0: Date.UTC(2026, 10, 15), hours: 708.72,
    mast: 2, earthEdge: 0, dsnMinEl: 10, loadW: 200, batteryWh: 1500,
    lander: { ...Engine.LANDERS['nova-c'], heading: 0, tilt: 0, tiltDir: 0 }
  };

  const earthset = Engine.nextEvent(ridge, options, Date.UTC(2026, 10, 18), 'earthset');
  assert.ok(earthset, 'Expected a modeled Earthset');
  assert.equal(Engine.earthUp(ridge, options, earthset - 600000), true);
  assert.equal(Engine.earthUp(ridge, options, earthset + 600000), false);
  console.log('Explore: Earth visible 10 min before and hidden 10 min after', new Date(earthset).toISOString());

  const moment = Date.UTC(2026, 10, 17, 2, 30);
  const { earth, src } = Engine.pos(ridge, moment);
  assert.equal(src, 'horizons');
  const clearance = mast => earth.el - Engine.maskAt(Engine.maskOf(ridge, mast), earth.az);
  assert.ok(clearance(2) < 0 && clearance(10) > 0, 'Expected a terrain-clearance reversal');
  const baseline = Engine.series(ridge, options).stats;
  const alternate = Engine.series(malapert, options).stats;
  assert.notEqual(baseline.pctEarth, alternate.pctEarth);
  console.log('Compare: Earth-center clearance at 2 m and 10 m is', clearance(2).toFixed(3), 'and', clearance(10).toFixed(3), 'degrees');
  console.log('Compare: modeled potential contact at Connecting Ridge and Malapert Peak is', baseline.pctLink.toFixed(1), 'and', alternate.pctLink.toFixed(1), 'percent');

  const { best, candidates } = Engine.findWindow(ridge, options, 90, 'green');
  assert.ok(best.t0 > options.t0 && best.score > candidates[0].score, 'Expected a better later arrival');
  const arrival = Engine.series(ridge, { ...options, t0: best.t0 });
  const emptyMinutes = Math.round(arrival.stats.emptyH * 60);
  assert.equal(emptyMinutes, 2130, 'Expected 35 h 30 min with an empty battery');
  console.log('Find: best sampled arrival', new Date(best.t0).toISOString(),
    'improves the overlap score from', candidates[0].score.toFixed(1), 'to', best.score.toFixed(1),
    'percent, with', emptyMinutes / 60, 'hours of empty battery');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
