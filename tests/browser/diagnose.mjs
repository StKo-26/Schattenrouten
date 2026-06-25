// Diagnostic: load the CURRENT Navigator under Android emulation with a spoofed
// GPS fix, then report exactly what renders (route? buildings? dot?) and any errors.
// This reproduces the user's "doesn't even show the route or buildings" report.
import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';

const srv = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices['Pixel 5'],
  geolocation: { latitude: 52.5170, longitude: 13.3830, accuracy: 8 },
  permissions: ['geolocation'],
  locale: 'de-DE',
});
const page = await ctx.newPage();
const logs = [], errs = [], failedReq = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => errs.push(String(e)));
page.on('requestfailed', r => failedReq.push(`${r.url()} — ${r.failure()?.errorText}`));

const url = `${srv.url}/Navigator.dc.html?from=52.5170,13.3830&to=52.5205,13.4000&fromName=Start&toName=Ziel&hour=15&shade=70`;
console.log('loading', url);
await page.goto(url, { waitUntil: 'load' });

// give it generous time to load Leaflet (CDN), fetch the route (OSRM) + buildings (Overpass)
await page.waitForTimeout(12000);

const probe = await page.evaluate(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const mapEl = document.querySelector('.leaflet-container');
  const overlaySvg = document.querySelector('svg');
  const spinnerText = Array.from(document.querySelectorAll('span')).map(s => s.textContent).find(t => /wird gesucht|berechnet/i.test(t || ''));
  const bannerTitle = (document.body.innerText.match(/Losgehen|Geradeaus|Links|Rechts|Ziel/) || [])[0] || null;
  return {
    leafletContainer: !!mapEl,
    leafletTiles: q('.leaflet-tile'),
    leafletTilesLoaded: q('.leaflet-tile-loaded'),
    svgCount: q('svg'),
    svgChildren: overlaySvg ? overlaySvg.children.length : 0,
    polylineOrPolygon: q('svg polyline') + q('svg polygon') + q('svg line') + q('svg circle'),
    canvasCount: q('canvas'),
    leafletPaths: q('.leaflet-overlay-pane path') + q('.leaflet-overlay-pane circle'),
    spinnerStillShowing: !!spinnerText,
    bannerTitle,
    hasL: typeof window.L !== 'undefined',
    hasNavCore: typeof window.NavCore !== 'undefined',
    hasNavFusion: typeof window.NavFusion !== 'undefined',
    hasShadeEngine: typeof window.ShadeEngine !== 'undefined',
    mapElSize: mapEl ? mapEl.clientWidth + 'x' + mapEl.clientHeight : 'none',
    innerW: window.innerWidth,
  };
});

console.log('\n=== RENDER PROBE ===');
for (const [k, v] of Object.entries(probe)) console.log(`  ${k}: ${v}`);
console.log('\n=== PAGE ERRORS (' + errs.length + ') ===');
errs.forEach(e => console.log('  ! ' + e));
console.log('\n=== FAILED REQUESTS (' + failedReq.length + ') ===');
failedReq.slice(0, 20).forEach(r => console.log('  x ' + r));
console.log('\n=== CONSOLE (last 25) ===');
logs.slice(-25).forEach(l => console.log('  ' + l));

const shotPath = process.env.TEMP + '\\nav_diagnose.png';
await page.screenshot({ path: shotPath, fullPage: false });
console.log('\nscreenshot:', shotPath);

await browser.close();
await srv.close();
