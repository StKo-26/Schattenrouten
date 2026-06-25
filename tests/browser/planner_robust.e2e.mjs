// Reproduces the two intermittent planner failures and verifies the fixes:
//   A) slow Leaflet CDN  -> map must still render (no black map)
//   B) Overpass rate-limited, then recovers -> buildings must still appear, no premature warning
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const D = Math.PI / 180;
function hav(a, b) { const R = 6371000; const dLa = (b[0] - a[0]) * D, dLo = (b[1] - a[1]) * D, la1 = a[0] * D, la2 = b[0] * D; const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const KA = [49.0094, 8.4037];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function osrm(url) {
  const m = url.match(/foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  let from = KA, to = [49.0135, 8.4044]; if (m) { from = [+m[2], +m[1]]; to = [+m[4], +m[3]]; }
  const p = []; for (let i = 0; i <= 12; i++) { const k = i / 12; p.push([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]); }
  let d = 0; for (let i = 1; i < p.length; i++) d += hav(p[i - 1], p[i]);
  return JSON.stringify({ code: 'Ok', routes: [{ distance: d, geometry: { coordinates: p.map(c => [c[1], c[0]]) } }] });
}
function buildingsBody(n = 12) {
  let id = 1000, w = 5000; const els = [];
  for (let i = 0; i < n; i++) {
    const lat = KA[0] + 0.0045 * i / n, lon = KA[1] + 0.0006 * i / n, dd = 9 / 111320, ee = 9 / (111320 * Math.cos(lat * D));
    const ids = [[lat - dd, lon - ee], [lat - dd, lon + ee], [lat + dd, lon + ee], [lat + dd, lon - ee]].map(c => { const x = id++; els.push({ type: 'node', id: x, lat: c[0], lon: c[1] }); return x; });
    ids.push(ids[0]); els.push({ type: 'way', id: w++, nodes: ids, tags: { building: 'yes', 'building:levels': '5' } });
  }
  return JSON.stringify({ elements: els });
}
let bad = 0; const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { bad++; console.error('  ✗ FAIL: ' + m); } };
const srv = await startServer();
const browser = await chromium.launch();
const sw = (page) => page.evaluate(() => window.__sw || {});
const search = (page) => page.locator('button:has-text("Schattigste Route finden"), button:has-text("Find the shadiest route")').first().click();
async function waitFor(page, pred, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await sw(page); if (pred(s)) return s; await sleep(250); } return await sw(page); }

async function ctxBase() {
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 900 }, locale: 'de-DE', geolocation: { latitude: KA[0], longitude: KA[1], accuracy: 20 }, permissions: ['geolocation'] });
  await ctx.route('**/routed-foot/**', r => r.fulfill({ contentType: 'application/json', body: osrm(r.request().url()) }));
  await ctx.route('**/nominatim*/**', r => r.fulfill({ contentType: 'application/json', body: '[]' }));
  return ctx;
}

/* ---- A) slow Leaflet CDN must not leave a black map ---- */
console.log('• Scenario A — slow Leaflet CDN: the map must still render (no black map)');
{
  const ctx = await ctxBase();
  await ctx.route('**/leaflet*.js', async r => { await sleep(2600); await r.continue(); }); // CDN lag
  await ctx.route('**/interpreter**', r => r.fulfill({ contentType: 'application/json', body: buildingsBody() }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await search(page); // click while Leaflet is still loading -> exercises the retry loop
  const s = await waitFor(page, x => x.mapW > 50 && x.tilesLoaded > 0, 14000);
  ok(s.mapW > 50, `map initialised at full size despite slow Leaflet (${s.mapW}x${s.mapH})`);
  ok(s.tilesLoaded > 0, `tiles loaded (no black map) — ${s.tilesLoaded} tiles`);
  const s2 = await waitFor(page, x => x.bldgDrawn > 0, 8000);
  ok(s2.bldgDrawn > 0, `buildings drawn after the map recovered (${s2.bldgDrawn})`);
  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
  await page.screenshot({ path: process.env.TEMP + '\\planner_slowleaflet.png' });
  await ctx.close();
}

/* ---- B) Overpass rate-limited then recovers: buildings must still appear ---- */
console.log('• Scenario B — Overpass rate-limited then recovers: buildings still appear');
{
  const ctx = await ctxBase();
  const start = Date.now();
  await ctx.route('**/interpreter**', r => { if (Date.now() - start < 3200) r.fulfill({ status: 429, contentType: 'text/plain', body: 'rate limited' }); else r.fulfill({ contentType: 'application/json', body: buildingsBody() }); });
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await search(page);
  // buildings should eventually appear once the retry hits the recovered API
  const s = await waitFor(page, x => x.bldgDrawn > 0, 16000);
  ok(s.bldgDrawn > 0, `buildings appear after retrying past the rate limit (${s.bldgDrawn} drawn)`);
  ok(!s.osmWarn, 'no busy-notice once buildings recover');
  await page.screenshot({ path: process.env.TEMP + '\\planner_ratelimit.png' });
  await ctx.close();
}

await browser.close(); await srv.close();
console.log('\n' + (bad === 0 ? '✓ PLANNER ROBUSTNESS PASSED' : `✗ ${bad} FAILED`));
process.exit(bad === 0 ? 0 : 1);
