# Lunar Maps mission workspace

The local redesign uses three mission screens and one shared mission state. The project homepage explains the challenge, links directly into each demo, and credits the NASA sources. The Penpot page **Lunar Maps · Landing and flight console** in **New File 1** contains the desktop and phone homepages plus the three linked flight-console boards. The earlier **Lunar Maps · Mission workspace** page contains the design system and the original workspace and copilot boards.

The homepage's primary launch and methods section draw on [Resonant Planet](https://resonant-planet.vercel.app/). Its Moon image is a still captured from this app's NASA LROC renderer. The shared theme uses mint for action and selection, cyan for Earth, amber for sunlight, and coral for warnings. In the navigator, the time bar, view switch, clearance readout, comparison columns, and shortlist retain their existing controls and interactions.

## Reference decisions

- PamPam keeps its tools within a large map workspace. The Explore screen similarly gives the lunar view the main canvas and groups overlays in a disclosure. [PamPam on Mobbin](https://mobbin.com/screens/daf92140-3741-4495-84d8-3d087b4b208b)
- GetYourGuide shows a map beside a smaller results panel. Explore uses that structure for the site picker, actions, and current Sun, Earth, power and contact readings. [GetYourGuide on Mobbin](https://mobbin.com/screens/7d8762de-2deb-4393-8667-dd8751d3b206)
- Airbnb puts zoom controls near a large location map and keeps location context beside it. The lunar workspace keeps camera controls with the viewport and retains the selected site in the mission bar. [Airbnb on Mobbin](https://mobbin.com/screens/e63057a5-994f-4ef4-96a8-fcc22f1264eb)

The Penpot palette uses graphite for the canvas, slate for panels, mint for selected controls, amber for the Sun, blue for Earth, and coral for interruptions. The workspace uses Inter where installed, with a system fallback. Numeric readings and UTC use tabular figures. The mobile layout stacks the canvas and side panel and adds a shortcut to the site picker.

## Demo flows

1. **Explore a landing site.** Open the 3D Moon at Connecting Ridge and switch to Lander view. Select Earth in **Horizon clearance** and jump to the next Earthset. Use **10 min before** and **10 min after** to see the clearance cross zero. The Sky view shows the same readings and checkpoints.
2. **Compare a mission change.** Choose **Load Connecting Ridge demo** in the clearance panel, or open `/?demo=clearance` from the app root. The demo puts the clock at 17 November 2026, 02:30 UTC. In **Try a mission change**, compare 2 m with 10 m or preview a date delay. The dashed mint line shows the trial mast skyline. **Compare outcomes** saves both scenarios, and loading either scenario restores its settings. The existing Connecting Ridge and Malapert examples still demonstrate site comparisons.
3. **Recover from a schedule change.** At Connecting Ridge, set the start to 15 November 2026 at 00:00 UTC and the length to one lunar day. In Find a window, search the next 90 days for the most simultaneous sunlight and potential contact. The search score rises from 40.9% to 49.6%. The shortlist shows the proposed date has 35 h 30 min with an empty battery under the default assumptions. Set the battery limit to zero to flag this result, then use **Compare original and best date** for the full mission comparison. The search and comparison use different sample intervals.

The **NASA data & methods** dialog describes how LRO LOLA elevations shape the local skyline, JPL Horizons supplies preset Sun and Earth directions, and LROC imagery provides surface context. The existing data, calculation pipeline, detailed timelines, share links and CSV controls remain part of the local app.

## Preview

From the repository root, serve the app with `python -m http.server 8765 --directory web` and open `http://localhost:8765/`.
