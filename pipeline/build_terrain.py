"""
build_terrain.py - elevation grids the browser uses for CUSTOM polar sites (web/data/terrain_*.png)

Preset sites ship precomputed horizons. For a custom site near a pole the browser traces the
horizon itself on a 400 m polar stereographic grid (2288 x 2288 cells, 75-90 deg latitude):
  terrain_S.json + terrain_S.png, terrain_N.json + terrain_N.png
The .json holds the grid's description; the .png holds the heights (see common.pack_png).
Custom sites away from the poles reuse the 3D map's global grid (globe_G, built by build_globe.py).
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import ndimage
from common import Terrain, pack_png

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data")
T = Terrain()


def polar_400(g80, g120):
    n, c = 2288, 1143.5
    # outer part: 120 m grid, lightly smoothed, sampled at the 400 m cell centres
    z120 = ndimage.uniform_filter(np.asarray(g120.z, dtype=np.float32), size=3) * 0.5
    idx = (np.arange(n) - c) * 400.0 / 120.0 + g120.c
    yy, xx = np.meshgrid(idx, idx, indexing="ij")
    out = ndimage.map_coordinates(z120, [yy, xx], order=1, mode="nearest")
    # inner part: exact 5 x 5 block means of the 80 m grid (1520 x 1520 cells)
    z80 = np.asarray(g80.z, dtype=np.float32).reshape(1520, 5, 1520, 5).mean(axis=(1, 3)) * 0.5
    y, x = np.mgrid[0:n, 0:n]
    inside = np.hypot(y - c, x - c) * 400.0 < 303000.0      # within the 80 deg circle
    o = (n - 1520) // 2
    block = out[o:o + 1520, o:o + 1520]
    block[inside[o:o + 1520, o:o + 1520]] = z80[inside[o:o + 1520, o:o + 1520]]
    return np.round(out)


for pole, g80, g120 in (("S", T.s80, T.s120), ("N", T.n80, T.n120)):
    z = polar_400(g80, g120)
    pack_png(z, os.path.join(WEB, f"terrain_{pole}.png"))
    json.dump(dict(kind="polar", south=(pole == "S"), n=2288, w=2288, h=2288, scale=400, centre=1143.5, file=f"terrain_{pole}.png"),
              open(os.path.join(WEB, f"terrain_{pole}.json"), "w"))
    print(pole, "400 m grid", z.shape, round(os.path.getsize(os.path.join(WEB, f"terrain_{pole}.png")) / 1e6, 2), "MB")
