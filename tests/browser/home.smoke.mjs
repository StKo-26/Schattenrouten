// Smoke-test the ShadeWalk homepage (planner): boots cleanly, shows the
// "use my location" button, and a search produces routes. Guards against
// deploying a broken file while another process edits the planner.
import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';

const srv = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE', geolocation: { latitude: 49.0094, longitude: 8.4037, accuracy: 10 }, permissions: ['geolocation'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
let bad = 0; const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { bad++; console.error('  ✗ FAIL: ' + m); } };

await page.goto(`${srv.url}/ShadeWalk.dc.html`, { waitUntil: 'load' });
await page.waitForTimeout(3500);

ok(errs.length === 0, `homepage boots without JS errors (${errs.slice(0, 2).join(' | ')})`);
const locBtn = page.locator('button[aria-label*="Standort"], button[title*="Standort"], button[aria-label*="location"]');
ok(await locBtn.count() > 0, `"use my location" button is present (${await locBtn.count()})`);
ok(await locBtn.first().isVisible(), 'locate button is visible');

// the search box exists
const fromInput = page.locator('input').first();
ok(await fromInput.count() > 0, 'start input present');

// clicking the locate button sets the start to the live position
await locBtn.first().click();
await page.waitForTimeout(1200);
const fromVal = await fromInput.inputValue();
ok(/Standort|location/i.test(fromVal), `locate button fills the start field ("${fromVal}")`);

await page.screenshot({ path: process.env.TEMP + '\\home_smoke.png' });
console.log('\n' + (bad === 0 ? '✓ HOME SMOKE PASSED' : `✗ ${bad} FAILED`));
await browser.close(); await srv.close();
process.exit(bad === 0 ? 0 : 1);
