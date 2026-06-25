// Tests the browser-global engine.js in Node (it attaches to globalThis).
import '../engine.js';
const E = globalThis.ShadeEngine;

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.error('  ✗ FAIL: ' + m); } };

// meters → lat/lon around an origin
const O = { lat: 49, lon: 8 };
const mLat = 111320, mLon = 111320 * Math.cos(O.lat * Math.PI / 180);
const P = (x, y) => [O.lat + y / mLat, O.lon + x / mLon];          // [lat,lng]
const Pr = (x, y) => ({ lat: O.lat + y / mLat, lon: O.lon + x / mLon }); // {lat,lon}

console.log('• engine: sun position');
{
  const noon = E.sunPosition(new Date('2026-06-25T12:00:00Z'), 49.0069, 8.4037);
  ok(noon.elevationDeg > 45, 'midday elevation > 45 (' + noon.elevationDeg.toFixed(1) + ')');
  ok(noon.azimuthDeg > 180 && noon.azimuthDeg < 270, 'afternoon azimuth SW (' + noon.azimuthDeg.toFixed(1) + ')');
  const night = E.sunPosition(new Date('2026-06-25T00:00:00Z'), 49.0069, 8.4037);
  ok(night.elevationDeg < 0, 'night below horizon');
}

console.log('• engine: real shadow projection');
{
  // Building south of a corridor; sun due south @45° → shadow cast north.
  const ring = [[-10, 10], [110, 10], [110, 20], [-10, 20]].map(([x, y]) => Pr(x, y));
  const buildings = [{ ring, h: 30, tags: {} }];
  const sun = { elevationDeg: 45, azimuthDeg: 180, altitudeRad: 45 * Math.PI / 180 };
  const field = E.buildField(buildings, [], sun, O.lat, O.lon, 6);
  ok(field.valid, 'field valid (sun up)');
  const north = [P(0, 30), P(100, 30)];
  const south = [P(0, -5), P(100, -5)];
  ok(field.shadeFractionOfRoute(north) > 0.9, 'route north of building is shaded (' + field.shadeFractionOfRoute(north).toFixed(2) + ')');
  ok(field.shadeFractionOfRoute(south) < 0.05, 'route toward the sun is sunny (' + field.shadeFractionOfRoute(south).toFixed(2) + ')');
  ok(field.buildingsLatLng.length === 1 && field.buildingsLatLng[0].shadow, 'building + cast shadow exposed for drawing');
}

console.log('• engine: live Karlsruhe buildings/trees');
const bbox = [49.006, 8.398, 49.016, 8.410]; // Marktplatz → Schloss-ish
E.fetchBuildingsTrees(bbox, { month: 6, onStatus: (u) => console.log('  … ' + u.replace(/^https?:\/\//, '').split('/')[0]) })
  .then((data) => {
    console.log(`  fetched ${data.buildings.length} buildings, ${data.trees.length} trees`);
    ok(data.buildings.length > 20, 'real buildings parsed');
    ok(data.buildings.every((b) => b.h > 0), 'every building has a height');
    const sun = E.sunPosition(new Date('2026-06-25T12:00:00Z'), 49.011, 8.404);
    const field = E.buildField(data.buildings, data.trees, sun, 49.011, 8.404, 6);
    const line = [[49.009, 8.404], [49.013, 8.404]];
    const frac = field.shadeFractionOfRoute(line);
    console.log(`  shade fraction of a test line: ${(frac * 100).toFixed(0)}%`);
    ok(frac >= 0 && frac <= 1, 'shade fraction in [0,1]');
    ok(field.buildingsLatLng.length === data.buildings.length, 'all buildings drawable');
    done();
  })
  .catch((err) => { console.error('  ⚠ live fetch skipped: ' + err.message); done(); });

function done() {
  console.log('\n' + (failed === 0 ? '✓ ENGINE TESTS PASSED' : `✗ ${failed} FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}
