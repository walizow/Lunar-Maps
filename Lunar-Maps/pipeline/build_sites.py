"""
build_sites.py - builds web/data/sites.json and web/data/eph/<site>.json

For every preset site this script:
  1. computes the terrain horizon (720 directions) from the full-resolution
     80 m / 120 m LOLA grids, for a 2 m and a 10 m mast;
  2. reads NASA's long-term average Sun / Earth visibility at the site's pixel
     (used only as a cross-check and an info line, never as the app's result);
  3. packs the JPL Horizons hourly Sun/Earth tables into a small file the
     browser can load;
  4. prints the brief's checks 4 and 5 (sunlit / Earth-visible fractions).

Run:  python pipeline/build_sites.py
Env:  LUNAR_RAW       folder with the NASA files   (default: uploads/spaceapps)
      LUNAR_HORIZONS  folder containing horizons_out/ and horizons_custom/
"""
import sys, os, json, gzip, base64, csv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image
from common import Terrain, horizon_mask, data_dir, R_MOON, D2R

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "..", "web", "data")
HZ = os.environ.get("LUNAR_HORIZONS", "/mnt/user-data/uploads")
RAW = data_dir()
SUN_R = 0.2666   # Sun's angular radius in degrees at 1 AU
MASTS = [2, 3, 4, 6, 8, 10, 15, 20, 25, 30]   # metres: body-mounted arrays (2-4), VSAT-class masts (10-20), large towers (30)

T = Terrain()

# ---------------------------------------------------------------- site list
def load_manifest(folder):
    with open(os.path.join(HZ, folder, "manifest.json")) as f:
        m = json.load(f)
    for s in m["sites"]:
        s["folder"] = folder
    return m["sites"]

sites = []
GROUP_MAP = {"artemis3": "artemis3", "illumination": "illumination", "mission": "mission",
             "shadow": "illumination", "other": "historic", "custom": "demo"}
for s in load_manifest("horizons_out") + load_manifest("horizons_custom"):
    sites.append(dict(id=s["id"], name=s["name"], group=GROUP_MAP[s["group"]], lat=s["lat"], lon=s["lon"],
                      hz_height=s["height_m"], folder=s["folder"], note=s.get("note", "")))

# Extra historic landers from the earlier prototype's LROC-located list.
# These have no Horizons table; the browser computes their Sun/Earth positions.
txt = open(os.path.join(HERE, "..", "reference", "missions.js"), encoding="utf8").read()
missions = json.loads(txt[txt.index("["):txt.rindex("]") + 1])
def gc_km(a, b, c, d):
    x = np.sin(a*D2R)*np.sin(c*D2R) + np.cos(a*D2R)*np.cos(c*D2R)*np.cos((b-d)*D2R)
    return float(np.arccos(np.clip(x, -1, 1)) * R_MOON / 1000)
for m in missions:
    if min(gc_km(m["lat"], m["lon"], s["lat"], s["lon"]) for s in sites) < 5:
        continue   # already present with a Horizons table
    sites.append(dict(id=m["id"], name=m["full"], group="historic", lat=m["lat"], lon=m["lon"], folder=None, note=""))

# Optional: tables fetched later with pipeline/fetch_horizons_extra.py
EXTRA = {}
if os.path.exists(os.path.join(HZ, "horizons_extra", "manifest.json")):
    EXTRA = {e["id"]: e for e in load_manifest("horizons_extra")}
def extra_folder(sid):
    return "horizons_extra" if sid in EXTRA else None

# ------------------------------------------------- long-term illumination maps
def tiff(name):
    return np.array(Image.open(os.path.join(RAW, name)))
ILL = {}
for pole, grid in (("S", T.s120), ("N", T.n120)):
    ILL[pole] = dict(grid=grid,
                     sun=tiff(f"AVGVISIB_75{pole}_120M_201608.tiff"),
                     earth=tiff(f"AVGVISIB_75{pole}_120M_201608_EARTH.tiff"),
                     psr=tiff(f"LPSR_75{pole}_120M_201608.tiff"))

def longterm(lat, lon):
    """NASA long-term averages at the site's 120 m pixel (None outside 75 deg)."""
    if abs(lat) < 75.1:
        return None
    L = ILL["S" if lat < 0 else "N"]
    line, samp = L["grid"].pixel(lat, lon)
    i, j = int(round(float(line))), int(round(float(samp)))
    return dict(sun=round(L["sun"][i, j] / 250.0, 1), earth=round(L["earth"][i, j] / 250.0, 1),
                psr=bool(L["psr"][i, j] == 20000))

# North pole presets: chosen from the data itself - the best-lit pixels within
# 2 degrees of the pole, at least 25 km apart. (No Horizons tables yet.)
feat_txt = open(os.path.join(HERE, "..", "reference", "features.js"), encoding="utf8").read()
FEATS = json.loads(feat_txt[feat_txt.index("["):feat_txt.rindex("]") + 1])
def nearest_feature(lat, lon):
    best = None
    for name, fl, fo, diam, typ in FEATS:
        if abs(fl - lat) > 6 or typ not in ("AA", "MO"):   # craters and mountains
            continue
        d = gc_km(lat, lon, fl, fo)
        score = d / max(diam / 2, 1)          # distance in units of feature radius
        if best is None or score < best[0]:
            best = (score, name, d)
    return best
g = T.n120
sun = ILL["N"]["sun"].astype(np.float32)
ii, jj = np.mgrid[0:g.n, 0:g.n]
plat, plon = g.latlon(ii, jj)
sun[plat < 88.0] = -1
picked = []
while len(picked) < 3:
    i, j = np.unravel_index(np.argmax(sun), sun.shape)
    la, lo = float(plat[i, j]), float(plon[i, j])
    picked.append((la, lo))
    d = np.hypot(ii - i, jj - j) * g.scale / 1000
    sun[d < 25] = -1
for k, (la, lo) in enumerate(picked, 1):
    nf = nearest_feature(la, lo)
    where = f"near {nf[1]}" if nf else "near the north pole"
    sites.append(dict(id=f"north-light-{k}", name=f"North pole high-sunlight point {k} ({where})", group="north",
                      lat=round(la, 4), lon=round(lo, 4), folder=None,
                      note="Chosen from NASA's long-term sunlight map: one of the best-lit spots within 2 degrees of the north pole."))
del sun, ii, jj, plat, plon

for s in sites:
    if not s["folder"] and extra_folder(s["id"]):
        s["folder"] = "horizons_extra"; s["hz_height"] = EXTRA[s["id"]]["height_m"]

# ------------------------------------------------------- Horizons table tools
def read_csv(path):
    az, el = [], []
    with open(path) as f:
        r = csv.reader(f); next(r)
        for row in r:
            az.append(float(row[1])); el.append(float(row[2]))
    return np.array(az), np.array(el)

def pack_series(arrs):
    """Delta-encode int16 series, gzip, base64. Smooth data compresses ~4x better as deltas."""
    out = b""
    for a in arrs:
        a = a.astype(np.int64)
        d = np.empty_like(a); d[0] = a[0]; d[1:] = a[1:] - a[:-1]
        out += (d & 0xFFFF).astype("<u2").tobytes()      # wraps exactly like Int16 in the browser
    return base64.b64encode(gzip.compress(out, 9)).decode()

def mask_at(mask, az):
    """Linear interpolation of the 720-point horizon at azimuth az (degrees)."""
    x = np.mod(az, 360.0) * (len(mask) / 360.0)
    i0 = np.floor(x).astype(int) % len(mask); f = x - np.floor(x)
    return mask[i0] * (1 - f) + mask[(i0 + 1) % len(mask)] * f

def disc_fraction(el, hz, r):
    d = np.clip((el - hz) / r, -1, 1)
    a = np.arccos(-d)
    return (a - np.sin(a) * np.cos(a)) / np.pi

# ------------------------------------------------------------------ main loop
os.makedirs(os.path.join(WEB, "eph"), exist_ok=True)
out_sites, report = [], []
for s in sites:
    masks, h_site = horizon_mask(T, s["lat"], s["lon"], MASTS)
    lt = longterm(s["lat"], s["lon"])
    rec = dict(id=s["id"], name=s["name"], group=s["group"], lat=s["lat"], lon=s["lon"],
               h=round(h_site, 1), note=s["note"], longterm=lt, eph=bool(s["folder"]),
               # horizons stored as integers in 1/100 degree to keep the file small
               hz={str(m): [int(round(v * 100)) for v in masks[m]] for m in MASTS})
    if s["folder"]:
        saz, sel = read_csv(os.path.join(HZ, s["folder"], s["id"] + "__sun.csv"))
        eaz, eel = read_csv(os.path.join(HZ, s["folder"], s["id"] + "__earth.csv"))
        rec["ephH"] = s["hz_height"]          # height Horizons was asked for (m)
        q_az = lambda a: np.round(a * (65536 / 360.0)).astype(np.int64) % 65536
        q_el = lambda e: np.round(e * 200.0).astype(np.int64)
        eph = dict(id=s["id"], t0="2026-01-01T00:00Z", stepHours=1, n=len(saz),
                   order=["sunAz", "sunEl", "earthAz", "earthEl"],
                   azScale=360 / 65536, elScale=1 / 200,
                   data=pack_series([q_az(saz), q_el(sel), q_az(eaz), q_el(eel)]))
        with open(os.path.join(WEB, "eph", s["id"] + ".json"), "w") as f:
            json.dump(eph, f)
        # Check 4/5: fractions over 2026-2028 with the 2 m mast horizon
        m = masks[2]
        hs = mask_at(m, saz)
        lit = np.mean(sel + SUN_R > hs) * 100               # upper limb above terrain
        disc = np.mean(disc_fraction(sel, hs, SUN_R)) * 100  # mean visible fraction of the disc
        ear = np.mean(eel > mask_at(m, eaz)) * 100
        rec["check"] = dict(sunLit=round(lit, 1), sunDisc=round(disc, 1), earth=round(ear, 1))
        report.append((s["id"], lit, disc, ear, lt))
    out_sites.append(rec)
    print(f"  {s['id']:42s} h={h_site:8.1f} m  horizon min/max {masks[2].min():6.2f}/{masks[2].max():6.2f} deg", flush=True)

with open(os.path.join(HERE, "..", "..", "handoff", "A3.geojson") if False else os.path.join(RAW, "A3_9regions-lonlat-simplified.geojson")) as f:
    gj = json.load(f)
regions = [dict(code=ft["properties"]["RegionCode"], name=ft["properties"]["Region"],
                area=ft["properties"]["Area_km2"], ring=ft["geometry"]["coordinates"][0]) for ft in gj["features"]]

with open(os.path.join(WEB, "sites.json"), "w") as f:
    json.dump(dict(masts=MASTS, sites=out_sites, regions=regions), f, separators=(",", ":"))

print("\n== Check 4/5: app fractions 2026-2028 (2 m mast) vs NASA long-term averages ==")
print(f"  {'site':42s} {'lit%':>6s} {'disc%':>6s} {'NASA':>6s} | {'earth%':>6s} {'NASA':>6s}")
for sid, lit, disc, ear, lt in report:
    if lt:
        print(f"  {sid:42s} {lit:6.1f} {disc:6.1f} {lt['sun']:6.1f} | {ear:6.1f} {lt['earth']:6.1f}{'  PSR' if lt['psr'] else ''}")
