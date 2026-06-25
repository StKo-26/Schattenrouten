/* SchattenRouten navigation fusion — pedestrian Extended Kalman Filter that fuses
   GPS (position) with IMU-derived heading (magnetometer/compass) and step events
   (accelerometer dead-reckoning). Pure math, no DOM. Exposes window.NavFusion.
   State x = [px, py, v, theta]  (east/north metres, speed m/s, heading rad from +east, CCW).
   Tested in Node (tests/fusion.test.mjs). */
(function (root) {
  'use strict';
  var DEG = Math.PI / 180;

  /* ---------- small dense-matrix helpers (arrays of arrays) ---------- */
  function ident(n) { var m = []; for (var i = 0; i < n; i++) { m.push([]); for (var j = 0; j < n; j++) m[i].push(i === j ? 1 : 0); } return m; }
  function mt(A) { var r = A.length, c = A[0].length, B = []; for (var j = 0; j < c; j++) { B.push([]); for (var i = 0; i < r; i++) B[j].push(A[i][j]); } return B; }
  function mmul(A, B) { var r = A.length, k = B.length, c = B[0].length, C = [], i, j, t, s; for (i = 0; i < r; i++) { C.push([]); for (j = 0; j < c; j++) { s = 0; for (t = 0; t < k; t++) s += A[i][t] * B[t][j]; C[i].push(s); } } return C; }
  function madd(A, B) { var C = [], i, j; for (i = 0; i < A.length; i++) { C.push([]); for (j = 0; j < A[0].length; j++) C[i].push(A[i][j] + B[i][j]); } return C; }
  function msub(A, B) { var C = [], i, j; for (i = 0; i < A.length; i++) { C.push([]); for (j = 0; j < A[0].length; j++) C[i].push(A[i][j] - B[i][j]); } return C; }
  function inv2(M) { var a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1], det = a * d - b * c; if (Math.abs(det) < 1e-12) det = 1e-12; return [[d / det, -b / det], [-c / det, a / det]]; }
  function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

  /* ---------- local equirectangular projection ---------- */
  function makeProj(lat0, lon0) {
    var mLat = 111320, mLon = 111320 * Math.cos(lat0 * DEG);
    return {
      toXY: function (lat, lon) { return [(lon - lon0) * mLon, (lat - lat0) * mLat]; },
      toLL: function (x, y) { return [lat0 + y / mLat, lon0 + x / mLon]; },
    };
  }
  /** Compass heading (deg, 0=N clockwise) -> EKF theta (rad from +east, CCW). */
  function headingToTheta(compassDeg) { return wrap((90 - compassDeg) * DEG); }

  /* ---------- Pedestrian EKF ---------- */
  function EKF(lat0, lon0, opts) {
    opts = opts || {};
    this.proj = makeProj(lat0, lon0);
    this.x = [0, 0, 0, 0];
    this.P = [[400, 0, 0, 0], [0, 400, 0, 0], [0, 0, 1, 0], [0, 0, 0, Math.PI * Math.PI]];
    this.inited = false;
    this.Qpos = opts.Qpos != null ? opts.Qpos : 0.04;   // m²/s position random walk
    this.Qv = opts.Qv != null ? opts.Qv : 0.45;         // (m/s)²/s speed
    this.Qth = opts.Qth != null ? opts.Qth : 0.06;      // rad²/s heading
  }
  EKF.prototype.initFromGps = function (lat, lon, headingRad) {
    var p = this.proj.toXY(lat, lon);
    this.x = [p[0], p[1], 0, headingRad || 0];
    this.inited = true;
  };
  EKF.prototype.predict = function (dt) {
    if (!this.inited || dt <= 0) return;
    if (dt > 2) dt = 2;
    var px = this.x[0], py = this.x[1], v = this.x[2], th = this.x[3];
    var c = Math.cos(th), s = Math.sin(th);
    this.x = [px + v * c * dt, py + v * s * dt, v, wrap(th)];
    var F = [[1, 0, c * dt, -v * s * dt], [0, 1, s * dt, v * c * dt], [0, 0, 1, 0], [0, 0, 0, 1]];
    var Q = [[this.Qpos * dt, 0, 0, 0], [0, this.Qpos * dt, 0, 0], [0, 0, this.Qv * dt, 0], [0, 0, 0, this.Qth * dt]];
    this.P = madd(mmul(mmul(F, this.P), mt(F)), Q);
  };
  EKF.prototype.updateGps = function (lat, lon, accuracy) {
    var p = this.proj.toXY(lat, lon);
    if (!this.inited) { this.x = [p[0], p[1], 0, this.x[3]]; this.inited = true; return; }
    var H = [[1, 0, 0, 0], [0, 1, 0, 0]];
    var r = Math.max(3, accuracy || 12); var R = [[r * r, 0], [0, r * r]];
    var y = [p[0] - this.x[0], p[1] - this.x[1]];
    var S = madd(mmul(mmul(H, this.P), mt(H)), R);
    var K = mmul(mmul(this.P, mt(H)), inv2(S));      // 4x2
    for (var i = 0; i < 4; i++) this.x[i] += K[i][0] * y[0] + K[i][1] * y[1];
    this.x[3] = wrap(this.x[3]);
    this.P = mmul(msub(ident(4), mmul(K, H)), this.P);
  };
  EKF.prototype._update1 = function (Hrow, innovation, variance) {
    var H = [Hrow], R = [[variance]];
    var S = madd(mmul(mmul(H, this.P), mt(H)), R);      // 1x1
    var Sinv = [[1 / (S[0][0] || 1e-9)]];
    var K = mmul(mmul(this.P, mt(H)), Sinv);            // 4x1
    for (var i = 0; i < 4; i++) this.x[i] += K[i][0] * innovation;
    this.P = mmul(msub(ident(4), mmul(K, H)), this.P);
  };
  /** Compass/gyro heading measurement (rad). */
  EKF.prototype.updateHeading = function (thetaRad, sigmaRad) {
    if (!this.inited) { this.x[3] = thetaRad; return; }
    this._update1([0, 0, 0, 1], wrap(thetaRad - this.x[3]), (sigmaRad || 0.25) * (sigmaRad || 0.25));
    this.x[3] = wrap(this.x[3]);
  };
  /** Speed measurement from step cadence, or a Zero-velocity update (speed 0). */
  EKF.prototype.updateSpeed = function (speed, sigma) {
    if (!this.inited) return;
    this._update1([0, 0, 1, 0], speed - this.x[2], (sigma || 0.3) * (sigma || 0.3));
    if (this.x[2] < 0) this.x[2] = 0;
  };
  EKF.prototype.state = function () {
    var ll = this.proj.toLL(this.x[0], this.x[1]);
    return { lat: ll[0], lon: ll[1], speed: this.x[2], heading: this.x[3],
      posStd: Math.sqrt(Math.max(0, (this.P[0][0] + this.P[1][1]) / 2)) };
  };

  /* ---------- accelerometer step detector ----------
     Feed acceleration magnitude samples; emits a step on each foot-fall. */
  function StepDetector(opts) {
    opts = opts || {};
    this.g = 9.81; this.ac = 0; this.prevAc = 0; this.rising = false;
    this.lastStepT = 0; this.minGap = opts.minGap || 270; // ms refractory
    this.thresh = opts.thresh || 1.1;                     // m/s² above baseline
    this.peak = 0;
  }
  StepDetector.prototype.process = function (mag, tMs) {
    this.g += 0.08 * (mag - this.g);            // low-pass = gravity/baseline
    var ac = mag - this.g;                       // high-pass (linear accel along vertical-ish)
    var step = null;
    if (ac > this.prevAc) { this.rising = true; this.peak = ac; }
    else if (this.rising && this.peak > this.thresh && (tMs - this.lastStepT) > this.minGap) {
      this.rising = false;
      var dt = (tMs - this.lastStepT) / 1000;
      this.lastStepT = tMs;
      // Weinberg-style step length from bounce amplitude, clamped to realistic range.
      var len = 0.45 + 0.18 * Math.min(2.2, this.peak);
      len = Math.max(0.4, Math.min(0.95, len));
      var cadence = dt > 0 && dt < 2 ? 1 / dt : 1.8;
      step = { length: len, dt: dt, speed: Math.max(0.3, Math.min(2.2, len * cadence)) };
    } else if (ac < this.prevAc) {
      this.rising = false;
    }
    this.prevAc = ac;
    return step;
  };

  root.NavFusion = { EKF: EKF, StepDetector: StepDetector, makeProj: makeProj, headingToTheta: headingToTheta, wrap: wrap };
})(typeof window !== 'undefined' ? window : globalThis);
