// Recreate independent validation inputs from the public JPL Horizons API.
// Usage: node pipeline/fetch_validation_horizons.js <LUNAR_HORIZONS directory> [site ID]
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const api = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const web = path.join(__dirname, '..', 'web');
const hour = 3600000;
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isoMinute = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';
const queryDate = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function makeQuery(site, table, target) {
  const end = Date.parse(table.t0) + (table.n - 1) * table.stepHours * hour;
  const longitude = ((site.lon % 360) + 360) % 360;
  const settings = {
    COMMAND: target, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER',
    CENTER: 'coord@301', COORD_TYPE: 'GEODETIC',
    SITE_COORD: [longitude.toFixed(6), site.lat.toFixed(6), (site.ephH / 1000).toFixed(4)].join(','),
    START_TIME: queryDate(Date.parse(table.t0)), STOP_TIME: queryDate(end),
    STEP_SIZE: table.stepHours + 'h', QUANTITIES: '4,20', RANGE_UNITS: 'KM',
    ANG_FORMAT: 'DEG', APPARENT: 'AIRLESS', CSV_FORMAT: 'YES',
    TIME_DIGITS: 'MINUTES', EXTRA_PREC: 'YES'
  };
  const url = new URL(api);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(settings)) url.searchParams.set(key, "'" + value + "'");
  return url;
}

function parseRows(result, table) {
  const chunk = result.match(/\$\$SOE\s*([\s\S]*?)\s*\$\$EOE/);
  if (!chunk) throw Error('Horizons returned no ephemeris: ' + result.slice(-400));
  const lines = chunk[1].split(/\r?\n/);
  if (lines.length !== table.n) throw Error(`Expected ${table.n} rows, received ${lines.length}`);
  const start = Date.parse(table.t0);
  return lines.map((line, index) => {
    const [date, ...fields] = line.split(',').map(value => value.trim());
    const match = date.match(/^(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (!match || !months.includes(match[2])) throw Error('Unexpected timestamp: ' + date);
    const time = Date.UTC(+match[1], months.indexOf(match[2]), +match[3], +match[4], +match[5]);
    if (time !== start + index * table.stepHours * hour) throw Error('Unexpected cadence at ' + date);
    const values = fields.filter(value => value !== '' && Number.isFinite(Number(value))).map(Number);
    const [az, el, range] = values;
    if (values.length < 3 || az < 0 || az > 360 || Math.abs(el) > 90 || range <= 0)
      throw Error('Invalid Horizons values at ' + date);
    return [isoMinute(time), az.toFixed(5), el.toFixed(5), range.toFixed(3)].join(',');
  });
}

async function readHorizons(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (data.error || typeof data.result !== 'string') throw Error(data.error || 'Unexpected JSON');
      return data;
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn(`JPL request failed (${error.message}). Retrying.`);
      await sleep(3000 * (attempt + 1));
    }
  }
}

async function main() {
  const [root, requestedSite] = process.argv.slice(2);
  if (!root) throw Error('Pass the directory to use as LUNAR_HORIZONS.');
  const { sites } = JSON.parse(await fs.readFile(path.join(web, 'data', 'sites.json'), 'utf8'));
  const selected = sites.filter(site => site.eph && (!requestedSite || site.id === requestedSite));
  if (!selected.length) throw Error('No matching site with a bundled Horizons table.');
  const folder = path.resolve(root, 'horizons_extra');
  await fs.mkdir(folder, { recursive: true });
  for (const site of selected) {
    const table = JSON.parse(await fs.readFile(path.join(web, 'data', 'eph', site.id + '.json'), 'utf8'));
    for (const [body, target] of [['sun', '10'], ['earth', '399']]) {
      const file = path.join(folder, site.id + '__' + body + '.csv');
      const url = makeQuery(site, table, target);
      try {
        const existing = await fs.readFile(file);
        const source = JSON.parse(await fs.readFile(file + '.source.json', 'utf8'));
        const digest = createHash('sha256').update(existing).digest('hex');
        if (source.request === url.href && source.rows === table.n && source.sha256 === digest) {
          console.log(site.id, body, 'already verified');
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      console.log('Downloading', site.id, body);
      const data = await readHorizons(url);
      const rows = parseRows(data.result, table);
      const csv = 'time_utc,azimuth_deg,elevation_deg,range_km\n' + rows.join('\n') + '\n';
      await fs.writeFile(file + '.part', csv);
      await fs.rename(file + '.part', file);
      await fs.writeFile(file + '.source.json', JSON.stringify({
        request: url.href, signature: data.signature, retrievedAt: new Date().toISOString(),
        rows: rows.length, sha256: createHash('sha256').update(csv).digest('hex')
      }, null, 2) + '\n');
      console.log(site.id, body, rows.length, 'rows');
      await sleep(1000);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
