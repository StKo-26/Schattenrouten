// Build a routable pedestrian graph + shadow casters from raw Overpass JSON.
// Pure: given the elements array, returns plain data. Browser + Node.

import { haversine } from './geometry.js';

// Highway values a pedestrian may use. Motorways/trunks are excluded.
const WALKABLE = new Set([
  'footway', 'path', 'pedestrian', 'living_street', 'residential', 'service',
  'track', 'steps', 'cycleway', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'road', 'corridor',
  'platform', 'crossing', 'bridleway',
]);

/** Is a highway way walkable for a pedestrian? */
export function isWalkable(tags) {
  if (!tags || !tags.highway) return false;
  if (!WALKABLE.has(tags.highway)) return false;
  if (tags.foot === 'no' || tags.access === 'no' || tags.access === 'private') {
    // ...unless explicitly allowed for foot traffic.
    if (tags.foot !== 'yes' && tags.foot !== 'designated' && tags.foot !== 'permissive')
      return false;
  }
  return true;
}

/**
 * @param {Array} elements Overpass elements (nodes, ways).
 * @returns {{
 *   nodes: Map<number,{lat,lon}>,
 *   adjacency: Map<number, Array<{to:number,length:number,edgeId:number}>>,
 *   edges: Array<{id,a,b,length,tags,isSteps}>,
 *   buildings: Array<{id,ring:[{lat,lon}],tags}>,
 *   trees: Array<{id,lat,lon,tags}>
 * }}
 */
export function buildGraph(elements) {
  const nodeCoord = new Map();
  const nodeTags = new Map();
  const ways = [];
  const wayNodes = new Map(); // wayId -> [nodeId]
  const relations = [];

  for (const el of elements) {
    if (el.type === 'node') {
      nodeCoord.set(el.id, { lat: el.lat, lon: el.lon });
      if (el.tags) nodeTags.set(el.id, el.tags);
    } else if (el.type === 'way') {
      ways.push(el);
      wayNodes.set(el.id, el.nodes || []);
    } else if (el.type === 'relation') {
      relations.push(el);
    }
  }

  const adjacency = new Map();
  const edges = [];
  const usedNodes = new Map(); // nodes that are part of the walkable network
  let edgeId = 0;

  const addEdge = (a, b, length, tags, isSteps) => {
    const id = edgeId++;
    edges.push({ id, a, b, length, tags, isSteps });
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ to: b, length, edgeId: id });
    adjacency.get(b).push({ to: a, length, edgeId: id });
  };

  const buildings = [];
  const trees = [];

  for (const w of ways) {
    const tags = w.tags || {};
    const refs = w.nodes || [];
    if (isWalkable(tags)) {
      const isSteps = tags.highway === 'steps';
      for (let i = 1; i < refs.length; i++) {
        const a = refs[i - 1], b = refs[i];
        const ca = nodeCoord.get(a), cb = nodeCoord.get(b);
        if (!ca || !cb) continue;
        const length = haversine(ca, cb);
        if (length === 0) continue;
        addEdge(a, b, length, tags, isSteps);
        usedNodes.set(a, ca);
        usedNodes.set(b, cb);
      }
    } else if (tags.building || tags['building:part']) {
      const ring = refs.map((r) => nodeCoord.get(r)).filter(Boolean);
      if (ring.length >= 3) buildings.push({ id: w.id, ring, tags });
    }
  }

  // Building multipolygon relations (churches, courtyards, large halls) whose
  // outline is a relation, not a closed way. Stitch the outer member ways into rings.
  for (const rel of relations) {
    const tags = rel.tags || {};
    if (!tags.building) continue;
    const outer = (rel.members || [])
      .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''))
      .map((m) => wayNodes.get(m.ref))
      .filter((a) => a && a.length >= 2);
    for (const ringIds of assembleRings(outer)) {
      const ring = ringIds.map((r) => nodeCoord.get(r)).filter(Boolean);
      if (ring.length >= 3) buildings.push({ id: 'r' + rel.id, ring, tags });
    }
  }

  // Trees are nodes tagged natural=tree.
  for (const [id, t] of nodeTags) {
    if (t.natural === 'tree') {
      const c = nodeCoord.get(id);
      if (c) trees.push({ id, lat: c.lat, lon: c.lon, tags: t });
    }
  }

  return { nodes: usedNodes, adjacency, edges, buildings, trees };
}

/**
 * Stitch open way segments (arrays of node ids) into closed rings by matching
 * shared endpoints. Used to rebuild multipolygon building outlines.
 */
export function assembleRings(segments) {
  const segs = segments.map((a) => a.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let extended = true;
    while (extended && ring[0] !== ring[ring.length - 1]) {
      extended = false;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const head = ring[0], tail = ring[ring.length - 1];
        if (seg[0] === tail) { ring = ring.concat(seg.slice(1)); }
        else if (seg[seg.length - 1] === tail) { ring = ring.concat(seg.slice().reverse().slice(1)); }
        else if (seg[seg.length - 1] === head) { ring = seg.slice(0, -1).concat(ring); }
        else if (seg[0] === head) { ring = seg.slice().reverse().slice(0, -1).concat(ring); }
        else continue;
        segs.splice(i, 1); extended = true; break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

/** Find the graph node nearest to a {lat,lon}. Linear scan (fine for city-sized graphs). */
export function nearestNode(graph, lat, lon) {
  let best = null, bestD = Infinity;
  for (const [id, c] of graph.nodes) {
    const d = haversine({ lat, lon }, c);
    if (d < bestD) { bestD = d; best = id; }
  }
  return { id: best, distance: bestD };
}
