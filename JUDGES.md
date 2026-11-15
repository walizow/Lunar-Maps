# Judging and verification guide

Lunar Maps addresses the NASA Space Apps **Lunar Landing Site Navigator** challenge. It shows how a site, arrival date, or hardware assumption changes modeled sunlight and potential direct-to-Earth contact. These instructions are for human and automated reviewers. The outcomes below are reproducible observations. Use the official judging rubric to make your own assessment.

## Start here

- **Browser available.** From the repo root, run `python -m http.server 8000 --directory web` and open [the homepage](http://localhost:8000/). Click **Why it matters** for the mission problem, then open one of the three demos below.
- **No WebGL2.** In **Explore**, choose **Sky view** to see the skyline and use the same Earthset and mast checkpoints. Choose **2D map** to inspect landing sites. Compare and Find work without 3D.
- **Shell available, no browser.** Run `node tests/check_demo.js` with Node.js 24. The check uses the app engine and checked-in NASA-derived assets. It needs no installs, API keys, raw CSVs, or outbound network. It exercises model outcomes independently of the interface.
- **Repository files only.** Inspect the linked source and data in the traceability table. Those files establish the intended behavior and its data path. Browser behavior and numerical results require execution to confirm.
- **Missing an OpenAI key or running on static hosting.** Use **Mission Copilot → Show Earthset** or the bundled narration. The three demos and the engine check run independently of Copilot.

## Reproduce the three outcomes

### 1. Explore the horizon from Connecting Ridge

1. Open [Earthset](http://localhost:8000/navigator.html?demo=earthset). The workspace opens in **Lander view** and faces Earth.
2. In **Horizon clearance**, select **10 min before**. The Earth center has positive clearance and the panel shows **Earth visible**.
3. Select **10 min after**. The clearance turns negative and the panel shows **Earth hidden**. The camera, timestamp, and readout follow the selected checkpoint.

**Evidence to assess.** The first-person view links the obstructing terrain to the same local skyline and clock used for the visibility result. The Earthset timestamp is a model estimate. If the 3D terrain cannot render, repeat the checkpoints in **Sky view**.

### 2. Compare a site choice or a mast-height change

1. Open [Compare](http://localhost:8000/navigator.html?view=compare). The two example columns should be **Connecting ridge** and **Malapert peak**, with aligned timelines.
2. Open [the fixed-time clearance demo](http://localhost:8000/navigator.html?demo=clearance). It starts at **17 November 2026, 02:30 UTC**.
3. In **Try a mission change**, examine the 2 m and 10 m settings. Earth-center clearance changes from **−0.819° to +0.817°**.
4. Choose **Compare outcomes**. Find columns for the baseline and the changed mast setting. Use **Load** on a column to inspect its restored configuration.

**Evidence to assess.** The mast comparison holds time and location constant. The clearance reversal follows the skyline at Earth's bearing. A single positive clearance says the center is above terrain at that time. Potential contact further depends on the DSN geometry setting.

### 3. Recover from an arrival delay

1. Open [Find a window](http://localhost:8000/navigator.html?view=find). Keep **Connecting ridge**, a **2 m** mast, and the default power assumptions (**200 W** load, **1,500 Wh** battery).
2. Set **Window starts (UTC)** to **15 November 2026, 00:00**, with **1 lunar day (29.53 d)** as the length.
3. Under **Best start date for**, select **most sunlight + potential contact**. Search the next **90 days**.
4. Look for **15 December 2026, 18:00 UTC**. The engine's search score improves from **40.9% to 49.6%**. The detailed shortlist can show **49.7%** because it uses a different sampling interval.
5. In the shortlist, the leading result has **35 h 30 min** with an empty battery under the default settings. Set **Max empty-battery hours** to **0** to flag it. Choose **Compare original and best date** to inspect the trade-off.

**Evidence to assess.** A date can score higher for simultaneous sunlight and contact while performing worse against a power constraint. The shortlist exposes that conflict so a reviewer can weigh the two conditions.

## Evidence by judging criterion

| Criterion | What to review | What the evidence supports |
| --- | --- | --- |
| **Impact** | Read **Why it matters** on the [homepage](web/index.html), then reproduce the date and battery trade-off. | The workflow lets a user inspect consequences of a delayed arrival for modeled power and potential contact. It does not establish adoption or outcomes for flown missions. |
| **Creativity** | Follow the same Earthset in the lander view and the skyline panel, then change mast height at a fixed time. | Visualization and scenario analysis share the same model. A change in the visible scene can be connected to a numeric change and compared with mission-wide results. |
| **Validity** | Follow NASA inputs through the processing and engine paths below. Run the bundled check. | The demos use NASA-derived data for their calculations. The bundled check verifies internal reproducibility. [Independent Horizons validation](README.md#independent-comparison-against-jpl-horizons) requires separate CSV inputs. |
| **Relevance** | Verify site/date comparison, Sun and Earth relative to the terrain horizon, and the sunlight and contact timelines. | These actions address the selected challenge directly. See the [model and limits](README.md#model-and-limits) for the distinction between geometry and a complete communications or power plan. |
| **Presentation** | Start on the homepage and use the three demo entry points. Check Guide mode, labels, and NASA data credits. | Visitors can move from the mission problem to a concrete result, and inspect the methods and assumptions in the same app. |

## Trace the numbers to the data

| Claim | Inspect |
| --- | --- |
| **LOLA elevations affect visibility.** | [Preset skyline builder](pipeline/build_sites.py) prepares the [catalog and masks](web/data/sites.json). [Browser terrain](web/js/terrain.js) handles custom locations. [Engine](web/js/engine.js) applies azimuth-specific skyline values through `maskAt`, `sunUp` and `earthUp`. |
| **JPL Horizons supplies time-varying Sun and Earth directions.** | [Connecting Ridge ephemeris](web/data/eph/derosa2012-cr1-connecting-ridge.json) contains a time grid and packed azimuth/elevation samples. Read `ensureTable` and `pos` in [engine.js](web/js/engine.js) to follow decoding, interpolation, and the analytical fallback. |
| **LROC provides the surface view.** | [Map pipeline](pipeline/build_map.py) prepares [map assets](web/data/map/). [Globe](web/js/globe.js) and [map](web/js/map.js) consume them for display. |
| **The demos show model results.** | [Workspace app](web/js/app.js) binds the shared time, clearance checkpoints, scenarios and date shortlist to the engine. [Bundled-data check](tests/check_demo.js) calls that same engine from Node. |

NASA LOLA and JPL Horizons affect the actual computed outputs. LROC imagery adds geographic context. The prototype runs with the processed resources in the repo. The full raw-data validation remains a separate optional check. See the [README data sources](README.md#how-nasa-data-supports-the-solution) for the original providers.
