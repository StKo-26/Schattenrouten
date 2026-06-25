// Planner (ShadeWalk results screen): a search shows the route immediately, then a
// non-blocking "Gebäude & Schatten werden geladen" pill while buildings load in the
// background, which disappears when done. Same pill while waiting on / rate-limited
// by the Overpass API.
import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';

const D = Math.PI / 180;
function hav(a, b) { const R = 6371000; const dLa = (b[0] - a[0]) * D, dLo = (b[1] - a[1]) * D, la1 = a[0] * D, la2 = b[0] * D; const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const KA = [49.0094, 8.4037];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function osrm(url) {
  const m = url.match(/foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  let from = KA, to = [49.0135, 8.4044];
  if (m) { from = [+m[2], +m[1]]; to = [+m[4], +m[3]]; }
  const a = [], b = [from[0] + 0.0006, from[1] - 0.0006];
  const mk = (f, t) => { const p = []; for (let i = 0; i <= 12; i++) { const k = i / 12; p.push([f[0] + (t[0] - f[0]) * k, f[1] + (t[1] - f[1]) * k]); } return p; };
  const r1 = mk(from, to), r2 = mk(from, to).map((c, i) => [c[0] + Math.sin(Math.PI * i / 12) * 0.0008, c[1]]);
  const dist = (c) => { let d = 0; for (let i = 1; i < c.length; i++) d += hav(c[i - 1], c[i]); return d; };
  return JSON.stringify({ code: 'Ok', routes: [r1, r2].map(c => ({ distance: dist(c), geometry: { coordinates: c.map(x => [x[1], x[0]]) } })) });
}
function buildings(n = 8) {
  let id = 1000, w = 5000; const els = [];
  for (let i = 0; i < n; i++) {
    const lat = KA[0] + 0.0004 * i / n, lon = KA[1] + 0.0005 * i / n, d = 8 / 111320, e = 8 / (111320 * Math.cos(lat * D));
    const ids = [[lat - d, lon - e], [lat - d, lon + e], [lat + d, lon + e], [lat + d, lon - e]].map(c => { const x = id++; els.push({ type: 'node', id: x, lat: c[0], lon: c[1] }); return x; });
    ids.push(ids[0]); els.push({ type: 'way', id: w++, nodes: ids, tags: { building: 'yes', 'building:levels': '5' } });
  }
  return JSON.stringify({ elements: els });
}

let bad = 0; const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { bad++; console.error('  ✗ FAIL: ' + m); } };
const srv = await startServer();
const browser = await chromium.launch();

async function newPage(overpassHandler) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', geolocation: { latitude: KA[0], longitude: KA[1], accuracy: 20 }, permissions: ['geolocation'] });
  await ctx.route('**/routed-foot/**', r => r.fulfill({ contentType: 'application/json', body: osrm(r.request().url()) }));
  await ctx.route('**/interpreter**', overpassHandler);
  await ctx.route('**/nominatim*/**', r => r.fulfill({ contentType: 'application/json', body: '[]' }));
  const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await ctx.route('**/basemaps.cartocdn.com/**', r => r.fulfill({ contentType: 'image/png', body: TILE })); // deterministic tiles
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  return { ctx, page };
}
async function search(page) { const b = page.locator('button:has-text("Schattigste Route finden"), button:has-text("Find the shadiest route")').first(); await b.waitFor({ state: 'visible', timeout: 15000 }); await b.click(); }
const pill = (page) => page.getByText(/Gebäude .* werden geladen|Loading buildings/);
const overlay = (page) => page.getByText(/Schatten werden berechnet|Estimating shadows/);

/* ---- Scenario 1: route shows immediately, pill during a slow building load ---- */
console.log('• Scenario 1 — route shown instantly, "loading buildings" pill during Overpass');
{
  const { ctx, page } = await newPage(async r => { await sleep(3000); r.fulfill({ contentType: 'application/json', body: buildings() }); });
  await search(page);
  // pill appears while buildings load
  let pillSeen = false; try { await pill(page).waitFor({ state: 'visible', timeout: 6000 }); pillSeen = true; } catch {}
  ok(pillSeen, 'building-loading pill is shown while Overpass loads');
  // route is already visible underneath (candidate list rendered, full overlay gone)
  ok(!(await overlay(page).isVisible().catch(() => false)), 'full blocking overlay is gone (route is visible, not blocked)');
  const routeShown = await page.locator('text=/\\bMin\\b/').count() > 0;
  ok(routeShown, 'the route + candidate list are shown while buildings still load');
  await page.screenshot({ path: process.env.TEMP + '\\planner_loading.png' });
  // pill disappears once buildings are loaded
  let pillGone = false; try { await pill(page).waitFor({ state: 'hidden', timeout: 8000 }); pillGone = true; } catch {}
  ok(pillGone, 'pill disappears once buildings/shade finished loading');
  await ctx.close();
}

/* ---- Scenario 2: rate-limited / empty Overpass -> pill during the wait, then warning ---- */
console.log('• Scenario 2 — pill while waiting on a rate-limited Overpass, then the busy notice');
{
  // always rate-limited -> the app retries (pill stays up), then gives up with the busy notice
  const { ctx, page } = await newPage(r => r.fulfill({ status: 429, contentType: 'text/plain', body: 'rate limited' }));
  await search(page);
  // (the pill may show while retrying, or clear instantly if the static fallback covers the area)
  // the invariant: it never hangs, and it resolves to buildings (fallback) OR the busy notice
  let pillGone = false; try { await pill(page).waitFor({ state: 'hidden', timeout: 22000 }); pillGone = true; } catch {}
  ok(pillGone, 'pill clears after the retries are exhausted (never stuck loading)');
  const res = await page.evaluate(() => {
    const w = window.__sw || {};
    const warn = !!Array.from(document.querySelectorAll('div')).find(d => /Kartendaten ausgelastet|Map data is busy/.test(d.textContent || ''));
    return { warn, bld: w.bldgDrawn || 0, osmB: w.osmBuildings || 0, mapW: w.mapW || 0, tiles: w.tilesLoaded || 0, field: !!w.hasField };
  });
  console.log('    DIAG ' + JSON.stringify(res));
  ok(res.warn || res.bld > 0, `resolved: busy notice OR buildings via fallback (warn=${res.warn}, drawn=${res.bld})`);
  await ctx.close();
}

await browser.close(); await srv.close();
console.log('\n' + (bad === 0 ? '✓ PLANNER E2E PASSED' : `✗ ${bad} FAILED`));
process.exit(bad === 0 ? 0 : 1);
