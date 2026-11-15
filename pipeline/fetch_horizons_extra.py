#!/usr/bin/env python3
"""
Fetch Sun and Earth positions from JPL Horizons for lunar landing sites.

For each site this asks Horizons for the apparent azimuth and elevation of the
Sun (body 10) and Earth (body 399), as seen from that point on the Moon's
surface, at a fixed time step. Results are saved as CSV files and zipped so
they can be uploaded to the Lunar Landing Site Navigator rebuild.

Requires only Python 3.8+ (standard library). Run it on a computer with
internet access:

    python fetch_horizons.py --test            # quick check: 1 site, 2 days
    python fetch_horizons.py                   # all built-in sites, 2026-2028, hourly

The 9 Artemis III regions from A3_9regions-lonlat-simplified.geojson are built in.
Use --geojson only to add other regions.

It is safe to stop and re-run: finished files are skipped.
"""
import argparse, csv, datetime as dt, json, math, os, sys, time, urllib.parse, urllib.request, zipfile

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
BODIES = {"sun": "10", "earth": "399"}

# Built-in sites. height_m is the LOLA terrain height above the 1737.4 km sphere;
# it changes Earth's direction by well under 0.001 deg, so 0 is fine for added sites.
SITES = [
    # Sites added in the rebuild that have no Horizons table yet (north pole points and extra historic landers).
    {"id": "apollo-12-lm", "name": "Apollo 12 LM, Oceanus Procellarum", "group": "historic", "lat": -3.0128, "lon": -23.4219, "height_m": -1427},
    {"id": "apollo-14-lm", "name": "Apollo 14 LM, Fra Mauro", "group": "historic", "lat": -3.64589, "lon": -17.47194, "height_m": -1048},
    {"id": "apollo-15-lm", "name": "Apollo 15 LM, Hadley–Apennine", "group": "historic", "lat": 26.13239, "lon": 3.6333, "height_m": -1938},
    {"id": "apollo-16-lm", "name": "Apollo 16 LM, Descartes highlands", "group": "historic", "lat": -8.9734, "lon": 15.5011, "height_m": 7},
    {"id": "luna-16", "name": "Luna 16, Mare Fecunditatis", "group": "historic", "lat": -0.5137, "lon": 56.3638, "height_m": -2446},
    {"id": "luna-17-lunokhod-1", "name": "Luna 17 lander, Mare Imbrium", "group": "historic", "lat": 38.23764, "lon": -35.00163, "height_m": -2470},
    {"id": "change-3", "name": "Chang'e-3, northern Mare Imbrium", "group": "historic", "lat": 44.1214, "lon": -19.5117, "height_m": -2631},
    {"id": "change-5", "name": "Chang'e-5, Oceanus Procellarum", "group": "historic", "lat": 43.0576, "lon": -51.9161, "height_m": -2544},
    {"id": "slim", "name": "SLIM, near Shioli crater", "group": "historic", "lat": -13.316, "lon": 25.251, "height_m": -910},
    {"id": "surveyor-1", "name": "Surveyor 1, Oceanus Procellarum", "group": "historic", "lat": -2.4745, "lon": -43.3398, "height_m": -1885},
    {"id": "surveyor-7", "name": "Surveyor 7, Tycho north rim", "group": "historic", "lat": -40.9811, "lon": -11.5127, "height_m": 104},
    {"id": "luna-21-lunokhod-2", "name": "Luna 21 lander, Le Monnier", "group": "historic", "lat": 25.9994, "lon": 30.4076, "height_m": -2689},
    {"id": "luna-24", "name": "Luna 24, Mare Crisium", "group": "historic", "lat": 12.7142, "lon": 62.2129, "height_m": -3669},
    {"id": "north-light-1", "name": "North pole high-sunlight point 1 (near Whipple)", "group": "north", "lat": 89.3662, "lon": 128.4084, "height_m": 457},
    {"id": "north-light-2", "name": "North pole high-sunlight point 2 (near Aepinus)", "group": "north", "lat": 88.0593, "lon": -117.6361, "height_m": 1242},
    {"id": "north-light-3", "name": "North pole high-sunlight point 3 (near Peary)", "group": "north", "lat": 89.657, "lon": -33.2317, "height_m": 361},
]

def q(v):
    return "'" + str(v) + "'"

def horizons(body, lat, lon, height_m, start, stop, step):
    elon = lon % 360.0
    params = {
        "format": "json",
        "COMMAND": q(body),
        "OBJ_DATA": q("NO"),
        "MAKE_EPHEM": q("YES"),
        "EPHEM_TYPE": q("OBSERVER"),
        "CENTER": q("coord@301"),
        "COORD_TYPE": q("GEODETIC"),
        "SITE_COORD": q("%.6f,%.6f,%.4f" % (elon, lat, height_m / 1000.0)),
        "START_TIME": q(start),
        "STOP_TIME": q(stop),
        "STEP_SIZE": q(step),
        "QUANTITIES": q("4,20"),
        "RANGE_UNITS": q("KM"),
        "ANG_FORMAT": q("DEG"),
        "APPARENT": q("AIRLESS"),
        "CSV_FORMAT": q("YES"),
        "TIME_DIGITS": q("MINUTES"),
        "EXTRA_PREC": q("YES"),
    }
    url = API + "?" + urllib.parse.urlencode(params, safe="'@,:")
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = json.loads(r.read().decode("utf-8"))
            if "error" in data:
                raise RuntimeError("Horizons error: " + data["error"])
            return data["result"], data.get("signature", {})
        except Exception as e:  # network hiccup or server busy: wait and retry
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("Request failed after retries: %s" % last)

def parse(result):
    if "$$SOE" not in result:
        tail = result[-1500:]
        raise RuntimeError("No ephemeris in Horizons reply. End of reply:\n" + tail)
    body = result.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(",")]
        t = dt.datetime.strptime(f[0], "%Y-%b-%d %H:%M")
        nums = []
        for x in f[1:]:
            try:
                nums.append(float(x))
            except ValueError:
                pass
        if len(nums) < 2:
            continue
        az, el = nums[0], nums[1]
        rng = nums[2] if len(nums) >= 3 else ""
        rows.append((t.strftime("%Y-%m-%dT%H:%MZ"), az, el, rng))
    return rows

def year_chunks(start, stop):
    a = dt.datetime.strptime(start, "%Y-%m-%d")
    b = dt.datetime.strptime(stop, "%Y-%m-%d")
    while a < b:
        c = min(dt.datetime(a.year + 1, 1, 1), b)
        yield a.strftime("%Y-%m-%d %H:%M"), c.strftime("%Y-%m-%d %H:%M")
        a = c

def sites_from_geojson(path):
    gj = json.load(open(path, encoding="utf-8"))
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    out = []
    for i, f in enumerate(feats):
        g = f.get("geometry") or {}
        props = f.get("properties") or {}
        name = next((str(props[k]) for k in ("name", "Name", "NAME", "Region", "region", "REGION", "title", "Title", "label") if k in props), "Region %d" % (i + 1))
        if g.get("type") == "Point":
            lon, lat = g["coordinates"][:2]
        else:
            rings = []
            if g.get("type") == "Polygon":
                rings = [g["coordinates"][0]]
            elif g.get("type") == "MultiPolygon":
                rings = [p[0] for p in g["coordinates"]]
            else:
                continue
            # centroid in south polar stereographic space (safe near the pole)
            xs, ys = [], []
            for ring in rings:
                if len(ring) > 1 and ring[0][:2] == ring[-1][:2]:
                    ring = ring[:-1]  # GeoJSON repeats the first point to close the ring
                for lon_, lat_ in (pt[:2] for pt in ring):
                    la, lo = math.radians(lat_), math.radians(lon_)
                    k = 2 / (1 - math.sin(la)) if lat_ < 0 else 2 / (1 + math.sin(la))
                    xs.append(k * math.cos(la) * math.sin(lo)); ys.append(k * math.cos(la) * math.cos(lo))
            x, y = sum(xs) / len(xs), sum(ys) / len(ys)
            south = sum(pt[1] for ring in rings for pt in ring) < 0
            rho = math.hypot(x, y)
            colat = 2 * math.atan(rho / 2)
            lat = (-90 + math.degrees(colat)) if south else (90 - math.degrees(colat))
            lon = math.degrees(math.atan2(x, y))
        sid = "geojson-" + "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")
        out.append({"id": sid, "name": name, "group": "geojson", "lat": round(lat, 5), "lon": round(lon, 5), "height_m": 0})
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default="2026-01-01", help="first date, YYYY-MM-DD (default 2026-01-01)")
    ap.add_argument("--stop", default="2029-01-01", help="end date, YYYY-MM-DD (default 2029-01-01)")
    ap.add_argument("--step", default="1h", help="time step, e.g. 1h, 30m (default 1h)")
    ap.add_argument("--geojson", help="optional GeoJSON of extra sites or regions (region centres are used)")
    ap.add_argument("--only", help="comma-separated site ids to fetch")
    ap.add_argument("--out", default="horizons_extra", help="output folder")
    ap.add_argument("--test", action="store_true", help="fetch 1 site for 2 days and print it")
    a = ap.parse_args()

    sites = list(SITES)
    if a.geojson:
        extra = sites_from_geojson(a.geojson)
        print("Added %d sites from %s" % (len(extra), a.geojson))
        sites += extra
    if a.only:
        keep = set(a.only.split(","))
        sites = [s for s in sites if s["id"] in keep]
    if a.test:
        s = next(x for x in sites if x["id"] == "derosa2012-cr1-connecting-ridge") if not a.only else sites[0]
        for name, code in BODIES.items():
            res, sig = horizons(code, s["lat"], s["lon"], s["height_m"], "2026-01-01 00:00", "2026-01-03 00:00", "6h")
            rows = parse(res)
            print("%s from %s (Horizons API %s):" % (name, s["name"], sig.get("version", "?")))
            for r in rows:
                print("   %s  az %8.3f  el %7.3f  range %s" % r)
        print("\nTest OK. Now run without --test.")
        return

    os.makedirs(a.out, exist_ok=True)
    signature = {}
    total = len(sites) * len(BODIES)
    n = 0
    for s in sites:
        for name, code in BODIES.items():
            n += 1
            path = os.path.join(a.out, "%s__%s.csv" % (s["id"], name))
            if os.path.exists(path):
                print("[%d/%d] %s %s: already done" % (n, total, s["id"], name)); continue
            rows = []
            for c0, c1 in year_chunks(a.start, a.stop):
                res, signature = horizons(code, s["lat"], s["lon"], s["height_m"], c0, c1, a.step)
                part = parse(res)
                if rows and part and part[0][0] == rows[-1][0]:
                    part = part[1:]
                rows += part
                time.sleep(1.0)  # be polite to JPL's servers
            tmp = path + ".part"
            with open(tmp, "w", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["time_utc", "azimuth_deg", "elevation_deg", "range_km"])
                for t, az, el, rng in rows:
                    w.writerow([t, "%.5f" % az, "%.5f" % el, rng if rng == "" else "%.3f" % rng])
            os.replace(tmp, path)
            els = [r[2] for r in rows]
            print("[%d/%d] %s %s: %d rows, elevation %.2f to %.2f deg" % (n, total, s["id"], name, len(rows), min(els), max(els)))

    manifest = {
        "source": "JPL Horizons API (" + API + ")",
        "horizons_signature": signature,
        "generated_utc": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "settings": {"start": a.start, "stop": a.stop, "step": a.step, "quantities": "4 (apparent azimuth/elevation, airless), 20 (range)",
                     "center": "coord@301 (geodetic site on the Moon)", "azimuth": "degrees clockwise from north"},
        "sites": sites,
    }
    with open(os.path.join(a.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    zpath = "horizons_lunar_sites.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(a.out)):
            if not f.endswith(".part"):
                z.write(os.path.join(a.out, f), arcname=os.path.join(a.out, f))
    print("\nDone. Upload %s (%.1f MB)." % (zpath, os.path.getsize(zpath) / 1e6))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Re-run the same command to continue.")
        sys.exit(1)
