"""
common.py - shared helpers for the preprocessing pipeline.

Everything here is about ONE job: answering "how high is the lunar surface at
(lat, lon)?" from the LOLA elevation files, using the finest grid that covers
the point. Heights are metres above a 1737.4 km sphere. Longitudes are
east-positive degrees.

Grids used (finest first):
  LDEM_80x_80M   polar stereographic, 80 m/px,  covers 80-90 deg latitude
  LDEM_75x_120M  polar stereographic, 120 m/px, covers 75-90 deg latitude
  ldem_16        global simple-cylindrical, 16 px/deg (~1.9 km at the equator)
"""
import os
import numpy as np

R_MOON = 1737400.0          # metres, reference sphere of all LOLA products
D2R = np.pi / 180.0


def data_dir():
    """Folder holding the raw NASA files. Override with the LUNAR_RAW env var."""
    return os.environ.get("LUNAR_RAW", "/mnt/user-data/uploads/spaceapps")


class PolarGrid:
    """A LOLA polar stereographic DEM (int16, value * 0.5 = metres)."""

    def __init__(self, path, n, scale_m, south, lat_limit):
        self.n = n                      # pixels per side
        self.scale = scale_m            # metres per pixel
        self.south = south              # True for south pole files
        self.c = (n - 1) / 2.0          # projection centre, 0-based pixel (e.g. 3799.5)
        self.lat_limit = lat_limit      # grid is trusted poleward of this |latitude|
        # np.memmap reads only the parts of the file we touch (saves memory)
        self.z = np.memmap(path, dtype="<i2", mode="r", shape=(n, n))

    def pixel(self, lat, lon):
        """(lat, lon) in degrees -> fractional (line, sample) pixel coordinates.

        rho = 2 R tan((90 - |lat|)/2) is the stereographic distance from the pole.
        South files: 0 deg longitude points UP    (line = c - rho cos lon)
        North files: 0 deg longitude points DOWN  (line = c + rho cos lon)
        Both:        90 deg E points RIGHT        (sample = c + rho sin lon)
        """
        rho = 2 * R_MOON * np.tan((90.0 - np.abs(lat)) * D2R / 2) / self.scale
        sample = self.c + rho * np.sin(lon * D2R)
        if self.south:
            line = self.c - rho * np.cos(lon * D2R)
        else:
            line = self.c + rho * np.cos(lon * D2R)
        return line, sample

    def latlon(self, line, sample):
        """Inverse of pixel(): pixel coordinates -> (lat, lon) degrees."""
        dx = (sample - self.c) * self.scale
        dy = (line - self.c) * self.scale
        rho = np.hypot(dx, dy)
        colat = 2 * np.arctan(rho / (2 * R_MOON)) / D2R
        if self.south:
            lon = np.arctan2(dx, -dy) / D2R
            lat = -(90.0 - colat)
        else:
            lon = np.arctan2(dx, dy) / D2R
            lat = 90.0 - colat
        return lat, lon

    def height(self, lat, lon):
        """Bilinear-interpolated height in metres."""
        line, sample = self.pixel(lat, lon)
        return bilinear(self.z, line, sample) * 0.5


class GlobalGrid:
    """ldem_16: 5760 x 2880, row 0 = 90N, column 0 = 0E, 16 px/deg."""

    def __init__(self, path, ppd=16):
        self.ppd = ppd
        self.w, self.h = 360 * ppd, 180 * ppd
        self.z = np.memmap(path, dtype="<i2", mode="r", shape=(self.h, self.w))

    def height(self, lat, lon):
        # pixel centres sit at half-pixel offsets, hence the -0.5
        x = (np.mod(lon, 360.0)) * self.ppd - 0.5
        y = (90.0 - lat) * self.ppd - 0.5
        return bilinear(self.z, y, x, wrap_x=True) * 0.5


def bilinear(z, y, x, wrap_x=False):
    """Bilinear interpolation of 2-D array z at fractional (row y, column x)."""
    y = np.asarray(y, dtype=np.float64)
    x = np.asarray(x, dtype=np.float64)
    h, w = z.shape
    y = np.clip(y, 0, h - 1.001)
    y0 = np.floor(y).astype(np.int64)
    fy = y - y0
    if wrap_x:
        x0 = np.floor(x).astype(np.int64)
        fx = x - x0
        x1 = (x0 + 1) % w
        x0 = x0 % w
    else:
        x = np.clip(x, 0, w - 1.001)
        x0 = np.floor(x).astype(np.int64)
        fx = x - x0
        x1 = x0 + 1
    y1 = y0 + 1
    z00 = z[y0, x0].astype(np.float64)
    z01 = z[y0, x1].astype(np.float64)
    z10 = z[y1, x0].astype(np.float64)
    z11 = z[y1, x1].astype(np.float64)
    return (z00 * (1 - fx) + z01 * fx) * (1 - fy) + (z10 * (1 - fx) + z11 * fx) * fy


class Terrain:
    """All DEMs together; height() picks the finest grid covering each point."""

    def __init__(self, raw=None):
        raw = raw or data_dir()
        p = lambda name: os.path.join(raw, name)
        self.s80 = PolarGrid(p("LDEM_80S_80M.IMG"), 7600, 80.0, True, 80.02)
        self.s120 = PolarGrid(p("LDEM_75S_120M.IMG"), 7624, 120.0, True, 75.02)
        self.n80 = PolarGrid(p("LDEM_80N_80M.IMG"), 7600, 80.0, False, 80.02)
        self.n120 = PolarGrid(p("LDEM_75N_120M.IMG"), 7624, 120.0, False, 75.02)
        self.glob = GlobalGrid(p("ldem_16.img"))

    def height(self, lat, lon):
        lat = np.atleast_1d(np.asarray(lat, dtype=np.float64))
        lon = np.atleast_1d(np.asarray(lon, dtype=np.float64))
        out = np.empty(lat.shape)
        done = np.zeros(lat.shape, dtype=bool)
        for grid, sel in ((self.s80, lat < -self.s80.lat_limit),
                          (self.n80, lat > self.n80.lat_limit),
                          (self.s120, lat < -self.s120.lat_limit),
                          (self.n120, lat > self.n120.lat_limit)):
            m = sel & ~done
            if m.any():
                out[m] = grid.height(lat[m], lon[m])
                done |= m
        m = ~done
        if m.any():
            out[m] = self.glob.height(lat[m], lon[m])
        return out


def destination(lat, lon, bearing, dist_m):
    """Point reached by travelling dist_m along a great circle from (lat, lon)
    on the given compass bearing (degrees clockwise from north). Vectorised."""
    d = dist_m / R_MOON
    p1, l1, b = lat * D2R, lon * D2R, bearing * D2R
    p2 = np.arcsin(np.clip(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b), -1, 1))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return p2 / D2R, l2 / D2R


def march_distances(start_m, spacing_m, end_m):
    """Sample distances along a ray: step = max(grid spacing, 0.5 % of distance)."""
    d, out = start_m, []
    while d <= end_m:
        out.append(d)
        d += max(spacing_m, 0.005 * d)
    return np.array(out)


def horizon_mask(terrain, lat, lon, masts=(2.0,), n_az=720):
    """Terrain horizon seen from a site: for each compass direction, the highest
    elevation angle (degrees) reached by any terrain along that direction.

    Geometry is exact for a sphere: observer at radius r0, terrain point at
    radius r, separated by central angle theta = d / R:
        elevation = atan2(r cos(theta) - r0, r sin(theta))
    `masts` is a list of mast heights in metres; the terrain is sampled once and
    reused for every height. Returns ({mast: mask_degrees[n_az]}, site_height_m);
    mask[i] is azimuth i*360/n_az.
    """
    polar = abs(lat) > 75.1
    # Where the march starts matters a lot on ridges and crater rims.
    #  - Full-resolution polar grids (this script): start ONE GRID CELL out
    #    (80 m or 120 m). Tested against NASA's long-term sunlight maps: starting
    #    600 m out (as the first prototype did) ignored real nearby terrain and
    #    overstated sunlight on ridges by up to 30 percentage points.
    #  - Global 1.9 km grid: start 1.5 km out (cells are too coarse to trust closer).
    if polar:
        cell = 80.0 if abs(lat) > 80.02 else 120.0
        dist = march_distances(cell, cell, 300e3)
    else:
        dist = march_distances(1500.0, 1895.0, 600e3)
    az = np.arange(n_az) * (360.0 / n_az)
    h_site = float(terrain.height(lat, lon)[0])
    A, Dm = np.meshgrid(az, dist, indexing="ij")          # shape (n_az, n_steps)
    plat, plon = destination(lat, lon, A, Dm)
    r = R_MOON + terrain.height(plat.ravel(), plon.ravel()).reshape(A.shape)
    theta = Dm / R_MOON
    out = {}
    for mast_m in masts:
        r0 = R_MOON + h_site + mast_m
        out[mast_m] = (np.arctan2(r * np.cos(theta) - r0, r * np.sin(theta)) / D2R).max(axis=1)
    return out, h_site


def pack_png(z, path):
    """Save a grid of whole-metre heights as a small greyscale PNG the browser can decode exactly.

    Steps (reversed by Terrain.decodeGrid in web/js/terrain.js):
      1. predictor: store each value minus (left + up - up-left), which is near zero on smooth terrain;
      2. split the 16-bit results into a low-byte image stacked on top of a high-byte image;
      3. write those bytes as an 8-bit PNG (PNG's own lossless compression does the rest).
    A PNG is used purely as a container: it is about a quarter smaller than base64 text in JSON.
    """
    from PIL import Image
    zi = np.round(z).astype(np.int16).astype(np.int32)
    pred = np.zeros_like(zi)
    pred[:, 1:] += zi[:, :-1]; pred[1:, :] += zi[:-1, :]; pred[1:, 1:] -= zi[:-1, :-1]
    res = ((zi - pred) & 0xFFFF).astype(np.uint16)
    planes = np.vstack([(res & 0xFF).astype(np.uint8), (res >> 8).astype(np.uint8)])
    Image.fromarray(planes, "L").save(path, optimize=True)
