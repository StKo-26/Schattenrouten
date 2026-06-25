// ShadeWalk real-math engine — browser global `window.ShadeEngine`.
// Real OSM buildings/trees (Overpass), NOAA sun position, and shadow projection.
// Derived from the unit-tested js/ modules; kept dependency-free so it can also
// be loaded in Node (with a fetch + minimal window shim) for tests.
(function (root) {
  'use strict';
  var DEG = Math.PI / 180, RAD = 180 / Math.PI;
  var LEVEL_H = 3.2, DEFAULT_BLD_H = 9, MAX_SHADOW_LEN = 200;

  function mod(a, n) { return ((a % n) + n) % n; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* ---------------- sun (NOAA) ---------------- */
  function sunPosition(date, latDeg, lonDeg) {
    var jd = date.getTime() / 86400000 + 2440587.5;
    var t = (jd - 2451545.0) / 36525.0;
    var L0 = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
    var M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    var e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    var C = Math.sin(M * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
      Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * t) +
      Math.sin(3 * M * DEG) * 0.000289;
    var appLong = L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG);
    var meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    var obliq = meanObliq + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG);
    var decl = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG)) * RAD;
    var varY = Math.pow(Math.tan((obliq / 2) * DEG), 2);
    var eot = 4 * RAD * (varY * Math.sin(2 * L0 * DEG) - 2 * e * Math.sin(M * DEG) +
      4 * e * varY * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG) -
      0.5 * varY * varY * Math.sin(4 * L0 * DEG) - 1.25 * e * e * Math.sin(2 * M * DEG));
    var utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    var tst = mod(utcMin + eot + 4 * lonDeg, 1440);
    var ha = tst / 4 - 180;
    var latR = latDeg * DEG, declR = decl * DEG, haR = ha * DEG;
    var cosZ = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR);
    var zen = Math.acos(clamp(cosZ, -1, 1));
    var elev = 90 - zen * RAD;
    var denom = Math.cos(latR) * Math.sin(zen), az;
    if (Math.abs(denom) < 1e-9) az = elev > 0 ? 180 : 0;
    else {
      var cosAz = clamp((Math.sin(latR) * Math.cos(zen) - Math.sin(declR)) / denom, -1, 1);
      var ac = Math.acos(cosAz) * RAD;
      az = ha > 0 ? mod(ac + 180, 360) : mod(540 - ac, 360);
    }
    return { elevationDeg: elev, azimuthDeg: az, altitudeRad: elev * DEG };
  }

  /* ---------------- geometry ---------------- */
  function haversine(a, b) {
    var R = 6371000, r = DEG;
    var dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    var la1 = a.lat * r, la2 = b.lat * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function makeProjector(lat0, lon0) {
    var mLat = 111320, mLon = 111320 * Math.cos(lat0 * DEG);
    return {
      project: function (lat, lon) { return { x: (lon - lon0) * mLon, y: (lat - lat0) * mLat }; },
      unproject: function (x, y) { return { lat: lat0 + y / mLat, lon: lon0 + x / mLon }; },
    };
  }
  function pointInPolygon(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInDisk(p, c, r) { var dx = p.x - c.x, dy = p.y - c.y; return dx * dx + dy * dy <= r * r; }
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
    var cross = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lo = [], i, pt;
    for (i = 0; i < p.length; i++) { pt = p[i]; while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], pt) <= 0) lo.pop(); lo.push(pt); }
    var up = [];
    for (i = p.length - 1; i >= 0; i--) { pt = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], pt) <= 0) up.pop(); up.push(pt); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function bboxOf(pts) {
    var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < mnX) mnX = p.x; if (p.y < mnY) mnY = p.y;
      if (p.x > mxX) mxX = p.x; if (p.y > mxY) mxY = p.y;
    }
    return { minX: mnX, minY: mnY, maxX: mxX, maxY: mxY };
  }
  function samplePolyline(pts, spacing) {
    if (!pts.length) return [];
    if (pts.length === 1) return [pts[0]];
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y;
      var steps = Math.max(1, Math.round(Math.hypot(dx, dy) / spacing));
      for (var s = 1; s <= steps; s++) { var tt = s / steps; out.push({ x: a.x + dx * tt, y: a.y + dy * tt }); }
    }
    return out;
  }

  /* ---------------- height / leaf estimation ---------------- */
  function buildingHeight(tags) {
    tags = tags || {};
    if (tags.height) { var h = parseFloat(String(tags.height).replace(',', '.')); if (isFinite(h) && h > 0) return h; }
    if (tags['building:levels']) { var lv = parseFloat(String(tags['building:levels']).replace(',', '.')); if (isFinite(lv) && lv > 0) return lv * LEVEL_H + 1; }
    var b = tags.building;
    if (b === 'church' || b === 'cathedral') return 20;
    if (b === 'commercial' || b === 'retail' || b === 'office') return 12;
    if (b === 'apartments') return 15;
    if (b === 'house' || b === 'detached' || b === 'garage' || b === 'hut' || b === 'shed') return 6;
    return DEFAULT_BLD_H;
  }
  function treeProps(tags, month) {
    tags = tags || {};
    var height = 9, h;
    if (tags.height) { h = parseFloat(String(tags.height).replace(',', '.')); if (isFinite(h) && h > 0) height = h; }
    else if (tags['est_height']) { h = parseFloat(String(tags['est_height']).replace(',', '.')); if (isFinite(h) && h > 0) height = h; }
    var crownR = 3.5;
    if (tags['diameter_crown']) { var d = parseFloat(String(tags['diameter_crown']).replace(',', '.')); if (isFinite(d) && d > 0) crownR = d / 2; }
    else crownR = Math.max(2, height * 0.35);
    var leafType = tags.leaf_type;
    var evergreen = leafType === 'needleleaved' || tags.leaf_cycle === 'evergreen';
    var density = leafType === 'needleleaved' ? 0.85 : 0.7;
    if (!evergreen) {
      var leafOn = [0.05, 0.05, 0.15, 0.5, 0.85, 1, 1, 1, 0.9, 0.6, 0.2, 0.05];
      density *= leafOn[((month - 1) % 12 + 12) % 12];
    }
    return { height: height, crownR: crownR, density: density };
  }

  /* ---------------- spatial grid ---------------- */
  function SpatialGrid(cell) { this.cell = cell; this.map = new Map(); }
  SpatialGrid.prototype.insert = function (box, ref) {
    var c = this.cell, x0 = Math.floor(box.minX / c), x1 = Math.floor(box.maxX / c);
    var y0 = Math.floor(box.minY / c), y1 = Math.floor(box.maxY / c);
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var k = x + ',' + y; var a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); } a.push(ref);
    }
  };
  SpatialGrid.prototype.query = function (px, py) {
    var c = this.cell; return this.map.get(Math.floor(px / c) + ',' + Math.floor(py / c)) || [];
  };

  /* ---------------- multipolygon ring assembly ---------------- */
  function assembleRings(segments) {
    var segs = segments.map(function (a) { return a.slice(); }), rings = [];
    while (segs.length) {
      var ring = segs.shift(), extended = true;
      while (extended && ring[0] !== ring[ring.length - 1]) {
        extended = false;
        for (var i = 0; i < segs.length; i++) {
          var seg = segs[i], head = ring[0], tail = ring[ring.length - 1];
          if (seg[0] === tail) ring = ring.concat(seg.slice(1));
          else if (seg[seg.length - 1] === tail) ring = ring.concat(seg.slice().reverse().slice(1));
          else if (seg[seg.length - 1] === head) ring = seg.slice(0, -1).concat(ring);
          else if (seg[0] === head) ring = seg.slice().reverse().slice(0, -1).concat(ring);
          else continue;
          segs.splice(i, 1); extended = true; break;
        }
      }
      rings.push(ring);
    }
    return rings;
  }

  /* ---------------- Overpass: buildings + trees only (light & fast) ---------------- */
  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  function fetchBuildingsTrees(bbox, opts) {
    opts = opts || {};
    var b = bbox[0] + ',' + bbox[1] + ',' + bbox[2] + ',' + bbox[3];
    var q = '[out:json][timeout:40];(way["building"](' + b + ');relation["building"](' + b +
      ');node["natural"="tree"](' + b + '););(._;>;);out body;';
    var i = 0;
    function tryNext() {
      if (i >= ENDPOINTS.length) return Promise.reject(new Error('overpass unavailable'));
      var url = ENDPOINTS[i++];
      if (opts.onStatus) opts.onStatus(url);
      return fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: opts.signal,
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) {
          if (j.remark && /(timed out|runtime error|rate_?limited)/i.test(j.remark) && (!j.elements || !j.elements.length)) throw new Error(j.remark);
          if (!j.elements) throw new Error('no elements');
          return parseOsm(j.elements, opts.month || 6);
        })
        .catch(function (err) { if (err.name === 'AbortError') throw err; return tryNext(); });
    }
    return tryNext();
  }
  function parseOsm(elements, month) {
    var coord = new Map(), wayNodes = new Map(), ways = [], rels = [], tags = new Map(), i, el;
    for (i = 0; i < elements.length; i++) {
      el = elements[i];
      if (el.type === 'node') { coord.set(el.id, { lat: el.lat, lon: el.lon }); if (el.tags) tags.set(el.id, el.tags); }
      else if (el.type === 'way') { ways.push(el); wayNodes.set(el.id, el.nodes || []); }
      else if (el.type === 'relation') rels.push(el);
    }
    var buildings = [];
    for (i = 0; i < ways.length; i++) {
      var w = ways[i], wt = w.tags || {};
      if (!(wt.building || wt['building:part'])) continue;
      var ring = (w.nodes || []).map(function (r) { return coord.get(r); }).filter(Boolean);
      if (ring.length >= 3) buildings.push({ ring: ring, h: buildingHeight(wt), tags: wt });
    }
    for (i = 0; i < rels.length; i++) {
      var rel = rels[i], rt = rel.tags || {};
      if (!rt.building) continue;
      var outer = (rel.members || []).filter(function (m) { return m.type === 'way' && (m.role === 'outer' || m.role === ''); })
        .map(function (m) { return wayNodes.get(m.ref); }).filter(function (a) { return a && a.length >= 2; });
      var rings = assembleRings(outer);
      for (var k = 0; k < rings.length; k++) {
        var rr = rings[k].map(function (r) { return coord.get(r); }).filter(Boolean);
        if (rr.length >= 3) buildings.push({ ring: rr, h: buildingHeight(rt), tags: rt });
      }
    }
    var trees = [];
    tags.forEach(function (t, id) {
      if (t.natural === 'tree') { var c = coord.get(id); if (c) { var tp = treeProps(t, month); trees.push({ lat: c.lat, lon: c.lon, h: tp.height, crownR: tp.crownR, density: tp.density }); } }
    });
    return { buildings: buildings, trees: trees };
  }

  /* ---------------- shadow field ---------------- */
  function buildField(buildings, trees, sun, lat0, lon0, month) {
    var proj = makeProjector(lat0, lon0);
    var valid = sun.elevationDeg > 0.5;
    var elevRad = Math.max(sun.elevationDeg, 0.5) * DEG;
    var bearing = (sun.azimuthDeg + 180) * DEG;
    var su = { x: Math.sin(bearing), y: Math.cos(bearing) };
    var lenFor = function (h) { return Math.min(MAX_SHADOW_LEN, h / Math.tan(elevRad)); };

    var bShadows = [], buildingsLatLng = [], i;
    for (i = 0; i < buildings.length; i++) {
      var bd = buildings[i];
      var base = bd.ring.map(function (p) { return proj.project(p.lat, p.lon); });
      var foot = base.map(function (p) { var ll = proj.unproject(p.x, p.y); return [ll.lat, ll.lon]; });
      var shadowLL = null, poly = null;
      if (valid) {
        var L = lenFor(bd.h);
        var shifted = base.map(function (p) { return { x: p.x + su.x * L, y: p.y + su.y * L }; });
        poly = convexHull(base.concat(shifted));
        if (poly.length >= 3) {
          bShadows.push({ poly: poly, box: bboxOf(poly) });
          shadowLL = poly.map(function (p) { var ll = proj.unproject(p.x, p.y); return [ll.lat, ll.lon]; });
        }
      }
      buildingsLatLng.push({ footprint: foot, shadow: shadowLL, h: bd.h, center: centroidLL(bd.ring) });
    }

    var tShadows = [], treesLatLng = [];
    for (i = 0; i < trees.length; i++) {
      var t = trees[i];
      if (t.density <= 0.02) continue;
      var tpos = proj.project(t.lat, t.lon), shLL = null;
      if (valid) {
        var TL = lenFor(t.h * 0.7);
        var c = { x: tpos.x + su.x * TL, y: tpos.y + su.y * TL };
        tShadows.push({ c: c, r: t.crownR, opacity: t.density, box: { minX: c.x - t.crownR, minY: c.y - t.crownR, maxX: c.x + t.crownR, maxY: c.y + t.crownR } });
        var sc = proj.unproject(c.x, c.y); shLL = { center: [sc.lat, sc.lon], r: t.crownR };
      }
      treesLatLng.push({ center: [t.lat, t.lon], crownR: t.crownR, shadow: shLL, h: t.h, density: t.density });
    }

    var grid = new SpatialGrid(40);
    bShadows.forEach(function (s, idx) { grid.insert(s.box, { type: 'b', i: idx }); });
    tShadows.forEach(function (s, idx) { grid.insert(s.box, { type: 't', i: idx }); });

    function inBox(p, box) { return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY; }
    function shadeAtM(p) {
      var refs = grid.query(p.x, p.y), shade = 0;
      for (var j = 0; j < refs.length; j++) {
        var ref = refs[j];
        if (ref.type === 'b') { var s = bShadows[ref.i]; if (inBox(p, s.box) && pointInPolygon(p, s.poly)) return 1; }
        else { var st = tShadows[ref.i]; if (inBox(p, st.box) && pointInDisk(p, st.c, st.r)) shade = Math.max(shade, st.opacity); }
      }
      return shade;
    }
    function shadeFractionOfRoute(coords) {
      if (!valid) return 0;
      var pts = coords.map(function (c) { return proj.project(c[0], c[1]); });
      var samples = samplePolyline(pts, 8);
      if (!samples.length) return 0;
      var sum = 0; for (var j = 0; j < samples.length; j++) sum += shadeAtM(samples[j]);
      return sum / samples.length;
    }

    return {
      valid: valid, projector: proj, shadowUnit: su,
      buildingsLatLng: buildingsLatLng, treesLatLng: treesLatLng,
      shadeFractionOfRoute: shadeFractionOfRoute,
      shadeAtLatLng: function (lat, lng) { return shadeAtM(proj.project(lat, lng)); },
    };
  }
  function centroidLL(ring) {
    var lat = 0, lon = 0; for (var i = 0; i < ring.length; i++) { lat += ring[i].lat; lon += ring[i].lon; }
    return [lat / ring.length, lon / ring.length];
  }

  root.ShadeEngine = {
    sunPosition: sunPosition,
    fetchBuildingsTrees: fetchBuildingsTrees,
    buildField: buildField,
    buildingHeight: buildingHeight,
    treeProps: treeProps,
    haversine: haversine,
  };
})(typeof window !== 'undefined' ? window : globalThis);
