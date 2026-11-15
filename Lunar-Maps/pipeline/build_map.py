"""
build_map.py - images and lists for the 2D map (web/data/map/)

For each of three map views it writes picture layers the browser can stack:
  S, N  polar stereographic, 75-90 deg latitude, 2048 x 2048 px (about 447 m/px)
  G     global, simple cylindrical (longitude -180..180), 3072 x 1536 px
Base layers (WebP):   *_wac    LROC WAC photo mosaic, stretched to 8 bits
                      *_relief shaded relief computed from the LOLA elevations
                      *_elev   elevation colours laid over the shaded relief
Overlays (PNG, polar only), stored as plain grey values so the browser can
colour them and report exact numbers under the pointer:
                      *_sun, *_earth  NASA long-term average visibility;
                                      pixel value / 2.5 = percent, 255 = no data
                      *_psr           permanently shadowed regions (white = shadowed)
Lists (JSON):         features.json   IAU names  [name, lat, lon, diameter_km, type code]
                      objects.json    human-made objects (LROC)  [name, mission, kind, lat, lon, date]
                      meta.json       elevation ranges used for the colour scales
"""
import sys, os, json, struct, zipfile, io
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image
from common import Terrain, data_dir

Image.MAX_IMAGE_PIXELS = None
RAW = data_dir()
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "data", "map")
os.makedirs(OUT, exist_ok=True)
T = Terrain()
NP, GW, GH = 2048, 3072, 1536          # polar size; global width and height


def resize(a, size, how=Image.BOX):
    """Resample a 2-D float array to (width, height). BOX = average of the covered cells."""
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize(size, how))


def hillshade(z, cell_m, exag):
    """Shaded relief, light from the upper left at 35 deg altitude. z in metres; returns 0..1."""
    dzdy, dzdx = np.gradient(z * exag, cell_m)            # y runs DOWN the image
    n = np.sqrt(dzdx ** 2 + dzdy ** 2 + 1)
    alt = np.radians(35)
    lx, ly, lz = -np.cos(alt) / np.sqrt(2), -np.cos(alt) / np.sqrt(2), np.sin(alt)
    s = (-dzdx * lx - dzdy * ly + lz) / n
    return np.clip(s / np.sin(alt) * 0.62, 0, 1)          # flat ground comes out mid-grey


# Colour scale for elevation: dark blue (low) -> green -> yellow -> white (high).
# Chosen to keep rising in brightness, so it still reads in greyscale or with colour-blindness.
STOPS = np.array([[20, 24, 82], [38, 76, 140], [35, 127, 142], [60, 170, 120], [150, 205, 90], [235, 225, 110], [250, 245, 215]], float)
def ramp(v):
    v = np.clip(v, 0, 1) * (len(STOPS) - 1)
    i = np.minimum(v.astype(int), len(STOPS) - 2); f = (v - i)[..., None]
    return STOPS[i] * (1 - f) + STOPS[i + 1] * f


def stretch(refl):
    """WAC reflectance -> 8 bit: clip to the 0.5-99.5 percentile range, then gamma to lift dark terrain."""
    ok = refl > -1e30
    lo, hi = np.percentile(refl[ok], [0.5, 99.5])
    v = np.clip((refl - lo) / (hi - lo), 0, 1) ** 0.6
    v[~ok] = 0
    return v


def save_jpg(a01, name, q=82):
    """Save a picture layer. WebP is used instead of JPEG: about a third smaller at the same quality."""
    name = name.replace(".jpg", ".webp")
    a = np.clip(a01 * 255, 0, 255).astype(np.uint8)
    Image.fromarray(a, "RGB" if a.ndim == 3 else "L").convert("RGB").save(os.path.join(OUT, name), quality=q, method=6)
    print(f"  {name:16s} {os.path.getsize(os.path.join(OUT, name)) / 1e6:5.2f} MB")


meta = {}
# ------------------------------------------------------------------- polar maps
for pole, g120 in (("S", T.s120), ("N", T.n120)):
    print("Polar", pole)
    z = resize(np.asarray(g120.z, dtype=np.float32) * 0.5, (NP, NP))
    cell = g120.n * g120.scale / NP
    sh = hillshade(z, cell, 1.6)
    lo, hi = [float(round(v, -2)) for v in np.percentile(z, [0.5, 99.5])]
    meta[pole] = dict(size=NP, radius_km=g120.n * g120.scale / 2000.0, south=(pole == "S"), elevMin=lo, elevMax=hi)
    save_jpg(sh, f"{pole}_relief.jpg")
    save_jpg(ramp((z - lo) / (hi - lo)) / 255 * (0.35 + 0.65 * sh / 0.62)[..., None].clip(0, 1.25), f"{pole}_elev.jpg")
    # WAC polar mosaic: 7861 x 7861 float32 after a 31,444-byte label; crop the 75-90 deg square
    w = np.memmap(os.path.join(RAW, f"WAC_GLOBAL_P900{pole}0000_128P.IMG"), dtype="<f4", mode="r", offset=31444, shape=(7861, 7861))
    half = int(round(meta[pole]["radius_km"] * 1000 / 236.9)); c = 3930
    save_jpg(resize(stretch(np.asarray(w[c - half:c + half + 1, c - half:c + half + 1])), (NP, NP)), f"{pole}_wac.jpg")
    # NASA long-term maps (same grid as the 120 m DEM)
    for kind, fname in (("sun", f"AVGVISIB_75{pole}_120M_201608.tiff"), ("earth", f"AVGVISIB_75{pole}_120M_201608_EARTH.tiff")):
        a = np.array(Image.open(os.path.join(RAW, fname))).astype(np.float32)
        bad = resize((a < 0).astype(np.float32), (1024, 1024)) > 0.5
        v = np.round(resize(np.clip(a, 0, 25000) / 100.0, (1024, 1024))).astype(np.uint8)     # 0..250 = 0..100 %
        v[bad] = 255
        Image.fromarray(v, "L").save(os.path.join(OUT, f"{pole}_{kind}.png"), optimize=True)
        print(f"  {pole}_{kind}.png      {os.path.getsize(os.path.join(OUT, f'{pole}_{kind}.png')) / 1e6:5.2f} MB")
    psr = np.array(Image.open(os.path.join(RAW, f"LPSR_75{pole}_120M_201608.tiff"))) == 20000
    m = resize(psr.astype(np.float32), (NP, NP)) > 0.3            # keep small shadowed patches visible
    Image.fromarray((m * 255).astype(np.uint8), "L").convert("1").save(os.path.join(OUT, f"{pole}_psr.png"), optimize=True)
    print(f"  {pole}_psr.png      {os.path.getsize(os.path.join(OUT, f'{pole}_psr.png')) / 1e6:5.2f} MB")

# ------------------------------------------------------------------- global map
print("Global")
zg = np.asarray(T.glob.z, dtype=np.float32) * 0.5              # 5760 x 2880, longitude 0..360
zg = np.roll(zg, zg.shape[1] // 2, axis=1)                     # -> longitude -180..180 (0 in the middle)
z = resize(zg, (GW, GH))
sh = hillshade(z, 1737400 * np.pi / GH, 5.0)
lo, hi = [float(round(v, -2)) for v in np.percentile(z, [0.5, 99.5])]
meta["G"] = dict(width=GW, height=GH, elevMin=lo, elevMax=hi)
save_jpg(sh, "G_relief.jpg")
save_jpg(ramp((z - lo) / (hi - lo)) / 255 * (0.35 + 0.65 * sh / 0.62)[..., None].clip(0, 1.25), "G_elev.jpg")
w = np.memmap(os.path.join(RAW, "WAC_GLOBAL_E000N0000_032P.IMG"), dtype="<f4", mode="r", offset=46080, shape=(5760, 11520))
save_jpg(resize(stretch(np.asarray(w)), (GW, GH)), "G_wac.jpg")

# ------------------------------------------------------------------- lists
def read_dbf(zip_name, member_end):
    """Minimal reader for the .dbf table inside a shapefile zip (no extra library needed)."""
    with zipfile.ZipFile(os.path.join(RAW, zip_name)) as zf:
        name = [n for n in zf.namelist() if n.lower().endswith(member_end)][0]
        b = zf.read(name)
    nrec, hlen, rlen = struct.unpack("<IHH", b[4:12])
    fields, o = [], 32
    while b[o] != 0x0D:
        fields.append((b[o:o + 11].split(b"\0")[0].decode(), b[o + 16])); o += 32
    rows = []
    for k in range(nrec):
        r = b[hlen + k * rlen: hlen + (k + 1) * rlen]; p = 1; row = {}
        for nm, ln in fields:
            row[nm] = r[p:p + ln].decode("utf-8", "replace").strip(); p += ln
        rows.append(row)
    return rows

feats = []
for r in read_dbf("MOON_nomenclature_center_pts.zip", ".dbf"):
    lon = float(r["center_lon"]); lon = lon - 360 if lon > 180 else lon
    feats.append([r["clean_name"] or r["name"], round(float(r["center_lat"]), 3), round(lon, 3), round(float(r["diameter"]), 1), r["code"]])
feats.sort(key=lambda f: -f[3])                                 # biggest first: the map labels the largest that fit
json.dump(feats, open(os.path.join(OUT, "features.json"), "w"), separators=(",", ":"), ensure_ascii=False)
objs = [[r["SHORT_NAME"], r["MISSION"], r["OBJECT"], round(float(r["LATITUDE"]), 5), round(float(r["LONGITUDE"]), 5), r["DATE"]]
        for r in read_dbf("ANTHROPOGENIC_OBJECTS_180.ZIP", ".dbf")]
json.dump(objs, open(os.path.join(OUT, "objects.json"), "w"), separators=(",", ":"), ensure_ascii=False)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"))
print(len(feats), "IAU features,", len(objs), "human-made objects;", meta)
