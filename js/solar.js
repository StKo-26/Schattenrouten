// Solar position (NOAA algorithm). Pure, dependency-free, works in browser + Node.
// Returns the sun's elevation and azimuth for a given instant and location.
// Azimuth convention: degrees clockwise from geographic north (0=N, 90=E, 180=S, 270=W).

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function julianDay(date) {
  // date is a JS Date (UTC instant). 2440587.5 = JD of the Unix epoch.
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Compute the solar position.
 * @param {Date} date     UTC instant.
 * @param {number} latDeg latitude in degrees (north positive).
 * @param {number} lonDeg longitude in degrees (east positive).
 * @returns {{elevationDeg:number, azimuthDeg:number, altitudeRad:number}}
 */
export function sunPosition(date, latDeg, lonDeg) {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525.0; // Julian centuries since J2000.0

  const L0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360); // geom mean long (deg)
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t); // geom mean anomaly (deg)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // eccentricity

  const sinM = Math.sin(M * DEG);
  const C =
    sinM * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * M * DEG) * 0.000289; // equation of center (deg)

  const trueLong = L0 + C;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG);

  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG);

  const declin = Math.asin(Math.sin(obliqCorr * DEG) * Math.sin(appLong * DEG)) * RAD; // deg

  const varY = Math.tan((obliqCorr / 2) * DEG) ** 2;
  const eqOfTime =
    4 *
    RAD *
    (varY * Math.sin(2 * L0 * DEG) -
      2 * e * Math.sin(M * DEG) +
      4 * e * varY * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG) -
      0.5 * varY * varY * Math.sin(4 * L0 * DEG) -
      1.25 * e * e * Math.sin(2 * M * DEG)); // minutes

  // Minutes of the day in UTC.
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;

  const trueSolarTime = mod(utcMinutes + eqOfTime + 4 * lonDeg, 1440); // minutes
  let hourAngle = trueSolarTime / 4 - 180; // degrees, 0 at local solar noon

  const latRad = latDeg * DEG;
  const declRad = declin * DEG;
  const haRad = hourAngle * DEG;

  const cosZenith =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad);
  const zenith = Math.acos(clamp(cosZenith, -1, 1)); // radians
  const elevationDeg = 90 - zenith * RAD;

  // Azimuth (clockwise from north).
  const denom = Math.cos(latRad) * Math.sin(zenith);
  let azimuthDeg;
  if (Math.abs(denom) < 1e-9) {
    azimuthDeg = elevationDeg > 0 ? 180 : 0; // sun at the zenith/nadir – degenerate
  } else {
    const cosAz = clamp(
      (Math.sin(latRad) * Math.cos(zenith) - Math.sin(declRad)) / denom,
      -1,
      1
    );
    const acAz = Math.acos(cosAz) * RAD;
    azimuthDeg = hourAngle > 0 ? mod(acAz + 180, 360) : mod(540 - acAz, 360);
  }

  return {
    elevationDeg,
    azimuthDeg,
    altitudeRad: elevationDeg * DEG,
  };
}

function mod(a, n) {
  return ((a % n) + n) % n;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
