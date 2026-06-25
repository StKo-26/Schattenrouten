// Smoke-test the ShadeWalk planner: boots cleanly, and the "use my location"
// crosshair button is present + works on BOTH the home screen and the
// results/navigation screen. Guards against deploying a broken file.
import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';

const D = Math.PI / 180;
function hav(a, b) { const R = 6371000; const dLa = (b[0] - a[0]) * D, dLo = (b[1] - a[1]) * D, la1 = a[0] * D, la2 = b[0] * D; const x = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const KA = [49.0094, 8.4037];
function osrmFor(url) {
  const m = url.match(/foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
  let from = KA, to = [49.0135, 8.4044];
  if (m) { from = [+m[2], +m[1]]; to = [+m[4], +m[3]]; }
  const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]); }
  let dist = 0; for (let i = 1; i < pts.length; i++) dist += hav(pts[i - 1], pts[i]);
  return JSON.stringify({ code: 'Ok', routes: [{ distance: dist, geometry: { coordinates: pts.map(c => [c[1], c[0]]) } }] });
}

const srv = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', geolocation: { latitude: KA[0], longitude: KA[1], accuracy: 10 }, permissions: ['geolocation'] });
await ctx.route('**/routed-foot/**', r => r.fulfill({ contentType: 'application/json', body: osrmFor(r.request().url()) }));
await ctx.route('**/interpreter**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [] }) }));
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
let bad = 0; const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { bad++; console.error('  ✗ FAIL: ' + m); } };
const locBtns = () => page.locator('button[aria-label*="Standort"]');

await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

ok(errs.length === 0, `planner boots without JS errors (${errs.slice(0, 2).join(' | ')})`);
ok(await locBtns().count() >= 1, `HOME screen: locate button present (${await locBtns().count()})`);
ok(await locBtns().first().isVisible(), 'HOME screen: locate button visible');

// use it to set the start, then search -> results/navigation screen
await locBtns().first().click();
await page.waitForTimeout(1200);
const fromVal = await page.locator('input').first().inputValue();
ok(/Standort|location/i.test(fromVal), `HOME screen: locate button fills the start ("${fromVal}")`);

await page.locator('button:has-text("Schattigste Route finden"), button:has-text("Find the shadiest route")').first().click();
await page.waitForTimeout(4000); // results view + map

const onResults = await page.locator('button[title*="Tausch"], button[title*="Swap"]').count() > 0 || /Min|km/.test(await page.locator('body').innerText());
ok(onResults, 'navigated to the results/navigation screen');
const rBtns = await locBtns().count();
ok(rBtns >= 1, `RESULTS screen: locate button present (${rBtns})`);
ok(await locBtns().first().isVisible(), 'RESULTS screen: locate button visible');
await locBtns().first().click();
await page.waitForTimeout(1000);
const fromVal2 = await page.locator('input').first().inputValue();
ok(/Standort|location/i.test(fromVal2), `RESULTS screen: locate button fills the start ("${fromVal2}")`);

await page.screenshot({ path: process.env.TEMP + '\\home_smoke.png' });
console.log('\n' + (bad === 0 ? '✓ HOME SMOKE PASSED' : `✗ ${bad} FAILED`));
await browser.close(); await srv.close();
process.exit(bad === 0 ? 0 : 1);
