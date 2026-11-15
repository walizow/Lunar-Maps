"""
build_pov.py - close-range terrain tiles for the lander view (web/data/pov/<site>.json + .png)

The lander view ray-marches terrain. Far terrain comes from the globe grids
(about 0.9 km near the poles). Close to the lander that is far too coarse, so
each preset site gets its own square tile centred on the site:
  polar sites (beyond 75 deg):  384 x 384 cells of 80 m (120 m between 75 and 80 deg) -> about +-15 km
  other sites:                  256 x 256 cells of 1.9 km (the global grid's own detail)
Tile layout: local map centred on the site, east to the right, north up; a
cell's offset from the centre is its distance along the ground (azimuthal
equidistant), so directions and distances from the lander are true.
Heights are metres RELATIVE TO THE SITE, which keeps the numbers small.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import Terrain, destination, pack_png

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data")
os.makedirs(os.path.join(WEB, "pov"), exist_ok=True)
T = Terrain()

sites = json.load(open(os.path.join(WEB, "sites.json")))["sites"]
total = 0
for s in sites:
    lat, lon = s["lat"], s["lon"]
    if abs(lat) > 80.02: n, sp = 384, 80.0
    elif abs(lat) > 75.1: n, sp = 384, 120.0
    else: n, sp = 256, 1900.0
    c = (n - 1) / 2.0
    j, i = np.meshgrid(np.arange(n), np.arange(n))
    east, north = (j - c) * sp, (c - i) * sp                      # row 0 is the north edge
    dist, bearing = np.hypot(east, north), np.degrees(np.arctan2(east, north))
    plat, plon = destination(lat, lon, bearing, dist)
    h0 = float(T.height(lat, lon)[0])
    z = T.height(plat.ravel(), plon.ravel()).reshape(n, n) - h0
    path = os.path.join(WEB, "pov", s["id"] + ".png")
    pack_png(z, path)
    json.dump(dict(n=n, w=n, h=n, spacing_m=sp, site_h=round(h0, 1), file="pov/" + s["id"] + ".png"), open(os.path.join(WEB, "pov", s["id"] + ".json"), "w"))
    total += os.path.getsize(path)
print(len(sites), "tiles,", round(total / 1e6, 2), "MB in total; largest", max(os.path.getsize(os.path.join(WEB, "pov", f)) for f in os.listdir(os.path.join(WEB, "pov")) if f.endswith(".png")) // 1000, "kB")
