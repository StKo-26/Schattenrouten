// Extensive tests for the Navigator (turn-by-turn live navigation).
//
// Goal: prove the navigation works with ANY start/end and ANY route, ANYWHERE —
// no Karlsruhe hardcoding, real engine.js shade (NOAA sun + OSM buildings/trees),
// not the old fake hash/distance-from-Karlsruhe placeholder.
//
//  Part A — engine geometry is correct at many locations worldwide (offline).
//  Part B — Navigator.loadRoute() flow is correct for many start/end pairs
//           across different cities, with network mocked (deterministic).
//  Part C — best-effort live test against real OSRM + Overpass (skipped on network failure).

import fs from 'node:fs';

// ---- load the browser globals into Node (engine + nav-core + nav-fusion) ----
globalThis.window = globalThis;
globalThis.location = { search: '' };
globalThis.window.location = globalThis.location;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(read('../engine.js'));
(0, eval)(read('../nav-fusion.js'));
(0, eval)(read('../nav-core.js'));

const SE = window.ShadeEngine, NC = window.NavCore;

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.error('  ✗ FAIL: ' + m); } };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/* =========================================================================
   Part A — real engine shadows are geometrically correct at any location.
   ========================================================================= */
console.log('\n• Part A — engine.js shade geometry (worldwide, offline)');

// Solar-noon-ish UTC time for a given longitude, so the sun is always up.
function solarNoonUTC(lon) {
  let h = 12 - Math.round(lon / 15);
  h = ((h % 24) + 24) % 24;
  return new Date(Date.UTC(2026, 5, 25, h, 0, 0)); // 25 Jun 2026
}
// a square building footprint (metres) centred on lat/lon
function squareBuilding(lat, lon, sizeM, h) {
  const dLat = sizeM / 2 / 111320, dLon = sizeM / 2 / (111320 * Math.cos(lat * Math.PI / 180));
  return { ring: [
    { lat: lat - dLat, lon: lon - dLon }, { lat: lat - dLat, lon: lon + dLon },
    { lat: lat + dLat, lon: lon + dLon }, { lat: lat + dLat, lon: lon - dLon },
  ], h, tags: { building: 'yes' } };
}
const SITES = [
  ['Karlsruhe', 49.0094, 8.4037], ['Berlin', 52.5200, 13.4050],
  ['Hamburg', 53.5511, 9.9937], ['München', 48.1351, 11.5820],
  ['rural Bayern', 48.7100, 11.2200], ['New York', 40.7128, -74.0060],
  ['Sydney', -33.8688, 151.2093],
];
for (const [name, lat, lon] of SITES) {
  const date = solarNoonUTC(lon);
  const sun = SE.sunPosition(date, lat, lon);
  const bld = squareBuilding(lat, lon, 12, 25);
  const field = SE.buildField([bld], [], sun, lat, lon, 6);
  if (!field.valid) { ok(false, `${name}: sun above horizon at solar noon (elev=${sun.elevationDeg.toFixed(1)})`); continue; }
  const b = field.buildingsLatLng[0];
  const hasShadow = b.shadow && b.shadow.length >= 3;
  ok(hasShadow, `${name}: building casts a shadow polygon (sun elev ${sun.elevationDeg.toFixed(0)}°)`);
  if (!hasShadow) continue;
  // centroid of the shadow polygon must read as fully shaded
  let clat = 0, clon = 0; b.shadow.forEach(p => { clat += p[0]; clon += p[1]; });
  clat /= b.shadow.length; clon /= b.shadow.length;
  ok(field.shadeAtLatLng(clat, clon) === 1, `${name}: point inside the shadow reads shade = 1`);
  // a point 2 km to the south is in the open
  ok(field.shadeAtLatLng(lat - 0.02, lon) === 0, `${name}: point 2 km away reads shade = 0`);
  // a short route crossing the footprint is partly shaded, fraction within [0,1]
  const route = [[lat - 0.0006, lon], [lat, lon], [lat + 0.0006, lon]];
  const f = field.shadeFractionOfRoute(route);
  ok(f > 0 && f <= 1, `${name}: route crossing the building has shade fraction in (0,1]: ${f.toFixed(2)}`);
}

/* =========================================================================
   Part B — Navigator.loadRoute() across many start/end pairs (mocked network).
   ========================================================================= */
console.log('\n• Part B — Navigator.loadRoute() for arbitrary start/end (mocked net)');

// Extract the Navigator's Component class and run it under a tiny DC stub.
const html = read('../Navigator.dc.html');
const a0 = html.indexOf('class Component extends DCLogic');
const b0 = html.indexOf('</script>', a0);
const clsSrc = html.slice(a0, b0);
class DCLogic { constructor() { this.state = {}; } setState(p) { this.state = { ...this.state, ...(typeof p === 'function' ? p(this.state) : p) }; } }
globalThis.DCLogic = DCLogic; globalThis.React = { createElement() {} };
// eslint-disable-next-line no-eval
const Component = (0, eval)('(function(){' + clsSrc + '\n; return Component;})()');

// deterministic synthetic routes + matching OSM, stashed per call
let CURRENT_OSM = { buildings: [], trees: [] };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function straight(from, to, n) { const p = []; for (let i = 0; i <= n; i++) p.push(lerp(from, to, i / n)); return p; }
function bowed(from, to, bowM, n) { const p = []; for (let i = 0; i <= n; i++) { const q = lerp(from, to, i / n); p.push([q[0] + Math.sin(Math.PI * i / n) * (bowM / 111320), q[1]]); } return p; }
function distOf(c) { let d = 0; for (let i = 1; i < c.length; i++) d += NC.hav(c[i - 1], c[i]); return d; }

// Build candidate routes from the ACTUAL endpoints handed to fetchRoutes, and stash
// matching OSM (a building band along the shady detour) for the next field build.
function makeRoutes(from, to) {
  const shady = bowed(from, to, 400, 60);   // detour, fully lined with buildings -> shady
  const sunny = straight(from, to, 60);      // direct, open -> sunny + shorter
  const buildings = [];
  for (let i = 1; i < shady.length - 1; i++) buildings.push(squareBuilding(shady[i][0], shady[i][1], 18, 14));
  CURRENT_OSM = { buildings, trees: [{ lat: shady[2][0], lon: shady[2][1], h: 9, crownR: 4, density: 0.7 }] };
  return [{ coords: shady, dist: distOf(shady), steps: [] }, { coords: sunny, dist: distOf(sunny), steps: [] }];
}
function installMocks() {
  NC.fetchRoutes = async (a, b) => makeRoutes(a, b);
  SE.fetchBuildingsTrees = async () => CURRENT_OSM;
}

async function runPair(name, from, to, weight) {
  installMocks();
  const c = new Component({});
  c.state.from = from; c.state.to = to; c.state.hour = 13; c.state.weight = weight;
  await c.loadRoute();
  if (c._refineP) await c._refineP;   // wait for the background OSM shade upgrade
  return c;
}

const PAIRS = [
  ['Berlin', [52.5170, 13.3830], [52.5205, 13.3990]],
  ['München', [48.1372, 11.5755], [48.1400, 11.5900]],
  ['Hamburg', [53.5503, 9.9920], [53.5530, 10.0080]],
  ['Köln', [50.9413, 6.9583], [50.9440, 6.9700]],
  ['rural', [48.7100, 11.2200], [48.7150, 11.2350]],
];
for (const [name, from, to] of PAIRS) {
  const c = await runPair(name, from, to, 100); // pure-shade preference
  const r = c.state.route;
  ok(r && r.coords && r.coords.length > 1, `${name}: route has a real polyline (${r ? r.coords.length : 0} pts)`);
  ok(r.maneuvers && r.maneuvers.length >= 2 && r.maneuvers[0].type === 'depart' && r.maneuvers[r.maneuvers.length - 1].type === 'arrive',
    `${name}: maneuvers bookended depart…arrive (${r.maneuvers.length})`);
  ok(r.cum && r.cum.length === r.coords.length && r._total > 0, `${name}: cumulative distances + total (${Math.round(r._total)} m)`);
  ok(r.shadeFrac >= 0 && r.shadeFrac <= 1, `${name}: real shade fraction in [0,1]: ${(r.shadeFrac * 100).toFixed(0)}%`);
  ok(Array.isArray(r.segShaded) && r.segShaded.length === r.coords.length - 1 && r.segShaded.every(x => typeof x === 'boolean'),
    `${name}: per-segment shade precomputed (${r.segShaded ? r.segShaded.length : 0})`);
  ok(Array.isArray(c._bldgNear) && c._bldgNear.length > 0, `${name}: near-route OSM buildings collected (${c._bldgNear ? c._bldgNear.length : 0})`);
  ok(r.shadeFrac > 0.5, `${name}: building-lined route is mostly shaded -> ${(r.shadeFrac * 100).toFixed(0)}%`);
  // heading points roughly along the first segment
  ok(c.state.heading >= 0 && c.state.heading <= 360, `${name}: initial heading valid (${Math.round(c.state.heading)}°)`);
}

// weighting: pure shade picks the shady detour; pure time picks the shorter direct route
{
  const from = [52.5170, 13.3830], to = [52.5205, 13.3990];
  const cShade = await runPair('weight', from, to, 100);
  const cTime = await runPair('weight', from, to, 0);
  ok(cShade.state.route._total > cTime.state.route._total,
    `weighting: shade-priority route is longer than time-priority route (${Math.round(cShade.state.route._total)} m vs ${Math.round(cTime.state.route._total)} m)`);
  ok(cShade.state.route.shadeFrac > cTime.state.route.shadeFrac,
    `weighting: shade-priority route is shadier (${(cShade.state.route.shadeFrac * 100).toFixed(0)}% vs ${(cTime.state.route.shadeFrac * 100).toFixed(0)}%)`);
}

// graceful: Overpass returns nothing -> route still valid, just no shade overlay
{
  const from = [52.5170, 13.3830], to = [52.5205, 13.3990];
  installMocks(); SE.fetchBuildingsTrees = async () => ({ buildings: [], trees: [] });
  const c = new Component({}); c.state.from = from; c.state.to = to; c.state.hour = 13; c.state.weight = 70;
  await c.loadRoute(); if (c._refineP) await c._refineP;
  ok(c.state.route && c.state.route.coords.length > 1, 'no-OSM-data: route still loads');
  ok(c.state.route.shadeFrac >= 0 && c.state.route.shadeFrac <= 1, 'no-OSM-data: shade fraction still in [0,1]');
}

// graceful: engine.js missing entirely -> falls back, no crash
{
  const from = [52.5170, 13.3830], to = [52.5205, 13.3990];
  installMocks();
  const savedSE = window.ShadeEngine; window.ShadeEngine = undefined;
  const c = new Component({}); c.state.from = from; c.state.to = to; c.state.hour = 13; c.state.weight = 70;
  await c.loadRoute(); if (c._refineP) await c._refineP;
  window.ShadeEngine = savedSE;
  ok(c.state.route && c.state.route.coords.length > 1, 'no-engine: route still loads (fallback)');
  ok(c.state.route.segShaded === null && c.state.route.shadeFrac >= 0 && c.state.route.shadeFrac <= 1,
    'no-engine: graceful fallback (no per-segment overlay, shade in [0,1])');
}

// no fake-Karlsruhe coupling: the deployed Navigator must not call NC.shadeAt in its
// shade path any more (it used distance-from-Karlsruhe). Allowed only as offline fallback.
{
  const navSrc = html;
  const usesRealField = navSrc.includes('this._field.shadeAtLatLng') && navSrc.includes('shadeFractionOfRoute') && navSrc.includes('ShadeEngine');
  ok(usesRealField, 'Navigator uses the real engine field (shadeAtLatLng / shadeFractionOfRoute)');
  const fakeBoxes = navSrc.includes('NC.hash(mid[0]*4') || navSrc.includes('let nextB=18');
  ok(!fakeBoxes, 'Navigator no longer draws fake hash-generated building boxes');
}

/* =========================================================================
   Part B2 — the exact UI render path (renderVals) for an arbitrary route.
   ========================================================================= */
console.log('\n• Part B2 — renderVals() UI output (arbitrary route, no DOM)');
{
  const from = [52.5170, 13.3830], to = [52.5205, 13.4000];
  installMocks();
  const c = new Component({});
  c.state.from = from; c.state.to = to; c.state.hour = 15; c.state.weight = 70;
  c.state.fromName = 'Brandenburger Tor'; c.state.toName = 'Museumsinsel';
  await c.loadRoute(); if (c._refineP) await c._refineP;
  const v = c.renderVals();
  ok(v && typeof v.banner.title === 'string' && v.banner.title.length > 0, `renderVals: banner title set ("${v.banner.title}")`);
  ok(v.shadePct === Math.round(c.state.route.shadeFrac * 100) && v.shadePct >= 0 && v.shadePct <= 100, `renderVals: shadePct matches route (${v.shadePct}%)`);
  ok(typeof v.remainText === 'string' && /m|km/.test(v.remainText), `renderVals: remaining distance formatted ("${v.remainText}")`);
  ok(v.navBtnLabel === 'Live-Navigation starten', 'renderVals: idle primary button is live-nav');
  ok(v.statusLine.includes('Brandenburger Tor') && v.statusLine.includes('Museumsinsel') && v.statusLine.includes('Bereit für GPS-Navigation'),
    `renderVals: idle status names the real start/end ("${v.statusLine}")`);
  ok(!/—|–/.test(v.statusLine), 'renderVals: status line has no em/en dashes');
  ok(v.shadeAheadLabel === 'Schatten voraus' || v.shadeAheadLabel === 'Sonniger Abschnitt', `renderVals: shade-ahead hint ("${v.shadeAheadLabel}")`);
  ok(v.progressW === 0, 'renderVals: progress starts at 0%');

  // error state → fat red status (the user-requested styling)
  c.state.gps = 'error'; c.state.mode = 'sim';
  const ve = c.renderVals();
  ok(/font-weight:800/.test(ve.statusStyle) && /#ff3b30/.test(ve.statusStyle), 'renderVals: error status is fat red');
  ok(ve.statusLine.includes('nicht verfügbar') && !/—|–/.test(ve.statusLine), `renderVals: error text correct, no dashes ("${ve.statusLine}")`);

  // live state → fused status mentions GPS + Kompass + Schritte
  c.state.gps = 'on'; c.state.mode = 'gps'; c._accuracy = 8; c.state._off = 5;
  const vl = c.renderVals();
  ok(/fusioniert|GPS \+ Kompass/.test(vl.statusLine), `renderVals: live status shows sensor fusion ("${vl.statusLine}")`);
  ok(vl.navBtnLabel.includes('Beenden'), 'renderVals: live primary button offers to end');
}

/* =========================================================================
   Part E — live GPS: the dot is the REAL position + off-route auto-reroute.
   ========================================================================= */
console.log('\n• Part E — real GPS dot + off-route auto-reroute');
{
  const NF = window.NavFusion, NC = window.NavCore;
  const from = [52.5170, 13.3830], to = [52.5205, 13.4000];
  const c = await runPair('reroute', from, to, 70);
  const rt0 = c.state.route;
  const ekfAt = (lat, lng) => { const e = new NF.EKF(lat, lng); e.updateGps(lat, lng, 6); e.updateGps(lat, lng, 6); return e; };

  // start ~165 m south of the route start — clearly NOT on the planned route
  const offLat = from[0] - 0.0015, offLng = from[1];
  c._ekf = ekfAt(offLat, offLng);
  c.state.mode = 'gps'; c.state.gps = 'on'; c.state.arrived = false; c._accuracy = 8;
  let now = 1000; c._now = () => now;
  c._lastPredict = now; c._lastStep = now; c._offSince = 0; c._lastReroute = 0; c._rerouteP = null;

  c.fuseTick();
  const dDot = NC.hav(c.state.userPt, [offLat, offLng]);
  ok(dDot < 3, `dot shows the REAL fused position, not snapped to the line (${dDot.toFixed(1)} m from truth)`);
  const projOff = NC.projectOnPath([offLat, offLng], rt0.coords, rt0.cum).off;
  ok(c.state._off > 100 && Math.abs(c.state._off - projOff) < 1, `off-route distance reported (${Math.round(c.state._off)} m)`);
  ok(c._rerouteP, 'reroute fires INSTANTLY on the first fix >20 m off-route (no debounce)');
  ok(c.state.rerouting === true && c._rerouting === true, 'recalculating flag set immediately (loading indicator shows)');
  await c._rerouteP; if (c._refineP) await c._refineP;
  const dStart = NC.hav(c.state.route.coords[0], [offLat, offLng]);
  ok(dStart < 8, `rerouted path now STARTS at the live position (${dStart.toFixed(1)} m)`);
  ok(c.state.progress === 0 && c.state.arrived === false, 'progress reset after reroute');
  ok(c.state.rerouting === false && c._rerouting === false, 'rerouting flags cleared when done');
  ok(c.state.route._total > 0 && Array.isArray(c.state.route.segShaded) && c.state.route.maneuvers.length >= 2,
    'new route fully rebuilt (shade + maneuvers)');

  // now walk along the new route -> no further reroute, dot keeps tracking
  const onPt = c.state.route.coords[3];
  c._ekf = ekfAt(onPt[0], onPt[1]);
  now = 20000; c._lastPredict = now; c._lastStep = now; c._offSince = 0; c._rerouteP = null;
  c.fuseTick();
  ok(c.state._off < 35, `back on the route (off ${Math.round(c.state._off)} m)`);
  now = 26000; c.fuseTick();
  ok(!c._rerouteP, 'no reroute while on route');
  ok(NC.hav(c.state.userPt, onPt) < 3, 'dot still tracks the real position while on route');

  // the deployed file actually draws the dot every paint + has the reroute machinery
  ok(html.includes('userPt') && html.includes("r:8,fill:ringCol") && html.includes("r:11,fill:'#fff'"),
    'paintOverlay draws a bold, high-contrast user dot');
  ok(html.includes('maybeReroute') && html.includes('async reroute('), 'Navigator has off-route reroute logic');
}

/* =========================================================================
   Part F — ShadeWalk "use my location" as the start point.
   ========================================================================= */
console.log('\n• Part F — ShadeWalk "use my location"');
{
  const swHtml = read('../ShadeWalk.dc.html');
  const a1 = swHtml.indexOf('class Component extends DCLogic');
  const b1 = swHtml.indexOf('</script>', a1);
  const SWComponent = (0, eval)('(function(){' + swHtml.slice(a1, b1) + '\n; return Component;})()');

  const fix = { coords: { latitude: 48.7758, longitude: 9.1829 } }; // Stuttgart
  globalThis.navigator = { geolocation: { getCurrentPosition: (ok) => ok(fix) }, permissions: { query: async () => ({ state: 'denied' }) } };
  window.navigator = globalThis.navigator;

  const sw = new SWComponent({});
  sw.state.lang = 'de';
  sw.useMyLocation('from');
  ok(sw.state.from && Math.abs(sw.state.from.lat - 48.7758) < 1e-6 && Math.abs(sw.state.from.lng - 9.1829) < 1e-6,
    'start set to the live GPS position');
  ok(sw.state.from.name === 'Mein Standort' && sw.state.fromText === 'Mein Standort', 'start labelled "Mein Standort" (de)');

  sw.state.lang = 'en';
  sw.useMyLocation('to');
  ok(sw.state.to && sw.state.to.name === 'My location' && sw.state.toText === 'My location', 'destination variant labelled "My location" (en)');

  const sw2 = new SWComponent({});
  sw2.state.lang = 'de'; sw2.state.fromText = 'Schloss';
  globalThis.navigator.geolocation.getCurrentPosition = (ok, err) => err({ code: 1, message: 'denied' });
  sw2.useMyLocation('from');
  ok(sw2.state.fromText === 'Schloss', 'denied/failed GPS restores the previous start text');

  ok(swHtml.includes('name:t.myLoc,pick:this.useMyLocFrom') && swHtml.includes("myLoc:'📍 Mein Standort'"),
    'a "my location" entry sits atop the start suggestions');
}

/* =========================================================================
   Part C — best-effort live test (real OSRM + Overpass). Skipped on failure.
   ========================================================================= */
console.log('\n• Part C — live OSRM + Overpass (best effort)');
// restore the real network functions
delete NC.fetchRoutes; delete SE.fetchBuildingsTrees;
(0, eval)(read('../nav-core.js')); (0, eval)(read('../engine.js'));
const LIVE = [['Berlin', [52.5170, 13.3830], [52.5205, 13.4000]], ['München', [48.1372, 11.5755], [48.1450, 11.5600]]];
let liveOK = 0;
for (const [name, from, to] of LIVE) {
  try {
    const c = new Component({}); c.state.from = from; c.state.to = to; c.state.hour = 15; c.state.weight = 70;
    await Promise.race([
      (async () => { await c.loadRoute(); if (c._refineP) await c._refineP; })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
    ]);
    const r = c.state.route;
    if (r && r.coords.length > 1 && r._total > 0 && r.shadeFrac >= 0 && r.shadeFrac <= 1) {
      liveOK++;
      console.log(`  ✓ LIVE ${name}: ${Math.round(r._total)} m, ${(r.shadeFrac * 100).toFixed(0)}% shade, ${c._bldgNear ? c._bldgNear.length : 0} buildings`);
    } else {
      console.log(`  ~ LIVE ${name}: loaded but unexpected shape (non-fatal)`);
    }
  } catch (e) {
    console.log(`  ~ LIVE ${name}: skipped (${e.message})`);
  }
}
console.log(`  live routes verified: ${liveOK}/${LIVE.length} (network-dependent, not counted as failures)`);

/* ------------------------------- summary ------------------------------- */
console.log('\n' + (failed === 0 ? `✓ NAVIGATOR TESTS PASSED (${passed} checks)` : `✗ ${failed} FAILED (${passed} passed)`));
process.exit(failed === 0 ? 0 : 1);
