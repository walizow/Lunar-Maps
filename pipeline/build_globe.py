"""
build_globe.py - small elevation grids for the 3D globe (web/data/globe_*.json)

The globe only needs heights for shading and shadows, so these are much
coarser (and smaller) than the grids used for custom-site horizons:
  globe_G.json  global, 4 px/deg (about 7.6 km), 1440 x 720, longitude -180..180
  globe_S.json / globe_N.json  polar stereographic to 75 deg, 1024 x 1024 (about 0.9 km)
Each grid is a small .json description plus a .png holding the heights (see common.pack_png).
globe_G also serves as the terrain for custom sites away from the poles.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image
from common import Terrain, pack_png

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data")
T = Terrain()

def resize(a, size):
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize(size, Image.BOX))

zg = np.roll(np.asarray(T.glob.z, dtype=np.float32) * 0.5, 2880, axis=1)        # longitude -180..180
pack_png(resize(zg, (1440, 720)), os.path.join(WEB, "globe_G.png"))
json.dump(dict(kind="global", w=1440, h=720, ppd=4, file="globe_G.png"), open(os.path.join(WEB, "globe_G.json"), "w"))
for pole, g in (("S", T.s120), ("N", T.n120)):
    z = resize(np.asarray(g.z, dtype=np.float32) * 0.5, (1024, 1024))
    pack_png(z, os.path.join(WEB, f"globe_{pole}.png"))
    json.dump(dict(kind="polar", south=(pole == "S"), w=1024, h=1024, radius_km=g.n * g.scale / 2000.0, file=f"globe_{pole}.png"),
              open(os.path.join(WEB, f"globe_{pole}.json"), "w"))
for f in ("globe_G.png", "globe_S.png", "globe_N.png"):
    print(f, round(os.path.getsize(os.path.join(WEB, f)) / 1e6, 2), "MB")
