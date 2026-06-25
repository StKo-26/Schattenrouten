// Evaluates the REAL ShadeWalk Component class (extracted from the .dc.html) the
// same way the DC runtime does, and exercises the results-view math against live
// Karlsruhe OSM data with a Leaflet stub. Verifies the integration glue.
import fs from 'node:fs';
import '../engine.js'; // sets globalThis.ShadeEngine

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.error('  ✗ FAIL: ' + m); } };

// ---- window + Leaflet stub ----
global.window = globalThis;
const node = () => { const o = {}; o.addTo = () => o; o.bindTooltip = () => o; o.setStyle = () => o; o.bringToFront = () => o; return o; };
const layer = () => ({ addTo: () => layer(), clearLayers() {} });
window.L = {
  polyline: node, polygon: node, circle: node, circleMarker: node,
  layerGroup: () => layer(),
  latLngBounds: () => ({ pad: () => ({}) }),
};

// ---- extract + eval the Component class exactly like support.js does ----
const src = fs.readFileSync(new URL('../ShadeWalk.dc.html', import.meta.url), 'utf8');
const start = src.indexOf('class Component extends DCLogic');
const end = src.indexOf('</script>', start);
const clsSrc = src.slice(start, end);
const DCLogic = class {
  constructor(p) { this.props = p || {}; this.state = {}; }
  setState(u, cb) { const patch = typeof u === 'function' ? u(this.state) : u; this.state = { ...this.state, ...patch }; if (cb) cb(); }
  forceUpdate() {}
};
const React = { createElement() {} };
const Component = new Function('DCLogic', 'StreamableLogic', 'React', clsSrc + '\n;return Component;')(DCLogic, DCLogic, React);

(async () => {
  console.log('• ShadeWalk Component — results math on live OSM data');
  const c = new Component({});
  ok(c && c.state && c.state.view === 'home', 'Component constructs');

  const from = c.POIS[0], to = c.POIS[1]; // Hauptbahnhof → Schloss
  const routes = c.synth(from, to).map((r, i) => ({ id: i, coords: r.coords, dist: r.dist, stairsPenalty: i === 2 ? 0.8 : 0.4 }));
  c.state.from = from; c.state.to = to; c.state.routes = routes;
  ok(routes.length === 3, 'candidate routes prepared');

  await c.loadOsm(routes); // real Overpass fetch for the corridor
  ok(c._osm && c._osm.buildings, 'OSM corridor loaded');
  console.log(`  corridor: ${c._osm.buildings.length} buildings, ${c._osm.trees.length} trees`);

  const field = c.getField();
  ok(field && field.valid !== undefined, 'shadow field built from real data');

  const en = c.enrich();
  ok(en.length === 3, 'all routes enriched');
  ok(en.every((e) => e.shadeFrac >= 0 && e.shadeFrac <= 1), 'shade fractions in [0,1]');
  ok(en.every((e) => e.timeMin > 0 && e.distKm > 0), 'time + distance positive');
  console.log('  shade by route: ' + en.map((e) => Math.round(e.shadeFrac * 100) + '%').join(', '));

  // Ranking responds to the slider.
  c.state.shadeWeight = 0; const fastFirst = c.ranked()[0];
  c.state.shadeWeight = 100; const shadeFirst = c.ranked()[0];
  ok(shadeFirst.shadeFrac >= fastFirst.shadeFrac - 1e-9, 'shadiest-priority picks an at-least-as-shaded route');
  ok(c.selectedId() != null, 'a route is selected');

  // Field rebuilds when the hour changes (sun moves).
  c.state.hour = 9; const f9 = c.getField();
  c.state.hour = 18; const f18 = c.getField();
  ok(f9 !== f18, 'field recomputed when hour changes');

  // redraw must not throw against the Leaflet stub (exercises _nearRoute + drawing).
  c._map = { fitBounds() {} };
  c._routeLayer = layer(); c._shadowLayer = layer(); c._bldgLayer = layer();
  c._enriched = c.ranked();
  let threw = null; try { c.redraw(); } catch (e) { threw = e; }
  ok(!threw, 'redraw() runs without error' + (threw ? ' — ' + threw.message : ''));

  console.log('\n' + (failed === 0 ? '✓ COMPONENT TESTS PASSED' : `✗ ${failed} FAILED`));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
