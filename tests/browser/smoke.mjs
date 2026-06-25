// Gating smoke test: can Playwright Chromium actually render + can we spoof
// geolocation and dispatch DeviceOrientation/DeviceMotion in this sandbox?
import { chromium, devices } from 'playwright';

const log = (...a) => console.log(...a);
let bad = 0;
const ok = (c, m) => { if (c) log('  ✓ ' + m); else { bad++; log('  ✗ FAIL ' + m); } };

const browser = await chromium.launch();
log('launched:', browser.version());

const pixel = devices['Pixel 5'];
const ctx = await browser.newContext({
  ...pixel,
  geolocation: { latitude: 52.5170, longitude: 13.3830, accuracy: 8 },
  permissions: ['geolocation'],
  locale: 'de-DE',
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));

await page.setContent('<div id="b" style="width:100px;height:100px;background:#ff0000"></div><div id="g"></div>');
const bg = await page.$eval('#b', el => getComputedStyle(el).backgroundColor);
ok(bg === 'rgb(255, 0, 0)', 'renders DOM + computes styles (' + bg + ')');

// screenshot has real pixels
const shot = await page.screenshot();
ok(shot.length > 1000, 'screenshot produced (' + shot.length + ' bytes)');

// emulated as mobile?
const mobile = await page.evaluate(() => ({ w: innerWidth, touch: 'ontouchstart' in window, ua: navigator.userAgent }));
ok(mobile.w < 500 && /Android/.test(mobile.ua), 'emulated Android viewport (' + mobile.w + 'px, ' + /Android/.test(mobile.ua) + ')');

// geolocation spoofing reaches the page
const geo = await page.evaluate(() => new Promise(res => {
  navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), e => res({ err: e.message }), { enableHighAccuracy: true });
}));
ok(geo.lat && Math.abs(geo.lat - 52.5170) < 1e-4, 'geolocation spoof reaches page (' + JSON.stringify(geo) + ')');

// can we move it?
await ctx.setGeolocation({ latitude: 52.5200, longitude: 13.3900, accuracy: 5 });
const geo2 = await page.evaluate(() => new Promise(res => navigator.geolocation.getCurrentPosition(p => res(p.coords.latitude))));
ok(Math.abs(geo2 - 52.5200) < 1e-4, 'geolocation can be moved at runtime (' + geo2 + ')');

// DeviceOrientation / DeviceMotion event injection
const sensed = await page.evaluate(() => new Promise(res => {
  let got = {};
  window.addEventListener('deviceorientation', e => { got.alpha = e.alpha; if (got.acc != null) res(got); }, { once: false });
  window.addEventListener('devicemotion', e => { got.acc = e.accelerationIncludingGravity && e.accelerationIncludingGravity.z; if (got.alpha != null) res(got); });
  const o = new Event('deviceorientation'); o.alpha = 137; o.beta = 2; o.gamma = 1; o.absolute = true; window.dispatchEvent(o);
  const m = new Event('devicemotion'); m.accelerationIncludingGravity = { x: 0, y: 0, z: 9.8 }; window.dispatchEvent(m);
  setTimeout(() => res(got), 500);
}));
ok(sensed.alpha === 137 && Math.abs(sensed.acc - 9.8) < 0.1, 'DeviceOrientation + DeviceMotion injectable (' + JSON.stringify(sensed) + ')');

ok(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');

await browser.close();
log('\n' + (bad === 0 ? '✓ BROWSER ENV WORKS' : `✗ ${bad} smoke checks failed`));
process.exit(bad === 0 ? 0 : 1);
