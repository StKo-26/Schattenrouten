// Full browser test environment for the Navigator: real Chromium under Android
// (Pixel 5) emulation, deterministic OSRM + Overpass network fixtures, spoofed
// GPS (moving track) and spoofed IMU (DeviceOrientation compass + DeviceMotion
// step bounce). Verifies the route + buildings + the user dot actually RENDER and
// that navigation adjusts (off-route reroute), plus the big red no-GPS notice.
//
//   node tests/browser/nav.e2e.mjs
import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';

const TEMP = process.env.TEMP || '.';
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.error('  ✗ FAIL: ' + m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- fixtures: a known route + buildings along it ---------------- */
const FROM = [52.5170, 13.3830], TO = [52.5205, 13.4000];
const D = Math.PI / 180;
function hav(a, b) { const R = 6371000; const dLa = (b[0] - a[0]) * D, dLo = (b[1] - a[1]) * D, la1 = a[0] * D, la2 = b[0] * D; const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function track(from, to, n) { const a = []; for (let i = 0; i <= n; i++) { const t = i / n; a.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]); } return a; }
const ROUTE = track(FROM, TO, 24);
let DIST = 0; for (let i = 1; i < ROUTE.length; i++) DIST += hav(ROUTE[i - 1], ROUTE[i]);

const OSRM = JSON.stringify({
  code: 'Ok',
  routes: [{
    distance: DIST,
    geometry: { coordinates: ROUTE.map(c => [c[1], c[0]]) },
    legs: [{ steps: [
      { distance: DIST * 0.5, name: 'Teststraße', maneuver: { type: 'depart', modifier: '' } },
      { distance: DIST * 0.5, name: 'Zielweg', maneuver: { type: 'turn', modifier: 'left' } },
    ] }],
  }],
});

function overpassFor(routeCoords) {
  let nid = 100000, wid = 500000; const els = [];
  const addBld = (lat, lng) => {
    const d = 9 / 111320, e = 9 / (111320 * Math.cos(lat * D));
    const corners = [[lat - d, lng - e], [lat - d, lng + e], [lat + d, lng + e], [lat + d, lng - e]];
    const ids = corners.map(c => { const id = nid++; els.push({ type: 'node', id, lat: c[0], lon: c[1] }); return id; });
    ids.push(ids[0]);
    els.push({ type: 'way', id: wid++, nodes: ids, tags: { building: 'yes', 'building:levels': '5' } });
  };
  for (let i = 2; i < routeCoords.length - 2; i += 2) addBld(routeCoords[i][0] + 0.00013, routeCoords[i][1]); // ~14 m beside the path
  els.push({ type: 'node', id: nid++, lat: routeCoords[6][0] - 0.0001, lon: routeCoords[6][1], tags: { natural: 'tree' } });
  els.push({ type: 'node', id: nid++, lat: routeCoords[12][0] - 0.0001, lon: routeCoords[12][1], tags: { natural: 'tree' } });
  return JSON.stringify({ elements: els });
}
const OVERPASS = overpassFor(ROUTE);

/* ---------------- harness ---------------- */
async function makeContext(browser, withGeo) {
  const ctx = await browser.newContext({
    ...devices['Pixel 5'],
    locale: 'de-DE',
    ...(withGeo ? { geolocation: { latitude: FROM[0], longitude: FROM[1], accuracy: 8 }, permissions: ['geolocation'] } : {}),
  });
  // deterministic network: intercept OSRM + Overpass; let tiles/leaflet CDN pass.
  // OSRM honours the REQUESTED origin so reroute() really starts from the live spot.
  await ctx.route('**/routed-foot/**', async r => {
    const u = r.request().url();
    const m = u.match(/foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
    let from = FROM, to = TO;
    if (m) { from = [+m[2], +m[1]]; to = [+m[4], +m[3]]; }
    const rt = track(from, to, 20); let dist = 0; for (let i = 1; i < rt.length; i++) dist += hav(rt[i - 1], rt[i]);
    const body = JSON.stringify({ code: 'Ok', routes: [{ distance: dist, geometry: { coordinates: rt.map(c => [c[1], c[0]]) }, legs: [{ steps: [{ distance: dist, name: 'Weg', maneuver: { type: 'depart', modifier: '' } }] }] }] });
    await sleep(450); // realistic routing latency, so the recalculating indicator is observable
    r.fulfill({ contentType: 'application/json', body });
  });
  await ctx.route('**/interpreter**', r => r.fulfill({ contentType: 'application/json', body: OVERPASS }));
  await ctx.route('**/api/interpreter', r => r.fulfill({ contentType: 'application/json', body: OVERPASS }));
  return ctx;
}
const NAV_URL = (base) => `${base}/Navigator.dc.html?from=${FROM[0]},${FROM[1]}&to=${TO[0]},${TO[1]}&fromName=Teststart&toName=Testziel&hour=15&shade=70`;
const nav = (page) => page.evaluate(() => window.__nav || null);
async function waitFor(page, pred, ms = 20000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const n = await nav(page); if (n && pred(n)) return n; await sleep(step); }
  return await nav(page);
}
// spoof one IMU sample set: compass heading (deg) + a vertical step bounce
async function imu(page, headingDeg, t) {
  await page.evaluate(({ h, t }) => {
    const o = new Event('deviceorientationabsolute'); o.absolute = true; o.alpha = (360 - h) % 360; o.beta = 0; o.gamma = 0; window.dispatchEvent(o);
    const o2 = new Event('deviceorientation'); o2.absolute = true; o2.alpha = (360 - h) % 360; window.dispatchEvent(o2);
    const z = 9.81 + 3.0 * Math.sin(2 * Math.PI * 2 * (t / 1000)); // 2 Hz bounce
    const m = new Event('devicemotion'); m.accelerationIncludingGravity = { x: 0, y: 0, z }; m.acceleration = { x: 0, y: 0, z: z - 9.81 }; window.dispatchEvent(m);
  }, { h: headingDeg, t });
}

const srv = await startServer();
const browser = await chromium.launch();
console.log('chromium', browser.version(), '· route', Math.round(DIST), 'm,', ROUTE.length, 'pts');

/* ===================== Scenario 1 — boot: route + buildings render ===================== */
console.log('\n• Scenario 1 — boots and renders the route + OSM buildings (Android emulation)');
{
  const ctx = await makeContext(browser, true);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(NAV_URL(srv.url), { waitUntil: 'load' });

  const booted = await waitFor(page, n => n.routePts > 1, 20000);
  ok(booted && booted.routePts > 1, `route polyline rendered (${booted ? booted.routePts : 0} pts)`);
  const spinner = await page.evaluate(() => !!Array.from(document.querySelectorAll('span')).find(s => /wird gesucht/.test(s.textContent || '')) && getComputedStyle(document.querySelector('[style*="sw-spin"]') || document.body).animationName !== 'none');
  ok(!spinner, 'loading spinner is gone (route shown immediately, not blocked on Overpass)');
  const built = await waitFor(page, n => n.bldgNear > 0, 16000);
  ok(built && built.bldgNear > 0, `real OSM buildings loaded (${built ? built.bldgNear : 0} near route)`);
  ok(built && built.bldgDrawn > 0, `buildings actually drawn on the map (${built ? built.bldgDrawn : 0} in view)`);
  ok(built && built.hasField, 'real shade field is active (engine.js)');
  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
  await page.screenshot({ path: TEMP + '\\nav_e2e_1_boot.png' });
  await ctx.close();
}

/* ===================== Scenario 2 — live GPS walk: dot shows + moves ===================== */
console.log('\n• Scenario 2 — live GPS walk: the dot is visible, moves, compass cone updates');
{
  const ctx = await makeContext(browser, true);
  const page = await ctx.newPage();
  await page.goto(NAV_URL(srv.url), { waitUntil: 'load' });
  await waitFor(page, n => n.routePts > 1, 20000);

  await page.locator('button:has-text("Live-Navigation")').click();
  const onGps = await waitFor(page, n => n.gps === 'on', 15000);
  ok(onGps && onGps.gps === 'on', 'live GPS engaged after tapping "Live-Navigation starten"');

  // walk along the route, feeding GPS + IMU
  const samples = [];
  for (let i = 0; i < ROUTE.length; i += 2) {
    await ctx.setGeolocation({ latitude: ROUTE[i][0], longitude: ROUTE[i][1], accuracy: 6 });
    for (let k = 0; k < 4; k++) await imu(page, 35 + i, i * 50 + k * 50); // heading ~NE, step bounce
    await sleep(160);
    const n = await nav(page); if (n && n.pos) samples.push(n);
  }
  const dotVisible = await page.evaluate(() => { const n = window.__nav; return n && n.dot && n.dot[0] > 0 && n.dot[1] > 0; });
  ok(dotVisible, 'user dot is present on the map');
  const moved = samples.length > 2 && hav(samples[0].pos, samples[samples.length - 1].pos) > 60;
  ok(moved, `dot tracked the real GPS track (${samples.length ? Math.round(hav(samples[0].pos, samples[samples.length - 1].pos)) : 0} m of travel)`);
  const progressed = samples.length > 2 && samples[samples.length - 1].progress > samples[0].progress + 50;
  ok(progressed, `progress advanced along the route (${samples.length ? samples[0].progress + '→' + samples[samples.length - 1].progress + ' m' : 'n/a'})`);

  // compass cone: sweep the device heading and confirm it is reflected
  await imu(page, 270, 9000); await sleep(200);
  const h1 = (await nav(page)).deviceHeading;
  await imu(page, 90, 9200); await sleep(200);
  const h2 = (await nav(page)).deviceHeading;
  ok(h1 != null && h2 != null && Math.abs(h1 - h2) > 100, `device-orientation cone follows the compass (≈${Math.round(h1)}° → ${Math.round(h2)}°)`);
  await page.screenshot({ path: TEMP + '\\nav_e2e_2_walk.png' });
  await ctx.close();
}

/* ===================== Scenario 3 — off-route: dot off the line + auto reroute ===================== */
console.log('\n• Scenario 3 — start off-route: dot shows your real spot, route re-plans from there');
{
  const ctx = await makeContext(browser, true);
  const page = await ctx.newPage();
  await page.goto(NAV_URL(srv.url), { waitUntil: 'load' });
  await waitFor(page, n => n.routePts > 1, 20000);
  await page.locator('button:has-text("Live-Navigation")').click();
  await waitFor(page, n => n.gps === 'on', 15000);

  // jump ~165 m south of the route start (clearly off-route, >20 m) and hold there
  const OFF = [FROM[0] - 0.0015, FROM[1]];
  await ctx.setGeolocation({ latitude: OFF[0], longitude: OFF[1], accuracy: 7 });
  const offState = await waitFor(page, n => n.off > 80, 8000);
  ok(offState && offState.off > 80, `off-route detected (>20 m), real position shown (${offState ? offState.off : 0} m off)`);

  // INSTANT recalculation with a visible loading indicator, then the new route ASAP
  let sawLoading = false;
  for (let i = 0; i < 60; i++) {
    await ctx.setGeolocation({ latitude: OFF[0], longitude: OFF[1], accuracy: 7 });
    await imu(page, 180, i * 150);
    const n = await nav(page);
    if (n && n.rerouting) sawLoading = true;
    if (n && hav(n.routeStart, OFF) < 25) break;
    await sleep(120);
  }
  ok(sawLoading, 'loading indicator ("Route wird neu berechnet") shown during recalculation');
  // keep the fix steady and let it settle onto the freshly planned route
  for (let i = 0; i < 6; i++) { await ctx.setGeolocation({ latitude: OFF[0], longitude: OFF[1], accuracy: 7 }); await imu(page, 180, 9000 + i * 120); await sleep(120); }
  const re = await waitFor(page, n => n.off < 35 && hav(n.routeStart, OFF) < 30, 5000);
  ok(re && hav(re.routeStart, OFF) < 30, `new route shown ASAP, starting at the live position (${re ? Math.round(hav(re.routeStart, OFF)) : '?'} m)`);
  ok(re && re.off < 35, `now back on the (new) route (${re ? re.off : '?'} m off)`);
  await page.screenshot({ path: TEMP + '\\nav_e2e_3_offroute.png' });
  await ctx.close();
}

/* ===================== Scenario 4 — no GPS access: big red notice ===================== */
console.log('\n• Scenario 4 — GPS access denied: a big red notice appears');
{
  const ctx = await makeContext(browser, false); // NO geolocation permission
  const page = await ctx.newPage();
  await page.goto(NAV_URL(srv.url), { waitUntil: 'load' });
  await waitFor(page, n => n.routePts > 1, 20000);
  await page.locator('button:has-text("Live-Navigation")').click();

  const notice = page.getByText('Kein GPS-Zugriff');
  let visible = false; try { await notice.waitFor({ state: 'visible', timeout: 12000 }); visible = true; } catch {}
  ok(visible, 'big red "Kein GPS-Zugriff" notice is shown when access is denied');
  if (visible) {
    const info = await notice.evaluate(el => {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      let p = el, bg = 'rgba(0, 0, 0, 0)';
      for (let i = 0; i < 6 && p; i++) { const b = getComputedStyle(p).backgroundColor; if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') { bg = b; break; } p = p.parentElement; }
      const rgb = (bg.match(/\d+/g) || []).map(Number);
      return { fs, bg, isRed: rgb.length >= 3 && rgb[0] > 200 && rgb[1] < 90 && rgb[2] < 90 };
    });
    ok(info.fs >= 18, `notice headline is large (${info.fs}px)`);
    ok(info.isRed, `notice bar is red (${info.bg})`);
  }
  await sleep(700); // let the notice fade-in finish before capturing
  await page.screenshot({ path: TEMP + '\\nav_e2e_4_nogps.png' });
  await ctx.close();
}

await browser.close();
await srv.close();
console.log('\n' + (failed === 0 ? `✓ NAV E2E PASSED (${passed} checks)` : `✗ ${failed} FAILED (${passed} passed)`));
console.log('screenshots in', TEMP + '\\nav_e2e_*.png');
process.exit(failed === 0 ? 0 : 1);
