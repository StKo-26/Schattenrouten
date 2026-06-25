// Node test harness for the pure routing/shadow algorithms. Run: npm test
import { sunPosition } from '../js/solar.js';
import {
  haversine, makeProjector, pointInPolygon, pointInDisk, convexHull, samplePolyline,
} from '../js/geometry.js';
import { buildGraph, nearestNode, isWalkable, assembleRings } from '../js/graph.js';
import { dijkstra, alternativeRoutes } from '../js/dijkstra.js';
import {
  buildingHeight, treeProps, buildShadowField, edgeShadowFraction,
} from '../js/shadow.js';
import { computeRoutes } from '../js/routing.js';

let passed = 0, failed = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + msg); }
}
function section(name, fn) {
  console.log('• ' + name);
  fn();
}

// ---------------------------------------------------------------- solar
section('solar position', () => {
  const KA = { lat: 49.0069, lon: 8.4037 };
  // 2026-06-25 12:00 UTC = 14:00 local (CEST): sun high, in the south-west.
  const noonish = sunPosition(new Date('2026-06-25T12:00:00Z'), KA.lat, KA.lon);
  ok(noonish.elevationDeg > 45, 'midday June elevation > 45 (got ' + noonish.elevationDeg.toFixed(1) + ')');
  ok(noonish.azimuthDeg > 180 && noonish.azimuthDeg < 270, 'early afternoon azimuth SW (got ' + noonish.azimuthDeg.toFixed(1) + ')');
  // Night: 00:00 UTC (02:00 local) → below horizon.
  const night = sunPosition(new Date('2026-06-25T00:00:00Z'), KA.lat, KA.lon);
  ok(night.elevationDeg < 0, 'night elevation below horizon (got ' + night.elevationDeg.toFixed(1) + ')');
  // Morning sun is in the east.
  const morning = sunPosition(new Date('2026-06-25T05:00:00Z'), KA.lat, KA.lon);
  ok(morning.azimuthDeg > 45 && morning.azimuthDeg < 110, 'morning azimuth in the east (got ' + morning.azimuthDeg.toFixed(1) + ')');
});

// ---------------------------------------------------------------- geometry
section('geometry', () => {
  const proj = makeProjector(49, 8);
  const m = proj.project(49.001, 8.001);
  const back = proj.unproject(m.x, m.y);
  ok(approx(back.lat, 49.001, 1e-9) && approx(back.lon, 8.001, 1e-9), 'projector roundtrip');

  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  ok(pointInPolygon({ x: 5, y: 5 }, square), 'point inside square');
  ok(!pointInPolygon({ x: 15, y: 5 }, square), 'point outside square');

  const hull = convexHull(square.concat([{ x: 5, y: 5 }]));
  ok(hull.length === 4, 'convex hull drops interior point (got ' + hull.length + ')');

  ok(pointInDisk({ x: 1, y: 1 }, { x: 0, y: 0 }, 2), 'point in disk');
  ok(!pointInDisk({ x: 3, y: 0 }, { x: 0, y: 0 }, 2), 'point outside disk');

  const samp = samplePolyline([{ x: 0, y: 0 }, { x: 16, y: 0 }], 8);
  ok(samp.length === 3, 'samplePolyline spacing (got ' + samp.length + ')');

  const d = haversine({ lat: 49, lon: 8 }, { lat: 49.001, lon: 8 });
  ok(Math.abs(d - 111.3) < 1, 'haversine ~111m per 0.001 deg lat (got ' + d.toFixed(1) + ')');
});

// ---------------------------------------------------------------- graph
section('graph building', () => {
  const elements = [
    { type: 'node', id: 1, lat: 49.000, lon: 8.000 },
    { type: 'node', id: 2, lat: 49.000, lon: 8.001 },
    { type: 'node', id: 3, lat: 49.001, lon: 8.001 },
    { type: 'node', id: 10, lat: 49.0005, lon: 8.0005, tags: { natural: 'tree' } },
    { type: 'node', id: 20, lat: 49.0002, lon: 8.0002 },
    { type: 'node', id: 21, lat: 49.0002, lon: 8.0004 },
    { type: 'node', id: 22, lat: 49.0004, lon: 8.0004 },
    { type: 'way', id: 100, nodes: [1, 2, 3], tags: { highway: 'footway' } },
    { type: 'way', id: 200, nodes: [20, 21, 22, 20], tags: { building: 'yes' } },
    { type: 'way', id: 300, nodes: [1, 2], tags: { highway: 'motorway' } },
  ];
  const g = buildGraph(elements);
  ok(g.edges.length === 2, 'footway split into 2 edges (got ' + g.edges.length + ')');
  ok(g.buildings.length === 1, 'one building parsed');
  ok(g.trees.length === 1, 'one tree parsed');
  ok(g.nodes.has(1) && g.nodes.has(3), 'walkable nodes registered');
  ok(!isWalkable({ highway: 'motorway' }), 'motorway not walkable');
  ok(isWalkable({ highway: 'footway' }), 'footway walkable');
  const nn = nearestNode(g, 49.0009, 8.001);
  ok(nn.id === 3, 'nearestNode finds node 3 (got ' + nn.id + ')');
});

section('multipolygon ring assembly', () => {
  // Two open segments that share endpoints should close into one ring.
  const rings = assembleRings([[1, 2, 3], [3, 4, 1]]);
  ok(rings.length === 1, 'two segments → one ring (got ' + rings.length + ')');
  ok(rings[0][0] === rings[0][rings[0].length - 1], 'ring is closed');

  // A building modelled as a relation with two outer ways becomes a footprint.
  const elements = [
    { type: 'node', id: 1, lat: 49.000, lon: 8.000 },
    { type: 'node', id: 2, lat: 49.000, lon: 8.001 },
    { type: 'node', id: 3, lat: 49.001, lon: 8.001 },
    { type: 'node', id: 4, lat: 49.001, lon: 8.000 },
    { type: 'way', id: 50, nodes: [1, 2, 3] },
    { type: 'way', id: 51, nodes: [3, 4, 1] },
    {
      type: 'relation', id: 9, tags: { building: 'yes', type: 'multipolygon' },
      members: [
        { type: 'way', ref: 50, role: 'outer' },
        { type: 'way', ref: 51, role: 'outer' },
      ],
    },
  ];
  const g = buildGraph(elements);
  ok(g.buildings.length === 1, 'relation building footprint reconstructed (got ' + g.buildings.length + ')');
  ok(g.buildings[0].ring.length >= 4, 'reconstructed ring has the corners');
});

// ---------------------------------------------------------------- dijkstra
section('dijkstra + alternatives', () => {
  // Diamond graph: A-B-D (cost 2) vs A-C-D (cost 10).
  const graph = makeTestGraph(
    { A: [0, 0], B: [1, 1], C: [-1, 1], D: [0, 2] },
    [['A', 'B', 1], ['B', 'D', 1], ['A', 'C', 5], ['C', 'D', 5]]
  );
  const id = graph.nameToId;
  const r = dijkstra(graph, id.A, id.D, (ref) => graph.edges[ref.edgeId].length);
  ok(approx(r.cost, 2), 'shortest cost 2 (got ' + r.cost + ')');
  ok(r.path.length === 3 && r.path[1] === id.B, 'shortest goes via B');

  const alts = alternativeRoutes(graph, id.A, id.D, (ref) => graph.edges[ref.edgeId].length, 2);
  ok(alts.length === 2, 'found 2 distinct routes (got ' + alts.length + ')');
});

// ---------------------------------------------------------------- shadow
section('shadow model', () => {
  ok(buildingHeight({ height: '15' }) === 15, 'height tag parsed');
  ok(buildingHeight({ 'building:levels': '4' }) > 12, 'levels → height');
  ok(buildingHeight({}) === 9, 'default building height');

  const summer = treeProps({ leaf_type: 'broadleaved' }, 6).density;
  const winter = treeProps({ leaf_type: 'broadleaved' }, 1).density;
  ok(summer > winter, 'deciduous denser in summer (' + summer.toFixed(2) + ' > ' + winter.toFixed(2) + ')');
  ok(treeProps({ leaf_type: 'needleleaved' }, 1).density > 0.5, 'conifer stays dense in winter');

  // Building south of a corridor; sun due south at 45° → shadow cast north.
  const proj = makeProjector(49, 8);
  const ring = [[-10, 10], [110, 10], [110, 20], [-10, 20]].map(([x, y]) => proj.unproject(x, y));
  const buildings = [{ id: 1, ring, tags: { building: 'yes', height: '30' } }];
  const sun = { elevationDeg: 45, azimuthDeg: 180, altitudeRad: 45 * Math.PI / 180 };
  const field = buildShadowField(buildings, [], sun, 49, 8, 6);
  ok(field.valid, 'sun above horizon → field valid');
  ok(approx(field.shadowUnit.x, 0, 1e-9) && field.shadowUnit.y > 0.99, 'south sun casts shadow north');

  const northEdge = [proj.unproject(0, 30), proj.unproject(100, 30)];
  const southEdge = [proj.unproject(0, -5), proj.unproject(100, -5)];
  ok(edgeShadowFraction(northEdge, field) > 0.9, 'edge north of building is shaded');
  ok(edgeShadowFraction(southEdge, field) < 0.05, 'edge toward the sun is sunny');
});

// ---------------------------------------------------------------- routing
section('shade-aware routing', () => {
  const proj = makeProjector(49, 8);
  const P = (x, y) => proj.unproject(x, y);
  // Direct sunny route S-M-G (~100m) vs shaded detour S-A-B-G (~160m).
  const nodes = {
    S: [0, 0], G: [100, 0], M: [50, 0], A: [0, 30], B: [100, 30],
  };
  const graph = makeTestGraph(nodes, [
    ['S', 'M', 50], ['M', 'G', 50],
    ['S', 'A', 30], ['A', 'B', 100], ['B', 'G', 30],
  ], P);
  const id = graph.nameToId;

  const ring = [[-10, 10], [110, 10], [110, 20], [-10, 20]].map(([x, y]) => P(x, y));
  const buildings = [{ id: 1, ring, tags: { building: 'yes', height: '30' } }];
  const sun = { elevationDeg: 45, azimuthDeg: 180, altitudeRad: 45 * Math.PI / 180 };
  const field = buildShadowField(buildings, [], sun, 49, 8, 6);

  const sunny = computeRoutes(graph, field, id.S, id.G, { shadowWeight: 0 });
  ok(sunny.recommended.label === 'Shortest' || sunny.recommended.distance < 120,
    'weight 0 → recommends the short route (got ' + sunny.recommended.distance.toFixed(0) + 'm)');

  const shady = computeRoutes(graph, field, id.S, id.G, { shadowWeight: 1 });
  ok(shady.recommended.distance > 140, 'weight 1 → takes the longer shaded detour (got ' + shady.recommended.distance.toFixed(0) + 'm)');
  ok(shady.recommended.avgShadow > sunny.recommended.avgShadow, 'shaded route has more shadow');
  ok(shady.shortest.distance < shady.shadiest.distance, 'shortest is shorter than shadiest');
});

// ---------------------------------------------------------------- helpers
function makeTestGraph(nodeDef, edgeDef, P) {
  const nameToId = {};
  const nodes = new Map();
  const adjacency = new Map();
  const edges = [];
  let nextId = 1;
  for (const name of Object.keys(nodeDef)) {
    const id = nextId++;
    nameToId[name] = id;
    const [x, y] = nodeDef[name];
    nodes.set(id, P ? P(x, y) : { lat: 49 + y * 1e-4, lon: 8 + x * 1e-4 });
  }
  let eid = 0;
  for (const [a, b, len] of edgeDef) {
    const ia = nameToId[a], ib = nameToId[b];
    const id = eid++;
    edges.push({ id, a: ia, b: ib, length: len, tags: {}, isSteps: false });
    if (!adjacency.has(ia)) adjacency.set(ia, []);
    if (!adjacency.has(ib)) adjacency.set(ib, []);
    adjacency.get(ia).push({ to: ib, length: len, edgeId: id });
    adjacency.get(ib).push({ to: ia, length: len, edgeId: id });
  }
  return { nodes, adjacency, edges, nameToId, buildings: [], trees: [] };
}

// ---------------------------------------------------------------- report
console.log('\n' + (failed === 0 ? '✓ ALL PASSED' : '✗ FAILURES') + `  (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
