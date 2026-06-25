# Schattenroute — shade-aware walking routes

A web app that finds **walking routes with the most shade** for pedestrians —
made with older people, parents with strollers, and anyone avoiding the midday
sun in mind. Built on open data (OpenStreetMap) with no API keys.

Default city: **Karlsruhe**.

## Run it

You need [Node.js](https://nodejs.org) (any recent version).

```bash
node serve.mjs        # then open http://localhost:5173
```

(ES modules must be served over HTTP — opening `index.html` directly via
`file://` will not work. Any static server works, e.g. `python -m http.server`.)

## Test the algorithms

```bash
npm test              # or: node tests/run.mjs
```

35 unit tests cover solar geometry, the projection/geometry helpers, graph
building, Dijkstra + alternatives, the shadow model, and end-to-end routing.

## How it works

1. **Input** — type a start and destination (address search via Nominatim),
   tap them on the map, or use a Karlsruhe preset. Markers are draggable.
2. **Data** — the pedestrian network, building footprints and trees are fetched
   live from OpenStreetMap via the Overpass API for the area around your trip.
3. **Graph + Dijkstra** — walkable ways become a routing graph; Dijkstra finds
   the fastest pedestrian path (`js/dijkstra.js`).
4. **Alternative candidates** — additional distinct routes are generated with an
   iterative edge-penalty method (`alternativeRoutes`).
5. **Shadow estimation** (`js/shadow.js`) —
   - **Building heights** from `height` / `building:levels` tags, with
     type-based fallbacks.
   - **Tree** height, crown radius and **leaf density** from `height`,
     `diameter_crown`, `leaf_type`, modulated by the **season** (deciduous trees
     drop their leaves in winter).
   - The **sun position** (NOAA algorithm, `js/solar.js`) for the chosen date &
     time gives a shadow direction and length; footprints/crowns are projected
     onto the ground to estimate how shaded each sidewalk segment is.
6. **Shade weighting** — each candidate's segments are weighted by sun exposure;
   the **time-vs-shade slider** decides how far out of the way it is worth going
   for shade. The best-scoring candidate is recommended; the fastest and
   shadiest are always shown for comparison.

### For pedestrians who need it

- **Walking pace** presets (3 / 4 / 5 km/h) feed realistic travel times.
- **Avoid stairs** strongly penalises `highway=steps` for wheelchairs/strollers.
- Large touch targets, high contrast, responsive layout for **phone & desktop**.

## Notes & limitations

- Shade is an **estimate** from open data — tree canopies, exact heights and
  terrain are approximate. Treat it as guidance, not ground truth.
- Building shadows use a convex-hull projection of the footprint; concave
  buildings are slightly overestimated. Trees are modelled as translucent
  crown disks whose opacity reflects leaf density.
- Very long trips (> ~60 km² bounding box) are blocked to keep the in-browser
  computation responsive.

## Two front-ends, one engine

This repo has two interchangeable UIs over the same real shade maths:

- **Schattenroute** (`index.html` + `js/*` ES modules) — the original, with its own
  Dijkstra routing graph built from the OSM walking network.
- **ShadeWalk** (`ShadeWalk.dc.html`) — a cleaner UI built on the DC runtime
  (`support.js`). It gets candidate routes from the OSRM foot router and scores
  them with `engine.js` — a browser-global build of the same tested sun/shadow
  maths (NOAA sun position, real OSM building footprints & heights, street trees,
  shadow projection). This is the deployed front page.

## Project layout

```
ShadeWalk.dc.html    ShadeWalk UI (DC component)         — deployed front page
support.js           DC runtime (third-party)
engine.js            real sun/shadow engine (browser global) — tested
index.html           Schattenroute UI
css/styles.css       responsive, accessible styling
js/solar.js          sun position (NOAA)          — pure, tested
js/geometry.js       projection & polygon math    — pure, tested
js/graph.js          OSM → routing graph          — pure, tested
js/dijkstra.js       shortest path + alternatives — pure, tested
js/shadow.js         height/leaf & shadow field   — pure, tested
js/routing.js        candidate scoring/selection  — pure, tested
js/overpass.js       OpenStreetMap data fetch     — browser
js/geocode.js        Nominatim address search     — browser
js/app.js            map + UI wiring              — browser
serve.mjs            zero-dependency static server
tests/               Node test harnesses (run.mjs, engine.test.mjs, component.test.mjs, integration.mjs)
```

Run the tests: `node tests/run.mjs && node tests/engine.test.mjs && node tests/component.test.mjs`

> Deployment configuration (server host, credentials, `.htaccess`) is intentionally
> **not** in this repository.

Map data © OpenStreetMap contributors (ODbL).
