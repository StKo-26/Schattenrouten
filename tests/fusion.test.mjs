// Validates the pedestrian EKF (nav-fusion.js) on a synthetic walk:
// fuse noisy GPS + noisy compass heading + step-speed and check it beats raw GPS.
import '../nav-fusion.js';
const NF = globalThis.NavFusion;

let failed = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { failed++; console.error('  ✗ FAIL: ' + m); } };

// deterministic RNG + gaussian
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = (sd) => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

console.log('• pedestrian EKF fusion vs raw GPS');
const lat0 = 49.0, lon0 = 8.0;
const proj = NF.makeProj(lat0, lon0);

// Truth: walk east 90 m, then north 90 m, at 1.3 m/s. 20 Hz.
const dt = 0.05, speed = 1.3;
const truth = [];
let x = 0, y = 0;
const legLen = 90;
for (let phase = 0; phase < 2; phase++) {
  const steps = Math.round(legLen / (speed * dt));
  for (let i = 0; i < steps; i++) {
    if (phase === 0) x += speed * dt; else y += speed * dt;
    truth.push([x, y, phase === 0 ? 0 : Math.PI / 2]); // theta: east=0, north=pi/2
  }
}

const ekf = new NF.EKF(lat0, lon0);
let sumEkf = 0, sumGps = 0, nEval = 0, lastGps = null;
for (let k = 0; k < truth.length; k++) {
  const [tx, ty, th] = truth[k];
  ekf.predict(dt);

  // compass heading at ~10 Hz (noisy ±8°)
  if (k % 2 === 0) ekf.updateHeading(th + gauss(8 * Math.PI / 180), 8 * Math.PI / 180);
  // step speed at ~3 Hz (noisy)
  if (k % 7 === 0) ekf.updateSpeed(speed + gauss(0.2), 0.3);
  // GPS at 1 Hz (noisy ±8 m)
  if (k % 20 === 0) {
    const gx = tx + gauss(8), gy = ty + gauss(8);
    const ll = proj.toLL(gx, gy);
    ekf.updateGps(ll[0], ll[1], 8);
    lastGps = [gx, gy];
  }

  if (k > 40) { // after convergence
    const s = ekf.state();
    const e = proj.toXY(s.lat, s.lon);
    sumEkf += Math.hypot(e[0] - tx, e[1] - ty);
    if (lastGps) sumGps += Math.hypot(lastGps[0] - tx, lastGps[1] - ty);
    nEval++;
  }
}
const rmseEkf = sumEkf / nEval, rmseGps = sumGps / nEval;
console.log(`  mean error — EKF: ${rmseEkf.toFixed(2)} m, raw GPS: ${rmseGps.toFixed(2)} m`);
ok(rmseEkf < rmseGps, 'EKF beats raw GPS (fusion reduces error)');
ok(rmseEkf < 6, 'EKF mean error under 6 m');

const fin = ekf.state();
const fe = proj.toXY(fin.lat, fin.lon);
const tEnd = truth[truth.length - 1];
ok(Math.hypot(fe[0] - tEnd[0], fe[1] - tEnd[1]) < 12, 'final position within 12 m of truth');
ok(Math.abs(NF.wrap(fin.heading - Math.PI / 2)) < 0.35, 'final heading ~north');

console.log('• step detector');
const sd = new NF.StepDetector();
let steps = 0;
for (let i = 0; i < 600; i++) {            // 6 s @ 100 Hz, ~2 Hz bounce
  const t = i * 10;
  const mag = 9.81 + 2.4 * Math.sin(2 * Math.PI * 2 * (t / 1000)); // 2 Hz, ±2.4 m/s²
  if (sd.process(mag, t)) steps++;
}
console.log(`  detected ${steps} steps in 6 s of 2 Hz bounce`);
ok(steps >= 9 && steps <= 14, 'step detector finds ~12 steps');

console.log('\n' + (failed === 0 ? '✓ FUSION TESTS PASSED' : `✗ ${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
