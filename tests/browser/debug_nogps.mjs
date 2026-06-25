import { chromium, devices } from 'playwright';
import { startServer } from './server.mjs';
const srv = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 5'], locale: 'de-DE' }); // no geolocation permission
const page = await ctx.newPage();
await page.goto(`${srv.url}/Navigator.dc.html?from=52.5170,13.3830&to=52.5205,13.4000&hour=15&shade=70`, { waitUntil: 'load' });
await page.waitForTimeout(6000);
await page.locator('button:has-text("Live-Navigation")').click();
const title = page.getByText('Kein GPS-Zugriff');
try { await title.waitFor({ state: 'visible', timeout: 16000 }); } catch {}
const box = await title.boundingBox().catch(() => null);
console.log('locator boundingBox:', JSON.stringify(box));
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('div')).find(d => /Kein GPS-Zugriff/.test(d.textContent || '') && d.children.length === 0);
  if (!el) return { found: false };
  // climb to the red bar
  let bar = el; for (let i = 0; i < 6 && bar; i++) { if (getComputedStyle(bar).backgroundColor.includes('255, 45')) break; bar = bar.parentElement; }
  const r = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    found: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    opacity: cs.opacity, visibility: cs.visibility, display: cs.display, zIndex: cs.zIndex, bg: cs.backgroundColor,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    topElementIsBanner: bar.contains(top), topElementClass: top ? (top.className || top.tagName) : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: process.env.TEMP + '\\nav_debug_nogps.png' });
await browser.close(); await srv.close();
