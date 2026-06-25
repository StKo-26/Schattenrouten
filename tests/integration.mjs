// Live end-to-end test against real OpenStreetMap data for Karlsruhe.
// Requires network access (Overpass + Node 20 global fetch). Run: node tests/integration.mjs
import { fetchOsm, bboxAreaKm2 } from '../js/overpass.js';
import { buildGraph, nearestNode } from '../js/graph.js';
import { sunPosition } from '../js/solar.js';
import { buildShadowField } from '../js/shadow.js';
import { computeRoutes } from '../js/routing.js';

const START = { lat: 49.0094, lon: 8.4044, name: 'Marktplatz' };
const END = { lat: 49.0136, lon: 8.4044, name: 'Schloss' };

function bboxFor(a, b) {
  const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
  const w = Math.min(a.lon, b.lon), e = Math.max(a.lon, b.lon);
  const padLat = Math.max((n - s) * 0.35, 0.0045);
  const padLon = Math.max((e - w) * 0.35, 0.0065);
  return [s - padLat, w - padLon, n + padLat, e + padLon];
}

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.error('  ✗ FAIL: ' + m); } };

(async () => {
  const bbox = bboxFor(START, END);
  console.log(`Karlsruhe ${START.name} → ${END.name}  (bbox ≈ ${bboxAreaKm2(bbox).toFixed(2)} km²)`);
  let elements;
  try {
    elements = await fetchOsm(bbox, { onStatus: (s) => console.log('  … ' + s) });
  } catch (err) {
    console.error('  ⚠ SKIP — could not reach Overpass: ' + err.message);
    process.exit(0); // network-dependent; don't fail CI offline
  }

  const graph = buildGraph(elements);
  console.log(`  network: ${graph.edges.length} edges, ${graph.nodes.size} nodes, ` +
    `${graph.buildings.length} buildings, ${graph.trees.length} trees`);
  ok(graph.edges.length > 100, 'substantial walking network parsed');
  ok(graph.buildings.length > 20, 'buildings parsed for shading');

  const snapS = nearestNode(graph, START.lat, START.lon);
  const snapE = nearestNode(graph, END.lat, END.lon);
  ok(snapS.distance < 80 && snapE.distance < 80, `endpoints snap close (${snapS.distance.toFixed(0)}m / ${snapE.distance.toFixed(0)}m)`);

  const date = new Date('2026-06-25T14:00:00'); // local 2pm-ish (treated as host local)
  const sun = sunPosition(new Date('2026-06-25T12:00:00Z'), START.lat, START.lon);
  console.log(`  sun: ${sun.elevationDeg.toFixed(0)}° elev, azimuth ${sun.azimuthDeg.toFixed(0)}°`);
  const field = buildShadowField(graph.buildings, graph.trees, sun, START.lat, START.lon, 6);
  ok(field.valid, 'sun above horizon → shadow field valid');

  const fast = computeRoutes(graph, field, snapS.id, snapE.id, { shadowWeight: 0 });
  const shady = computeRoutes(graph, field, snapS.id, snapE.id, { shadowWeight: 1 });
  ok(fast && shady, 'routes computed for both extremes');

  const r0 = fast.recommended, r1 = shady.recommended;
  console.log(`  fastest : ${(r0.distance).toFixed(0)}m, ${(r0.timeSec/60).toFixed(1)}min, ${(r0.avgShadow*100).toFixed(0)}% shade`);
  console.log(`  shadiest: ${(r1.distance).toFixed(0)}m, ${(r1.timeSec/60).toFixed(1)}min, ${(r1.avgShadow*100).toFixed(0)}% shade`);
  ok(r0.distance > 200 && r0.distance < 3000, 'fastest route length plausible (~0.4–1 km)');
  ok(r1.avgShadow >= r0.avgShadow - 1e-9, 'shade-weighted route is at least as shaded as the fastest');
  ok(shady.candidates.length >= 2, `multiple candidates compared (${shady.candidates.length})`);

  console.log('\n' + (failed === 0 ? '✓ INTEGRATION PASSED' : `✗ ${failed} FAILURE(S)`));
  process.exit(failed === 0 ? 0 : 1);
})();
