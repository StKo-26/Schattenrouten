# SchattenRouten / ShadyRoutes — Handoff & Findings

_Updated 2026-06-25._

Shade-aware pedestrian routing. Type a start + destination, get walking routes
ranked by how much of each stays in shade (building + tree shadows from real OSM
data and the real sun position), with live turn-by-turn navigation. Aimed at older
people, parents with strollers, and anyone avoiding midday sun.

Brand: **SchattenRouten** (German) / **ShadyRoutes** (English). Live on two domains.

> Deploy hosts, paths and passwords live in `server.md` and `deploy.ps1`, which are
> git-ignored on purpose. **Nothing in this file is a secret.**

---

## Architecture

Plain browser globals + a small React-based "DC" runtime (`support.js`, third-party;
`<x-dc>` templates with `{{ binding }}`, `class Component extends DCLogic`,
`renderVals()`). No build step.

| File | Role |
|---|---|
| `engine.js` (`window.ShadeEngine`) | Real math: NOAA sun position, Overpass fetch of buildings/trees, convex-hull shadow projection, spatial grid, `shadeAtLatLng`, `shadeFractionOfRoute`. Dependency-free (also runs in Node for tests). |
| `nav-core.js` (`window.NavCore`) | Pure geo/route helpers: OSRM foot routing, haversine, `projectOnPath`, maneuvers, German instruction text, distance formatting. (Its `shadeAt` is a fallback only; the real shade comes from `engine.js`.) |
| `nav-fusion.js` (`window.NavFusion`) | Pedestrian Extended Kalman Filter `[px,py,v,θ]` fusing GPS + compass heading + accelerometer step cadence; `StepDetector`. |
| `ShadeWalk.dc.html` | The planner, deployed as `index.html`. Home + results map (real OSM buildings/shadows/trees), hero background map, DE/EN switch, shade-vs-time weighting, **"use my location" start button**. |
| `Navigator.dc.html` | Turn-by-turn live navigation. Real GPS sensor fusion, off-route reroute, building/shade overlay, device-orientation cone, no-GPS notice. Receives `from/to/fromName/toName/hour/shade/theme` via URL query. |
| `recht.html` | Impressum / Datenschutz. |
| `index.html` (repo root) | A **separate, older** plain-HTML prototype ("Pick on map"). NOT the live product — the live product is `ShadeWalk.dc.html`. |

External services: OSRM (`routing.openstreetmap.de`), Overpass (3 endpoints incl.
`maps.mail.ru` as a working fallback), Nominatim, CARTO tiles, Leaflet (unpkg).

The real `engine.js` is integrated into **both** ShadeWalk and the Navigator (the
old "placeholder downgrade" idea was abandoned; real OSM + NOAA shade is used).

---

## Bugs found & fixed (Navigator) — diagnosed in a real browser

Node logic tests passed while the page was still broken on a phone. A
**Playwright Chromium Android-emulation** harness was built to reproduce and fix:

1. **Route + buildings never appeared on a phone (root cause).** `loadRoute()`
   `await`ed the Overpass building fetch *before* showing the route, so a
   slow/unreachable Overpass kept the spinner up forever. Fix: show the route
   instantly (provisional shade), then load real OSM shade in the **background** and
   upgrade. Overpass is time-bounded (≤13 s) so it can never hang the UI.

2. **All map overlays were invisible (z-index stacking).** The Leaflet container
   created no stacking context, so its panes (z 200–700) painted over every overlay
   (controls + the no-GPS notice, z 10–30). The route still showed because its SVG
   overlay is z-450. Fix: give the map container its own stacking context
   (`z-index:0`). Now the legend, recenter button, recalculating pill and red notice
   all paint.

3. **Off-route reroute.** The dot used to snap to the route line (hiding the real
   position). Now the dot is the **real fused position**; when **>20 m** off it
   recalculates **instantly** from the live spot, shows a "Route wird neu berechnet"
   loading pill, and displays the new route ASAP (instant-then-refine, never blocked
   on Overpass). Off-route distance is recomputed the instant the new route applies.

4. **Device orientation.** A translucent "field of view" cone shows where the
   **phone points** (iOS `webkitCompassHeading`, Android absolute `alpha`, with
   screen-orientation compensation), distinct from the travel-direction arrow.

5. **No-GPS notice.** Denied location → a large red "KEIN GPS-ZUGRIFF" banner with a
   retry button, plus the fat-red status line. (No entrance animation, and the demo
   does not auto-play on error, so the banner stays solid.)

## ShadeWalk

- **"Use my location" is now a visible crosshair button** in the start field, not
  just a focus-dropdown entry. It does a high-accuracy GPS prompt and fills the start
  with the live position ("Mein Standort" / "My location"). DC note: `{{ }}` bindings
  do not work in `title`/`aria-label` attributes — use static values there.

---

## Test infrastructure

Node (offline, deterministic): `tests/run.mjs` (core algorithms), `engine.test.mjs`,
`component.test.mjs`, `fusion.test.mjs`, and `navigator.test.mjs` (extracts the
Navigator + ShadeWalk Component classes; exercises loadRoute / reroute / renderVals /
"use my location" with mocked network + a best-effort live OSRM/Overpass check; ~106
assertions).

Browser (Playwright Chromium, Android `Pixel 5` emulation):
- `tests/browser/server.mjs` — static server (localhost = secure origin for geo/sensors).
- `tests/browser/smoke.mjs` — sandbox can render + spoof GPS/IMU.
- `tests/browser/nav.e2e.mjs` — **full GPS + IMU spoofing** with deterministic OSRM +
  Overpass fixtures. 4 scenarios (boot+buildings, live walk w/ moving dot + compass
  cone, off-route instant reroute + loading indicator, no-GPS red notice). 18 checks;
  screenshots to `%TEMP%\nav_e2e_*.png`.
- `tests/browser/home.smoke.mjs` — ShadeWalk boots + locate button works.
- `tests/browser/debug_*.mjs` — ad-hoc diagnostics used to find the bugs above.

The Navigator publishes a `window.__nav` diagnostics object from its paint loop
(route pts, buildings drawn, gps state, off-route metres, rerouting, dot/pos,
deviceHeading) so the browser tests assert deterministically rather than on pixels.

Run: `npm test` · `npm run test:unit` · `npm run test:e2e` · `npm run test:browser`.
Setup: `npm i` then `npx playwright install chromium`.

---

## Deploy

`ShadeWalk.dc.html` deploys as `index.html`; `Navigator.dc.html`, `engine.js`,
`nav-core.js`, `nav-fusion.js`, `recht.html`, `support.js` ship alongside. Both
domains serve over HTTPS with an http→https redirect (`.htaccess` in `deploy/`,
git-ignored). Mechanism + credentials: `server.md` / `deploy.ps1` — local only,
never committed. Password rotation (`server.md` §11) is still pending.

---

## Coordination / open notes

- A parallel effort is adding **shared building caches** in `engine.js` and
  **re-adding building/shadow rendering to the planner** — do not clobber those.
- Repo-root `index.html` is a separate older prototype; the live product is
  `ShadeWalk.dc.html`. `ShadeWalk.dc(1).html` is a stray duplicate working copy.
