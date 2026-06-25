// Screenshot debugger for the planner: desktop viewport, REAL OSRM + Overpass.
// Captures the map + internal state at increasing wait times to catch the
// "map is black" and "buildings load late" cases.  node tests/browser/debug_planner.mjs
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const TEMP = process.env.TEMP || '.';
const srv = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1900, height: 950 }, deviceScaleFactor: 1, locale: 'de-DE',
  geolocation: { latitude: 49.0094, longitude: 8.4037, accuracy: 30 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errs = [], failed = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('requestfailed', r => { const u = r.url(); if (/interpreter|overpass|routed-foot|carto/.test(u)) failed.push(r.failure()?.errorText + '  ' + u.slice(0, 70)); });
page.on('response', r => { const u = r.url(); if (/interpreter|overpass/.test(u) && r.status() !== 200) failed.push('HTTP ' + r.status() + '  ' + u.slice(0, 70)); });

await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
await page.waitForTimeout(2500);
console.log('clicking search…');
await page.locator('button:has-text("Schattigste Route finden"), button:has-text("Find the shadiest route")').first().click();

const probe = async () => page.evaluate(() => {
  const sw = window.__sw || {};
  const mapEl = document.querySelector('.leaflet-container');
  return {
    ...sw,
    containerSize: mapEl ? mapEl.clientWidth + 'x' + mapEl.clientHeight : 'none',
    leafletTiles: document.querySelectorAll('.leaflet-tile').length,
    tilesLoaded: document.querySelectorAll('.leaflet-tile-loaded').length,
    pill: !!Array.from(document.querySelectorAll('div')).find(d => /werden geladen|Loading buildings/.test(d.textContent || '') && d.children.length <= 2),
  };
});

const marks = [800, 1500, 3000, 6000, 10000, 15000];
let prev = 0;
for (const t of marks) {
  await page.waitForTimeout(t - prev); prev = t;
  const p = await probe();
  console.log(`\n[t=${t}ms] container=${p.containerSize} mapSize=${p.mapW}x${p.mapH} tiles=${p.leafletTiles}/${p.tilesLoaded} osmBld=${p.osmBuildings} drawn=${p.bldgDrawn} field=${p.hasField} pill=${p.pill} warn=${p.osmWarn}`);
  await page.screenshot({ path: `${TEMP}\\dbg_planner_${t}.png` });
}
console.log('\nPAGE ERRORS (' + errs.length + '):'); errs.slice(0, 6).forEach(e => console.log('  ! ' + e));
console.log('FAILED/!=200 REQUESTS (' + failed.length + '):'); failed.slice(0, 10).forEach(f => console.log('  x ' + f));
await browser.close(); await srv.close();
