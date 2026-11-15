# Lunar Landing Site Navigator

A static web app (HTML + CSS + JavaScript, no server code) for comparing lunar landing
sites and dates: Sun and Earth above the real terrain horizon, sunlight, Earth and
Deep Space Network windows, solar power and battery.

## Run it

    cd web
    python -m http.server 8000
    # then open http://localhost:8000

(Opening index.html by double-click does not work: browsers block data loading from disk.)

For GitHub Pages: in the repository settings choose Pages, "Deploy from a branch", branch `main`,
folder `/ (root)`. The small `index.html` at the top level forwards visitors to `web/`.

## What is in the app

Site picker (44 presets plus custom coordinates), shared time bar, sky view (panorama / dial),
2D map, 3D map and lander view (both WebGL2), timelines, window summary, scenario comparison,
find-a-window, sharing and CSV export. All data is bundled (about 32 MB; only about 2 MB is needed
for the first screen, the rest loads when a panel or layer is first used). No network requests at run time.

## Folders

| Folder | What it is |
|---|---|
| `web/` | The app. `js/astro.js` ephemeris, `js/terrain.js` browser terrain, `js/engine.js` all calculations, `js/map.js` the 2D map, `js/globe.js` the 3D map (WebGL2), `js/pov.js` the lander view (WebGL2), `js/app.js` the screen. `data/` holds the bundled data. |
| `pipeline/` | Python scripts that turn the raw NASA files into `web/data/`. |
| `tests/` | `check_engine.js` (accuracy checks), `shot.py` (headless-browser screenshots). |
| `reference/` | Lists reused from the first prototype. |

## Rebuild the data (Windows, from this folder)

    pip install numpy pillow scipy
    set LUNAR_RAW=C:\Users\Wayne\Desktop\spaceapps
    set LUNAR_HORIZONS=C:\Users\Wayne
    python pipeline\check_dem.py        # DEM spot heights and orientation
    python pipeline\build_sites.py      # sites.json + eph/*.json, prints the illumination checks
    python pipeline\build_terrain.py    # 400 m polar grids for custom sites
    python pipeline\build_map.py        # map pictures, overlays, IAU names and human-made objects
    python pipeline\build_globe.py      # small height grids for the 3D map and far terrain in the lander view
    python pipeline\build_pov.py        # close-range 80 m terrain tile for each preset site (lander view)
    node tests\check_engine.js          # ephemeris, Apollo 11, regions, custom-site checks

## Optional: JPL Horizons tables for the 16 sites that lack them

    cd C:\Users\Wayne
    python Desktop\spaceapps\navigator\pipeline\fetch_horizons_extra.py
    # creates C:\Users\Wayne\horizons_extra ; then re-run build_sites.py

Until then those sites (north pole points, extra historic landers) use the in-browser
ephemeris, which is within about 0.03 degrees of Horizons.

## Method notes

- Preset horizons: 720 directions, marched from one grid cell out (80 m or 120 m) to 300 km
  on the full-resolution LOLA polar grids; 1.5 km to 600 km on the global grid elsewhere.
- Mast height: preset horizons are precomputed for 2, 3, 4, 6, 8, 10, 15, 20, 25 and 30 m. Any other height
  from 2 to 30 m is blended from the two nearest; the blend is never lower than the true skyline
  (tested: mean difference under 0.04 degrees, worst single direction 0.44 degrees).
- Custom-site horizons: traced in the browser on 400 m (polar) / 7.6 km (global) grids,
  starting 600 m / 1.5 km out, and labelled approximate.
- Sunlit = any part of the Sun above the terrain. Earth visible = centre above terrain (setting).
- DSN link = Earth visible from the site and the Moon at least 10 degrees up at Goldstone,
  Madrid or Canberra (setting).
- Power = 1361 W/m2 x (1 AU / r)^2 x area x efficiency x visible Sun fraction x cos(incidence).
  Lander layouts are approximations; panels shading each other is not modelled.

## Data sources

- Terrain and long-term illumination maps: NASA LRO LOLA (PDS; Mazarico et al. illumination products) - https://pgda.gsfc.nasa.gov/products/69
- Imagery: NASA LROC WAC global and polar mosaics - https://data.lroc.im-ldi.com/lroc/rdr_product_select? 
- Sun and Earth directions: calculated using NASA JPL Horizons API - https://ssd-api.jpl.nasa.gov/doc/horizons.html 
- Feature names: IAU Gazetteer of Planetary Nomenclature Moon GIS Download - https://planetarynames.wr.usgs.gov/Page/MOON/target 
- Human-made objects: LROC Anthropogenic Features on the Moon Shapefiles - https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_ANTHROPOGENIC_OBJECTS
- Artemis III candidate regions: LROC Quickmap Layer GeoJSON - A3: Candidate Landing Regions 2024 - https://quickmap.lroc.asu.edu/
