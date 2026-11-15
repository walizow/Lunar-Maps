"""Check 3 of the brief: DEM spot heights and north/south orientation."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from common import Terrain

T = Terrain()
print("== Spot heights in LDEM_80S_80M (expected from the brief) ==")
for name, lat, lon, exp in [("Malapert peak", -85.9756, -2.112, 4972),
                            ("Shackleton floor", -89.66, 129.2, -2768),
                            ("Connecting ridge CR1", -89.4679, -137.411, 1943)]:
    print(f"  {name:22s} {T.s80.height(np.array([lat]), np.array([lon]))[0]:8.0f} m   (expected ~{exp})")

print("== Orientation: polar grids vs global grid on rings of points ==")
rng = np.random.default_rng(1)
for label, grid, sign, lo, hi in [("80S", T.s80, -1, 80.5, 89.5), ("75S", T.s120, -1, 75.5, 89.5),
                                  ("80N", T.n80, 1, 80.5, 89.5), ("75N", T.n120, 1, 75.5, 89.5)]:
    lat = sign * rng.uniform(lo, hi, 20000); lon = rng.uniform(-180, 180, 20000)
    a = grid.height(lat, lon); b = T.glob.height(lat, lon)
    print(f"  LDEM_{label}: correlation with ldem_16 r = {np.corrcoef(a, b)[0,1]:.4f}")
g = T.glob.z
i, j = np.unravel_index(np.argmax(g), g.shape)
print(f"== Global highest point: {g[i,j]*0.5:.0f} m at lat {90-(i+0.5)/16:.2f}, lon {((j+0.5)/16+180)%360-180:.2f} (expected near 5.4N, 158.6W)")
