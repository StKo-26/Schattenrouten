// Geometry helpers. Pure, dependency-free, browser + Node.
// All "meter" coordinates use a local equirectangular projection: x = east, y = north.

export const EARTH_R = 6371000; // m

/** Great-circle distance between two {lat,lon} points (meters). */
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Build a projector around an origin lat/lon. Returns {project, unproject}. */
export function makeProjector(originLat, originLon) {
  const cosLat = Math.cos(originLat * Math.PI / 180);
  const mPerDegLat = 111320; // ~meters per degree latitude
  const mPerDegLon = 111320 * cosLat;
  return {
    project(lat, lon) {
      return { x: (lon - originLon) * mPerDegLon, y: (lat - originLat) * mPerDegLat };
    },
    unproject(x, y) {
      return { lat: originLat + y / mPerDegLat, lon: originLon + x / mPerDegLon };
    },
  };
}

/** Ray-casting point-in-polygon test. poly = [{x,y}, ...] (meters). */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Point inside a circle (disk) centered at c with radius r (meters). */
export function pointInDisk(p, c, r) {
  const dx = p.x - c.x, dy = p.y - c.y;
  return dx * dx + dy * dy <= r * r;
}

/** Andrew's monotone chain convex hull. pts = [{x,y}]. Returns hull CCW. */
export function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0)
      lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0)
      upper.pop();
    upper.push(pt);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Axis-aligned bounding box of a set of {x,y} points. */
export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Sample n points evenly along a polyline of {x,y} vertices (inclusive of ends). */
export function samplePolyline(pts, spacing) {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [pts[0]];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }
  return out;
}
