#!/usr/bin/env python3
"""
Fetch JPL Horizons Sun and Earth positions for ONE custom point on the Moon.

This demonstrates the Navigator's custom-site feature with a point that is not
one of the known or candidate landing sites. By default it uses:

    85.490 S, 19.219 W  (LOLA height about 2,545 m)

a gently sloping (about 5 deg) spot about 39 km from the nearest known site.
LOLA's long-term maps give it about 54% sunlight and about 84% Earth visibility.

Put this file in the same folder as fetch_horizons.py, then run:

    python fetch_custom_site.py --test
    python fetch_custom_site.py
    python fetch_custom_site.py --lat -87.2 --lon 150.5 --name "My site"   # any other point

Output: horizons_custom/<id>__sun.csv, <id>__earth.csv, manifest.json, zipped as
horizons_custom_site.zip (same format as fetch_horizons.py).
"""
import argparse, datetime as dt, json, math, os, sys, time, zipfile

try:
    import fetch_horizons as fh
except ImportError:
    sys.exit("Put fetch_custom_site.py in the same folder as fetch_horizons.py and run it from there.")

DEMO = {"lat": -85.490, "lon": -19.219, "height_m": 2545,
        "name": "Custom demo site (85.49 S, 19.22 W)",
        "note": "Chosen from LOLA long-term maps: ~54% sunlight, ~84% Earth visibility, ~5 deg slope, 39 km from the nearest known site."}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, default=DEMO["lat"], help="latitude in degrees (south negative)")
    ap.add_argument("--lon", type=float, default=DEMO["lon"], help="longitude in degrees east (west negative)")
    ap.add_argument("--height", type=float, default=None, help="terrain height in metres above the 1737.4 km sphere (default: 2545 for the demo site, else 0)")
    ap.add_argument("--name", default=None, help="a label for the site")
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--stop", default="2029-01-01")
    ap.add_argument("--step", default="1h")
    ap.add_argument("--out", default="horizons_custom")
    ap.add_argument("--test", action="store_true", help="fetch 2 days only and print them")
    a = ap.parse_args()

    if not (-90 <= a.lat <= 90 and -180 <= a.lon <= 360):
        sys.exit("Latitude must be -90..90 and longitude -180..180 (or 0..360).")
    lon = ((a.lon + 180) % 360) - 180
    is_demo = abs(a.lat - DEMO["lat"]) < 1e-6 and abs(lon - DEMO["lon"]) < 1e-6
    height = a.height if a.height is not None else (DEMO["height_m"] if is_demo else 0.0)
    name = a.name or (DEMO["name"] if is_demo else "Custom site (%.3f, %.3f)" % (a.lat, lon))
    sid = "custom-%s%.3f-%s%.3f" % ("s" if a.lat < 0 else "n", abs(a.lat), "w" if lon < 0 else "e", abs(lon))
    site = {"id": sid, "name": name, "group": "custom", "lat": round(a.lat, 5), "lon": round(lon, 5), "height_m": round(height)}
    if is_demo:
        site["note"] = DEMO["note"]

    near = []
    for s in fh.SITES:
        la1, lo1, la2, lo2 = map(math.radians, (a.lat, lon, s["lat"], s["lon"]))
        d = 1737.4 * math.acos(max(-1, min(1, math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(lo1 - lo2))))
        near.append((d, s["name"]))
    near.sort()
    print("Site: %s at %.4f, %.4f (height %d m). Nearest built-in site: %s, %.1f km away." % (name, a.lat, lon, height, near[0][1], near[0][0]))

    if a.test:
        for body, code in fh.BODIES.items():
            res, sig = fh.horizons(code, a.lat, lon, height, "2026-01-01 00:00", "2026-01-03 00:00", "6h")
            print("%s (Horizons API %s):" % (body, sig.get("version", "?")))
            for r in fh.parse(res):
                print("   %s  az %8.3f  el %7.3f  range %s km" % r)
        print("\nTest OK. Now run without --test.")
        return

    os.makedirs(a.out, exist_ok=True)
    sig = {}
    for body, code in fh.BODIES.items():
        rows = []
        for c0, c1 in fh.year_chunks(a.start, a.stop):
            res, sig = fh.horizons(code, a.lat, lon, height, c0, c1, a.step)
            part = fh.parse(res)
            if rows and part and part[0][0] == rows[-1][0]:
                part = part[1:]
            rows += part
            time.sleep(1.0)
        path = os.path.join(a.out, "%s__%s.csv" % (sid, body))
        with open(path, "w", newline="") as f:
            f.write("time_utc,azimuth_deg,elevation_deg,range_km\n")
            for t, az, el, rng in rows:
                f.write("%s,%.5f,%.5f,%s\n" % (t, az, el, "" if rng == "" else "%.3f" % rng))
        els = [r[2] for r in rows]
        print("%s: %d rows, elevation %.2f to %.2f deg" % (body, len(rows), min(els), max(els)))

    manifest = {"source": "JPL Horizons API (%s)" % fh.API, "horizons_signature": sig,
                "generated_utc": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "settings": {"start": a.start, "stop": a.stop, "step": a.step, "range_units": "km",
                             "center": "coord@301 (geodetic site on the Moon)", "azimuth": "degrees clockwise from north"},
                "sites": [site]}
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    zpath = "horizons_custom_site.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for fn in sorted(os.listdir(a.out)):
            z.write(os.path.join(a.out, fn), arcname=os.path.join(a.out, fn))
    print("\nDone. Upload %s (%.1f MB)." % (zpath, os.path.getsize(zpath) / 1e6))

if __name__ == "__main__":
    main()
