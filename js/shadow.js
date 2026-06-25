// Shadow modelling: estimate building & tree heights, project their shadows for a
// given sun position, and compute how shaded each graph edge is. Pure, browser + Node.

import {
  makeProjector, pointInPolygon, pointInDisk, convexHull, bbox, samplePolyline,
} from './geometry.js';

const DEG = Math.PI / 180;
const LEVEL_HEIGHT = 3.2;     // m per building level
const DEFAULT_BUILDING_H = 9; // m, when nothing is tagged
const MAX_SHADOW_LEN = 200;   // m, cap to keep low-sun shadows sane

/** Estimate a building's height in meters from OSM tags. */
export function buildingHeight(tags = {}) {
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(',', '.'));
    if (isFinite(h) && h > 0) return h;
  }
  if (tags['building:levels']) {
    const lv = parseFloat(String(tags['building:levels']).replace(',', '.'));
    if (isFinite(lv) && lv > 0) return lv * LEVEL_HEIGHT + 1;
  }
  const b = tags.building;
  if (b === 'church' || b === 'cathedral') return 20;
  if (b === 'commercial' || b === 'retail' || b === 'office') return 12;
  if (b === 'apartments') return 15;
  if (b === 'house' || b === 'detached' || b === 'garage' || b === 'hut' || b === 'shed') return 6;
  return DEFAULT_BUILDING_H;
}

/** Estimate tree height (m), crown radius (m), and leaf density (0..1) from tags + month. */
export function treeProps(tags = {}, month = 6) {
  let height = 9;
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(',', '.'));
    if (isFinite(h) && h > 0) height = h;
  } else if (tags['est_height']) {
    const h = parseFloat(String(tags['est_height']).replace(',', '.'));
    if (isFinite(h) && h > 0) height = h;
  }

  let crownR = 3.5;
  if (tags['diameter_crown']) {
    const d = parseFloat(String(tags['diameter_crown']).replace(',', '.'));
    if (isFinite(d) && d > 0) crownR = d / 2;
  } else {
    crownR = Math.max(2, height * 0.35); // crown scales with height
  }

  // Leaf density: needleleaved trees keep foliage year round; broadleaved drop it.
  const leafType = tags.leaf_type;
  const evergreen = leafType === 'needleleaved' || tags.leaf_cycle === 'evergreen';
  let density = leafType === 'needleleaved' ? 0.85 : 0.7;
  if (!evergreen) {
    // Northern-hemisphere leaf-on fraction by month (deciduous canopy).
    const leafOn = [0.05, 0.05, 0.15, 0.5, 0.85, 1, 1, 1, 0.9, 0.6, 0.2, 0.05];
    density *= leafOn[(month - 1 + 12) % 12];
  }
  return { height, crownR, density };
}

/**
 * Build shadow casters in a local meter plane for a given sun position.
 * @returns {{
 *   projector, shadowUnit:{x,y}, valid:boolean,
 *   buildingShadows: Array<{poly:[{x,y}], box, opacity:1}>,
 *   treeShadows: Array<{c:{x,y}, r:number, box, opacity:number}>,
 *   grid: SpatialGrid
 * }}
 */
export function buildShadowField(buildings, trees, sun, originLat, originLon, month = 6) {
  const projector = makeProjector(originLat, originLon);
  const valid = sun.elevationDeg > 0.5; // sun above horizon → real shadows
  const elevRad = Math.max(sun.elevationDeg, 0.5) * DEG;

  // Horizontal direction the shadow is cast (opposite the sun), as an east/north unit vector.
  const shadowBearing = (sun.azimuthDeg + 180) * DEG;
  const shadowUnit = { x: Math.sin(shadowBearing), y: Math.cos(shadowBearing) };
  const lenFor = (h) => Math.min(MAX_SHADOW_LEN, h / Math.tan(elevRad));

  const buildingShadows = [];
  for (const b of buildings) {
    const h = buildingHeight(b.tags);
    const L = lenFor(h);
    const base = b.ring.map((p) => projector.project(p.lat, p.lon));
    const shifted = base.map((p) => ({ x: p.x + shadowUnit.x * L, y: p.y + shadowUnit.y * L }));
    const poly = convexHull(base.concat(shifted));
    if (poly.length >= 3) buildingShadows.push({ poly, box: bbox(poly), opacity: 1, height: h });
  }

  const treeShadows = [];
  for (const t of trees) {
    const tp = treeProps(t.tags, month);
    if (tp.density <= 0.02) continue;
    const L = lenFor(tp.height * 0.7); // shadow of the crown centroid
    const tpos = projector.project(t.lat, t.lon);
    const c = { x: tpos.x + shadowUnit.x * L, y: tpos.y + shadowUnit.y * L };
    const r = tp.crownR;
    treeShadows.push({
      c, r, opacity: tp.density, height: tp.height,
      box: { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r },
    });
  }

  const grid = new SpatialGrid(40); // 40 m buckets
  buildingShadows.forEach((s, i) => grid.insert(s.box, { type: 'b', i }));
  treeShadows.forEach((s, i) => grid.insert(s.box, { type: 't', i }));

  return { projector, shadowUnit, valid, buildingShadows, treeShadows, grid };
}

/** Shade level (0..1) at a single meter-plane point. */
function shadeAt(p, field) {
  let shade = 0;
  for (const ref of field.grid.query(p.x, p.y)) {
    if (ref.type === 'b') {
      const s = field.buildingShadows[ref.i];
      if (inBox(p, s.box) && pointInPolygon(p, s.poly)) return 1; // opaque, max shade
    } else {
      const s = field.treeShadows[ref.i];
      if (inBox(p, s.box) && pointInDisk(p, s.c, s.r)) {
        shade = Math.max(shade, s.opacity);
      }
    }
  }
  return shade;
}

/**
 * Fraction of an edge (0..1) that lies in shade, by sampling along its geometry.
 * @param coords [{lat,lon}, ...] the edge polyline
 */
export function edgeShadowFraction(coords, field, sampleSpacing = 8) {
  if (!field.valid) return 0; // no sun → nothing to avoid
  const pts = coords.map((c) => field.projector.project(c.lat, c.lon));
  const samples = samplePolyline(pts, sampleSpacing);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += shadeAt(s, field);
  return sum / samples.length;
}

function inBox(p, box) {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

// Uniform-grid spatial index over axis-aligned boxes.
class SpatialGrid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  _key(cx, cy) { return cx + ',' + cy; }
  insert(box, ref) {
    const c = this.cell;
    const x0 = Math.floor(box.minX / c), x1 = Math.floor(box.maxX / c);
    const y0 = Math.floor(box.minY / c), y1 = Math.floor(box.maxY / c);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = this._key(x, y);
        if (!this.map.has(k)) this.map.set(k, []);
        this.map.get(k).push(ref);
      }
  }
  query(px, py) {
    const c = this.cell;
    const k = this._key(Math.floor(px / c), Math.floor(py / c));
    return this.map.get(k) || EMPTY;
  }
}
const EMPTY = [];
