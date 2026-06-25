// Orchestrates shade-aware routing: builds candidate routes, scores them by the
// user's time-vs-shadow preference, and picks the best. Pure, browser + Node.

import { dijkstra, alternativeRoutes } from './dijkstra.js';
import { edgeShadowFraction } from './shadow.js';

// How far out of the way the router will go to chase shade at full shadow weight.
// A fully sun-exposed segment costs up to (1 + DETOUR_TOLERANCE) times its length.
const DETOUR_TOLERANCE = 4;
// A detour this much longer (in effort-time) than the shortest route counts as a
// "full" time cost (normTime = 1) when scoring. 1.0 = twice as long.
const DETOUR_CAP = 1.0;

/**
 * @param graph   from buildGraph()
 * @param field   from buildShadowField()
 * @param startNode / goalNode  node ids (snap with nearestNode first)
 * @param opts {shadowWeight 0..1, walkSpeedMps, avoidStairs, alternatives}
 */
export function computeRoutes(graph, field, startNode, goalNode, opts = {}) {
  const {
    shadowWeight = 0.5,
    walkSpeedMps = 1.1, // ~4 km/h, a comfortable pace for elderly / with a stroller
    avoidStairs = false,
    alternatives = 4,
  } = opts;

  const stairsFactor = avoidStairs ? 8 : 1.5;

  // Per-edge shadow fraction, computed once and cached.
  const shadowOf = new Map();
  const sunExposure = (edge) => {
    let f = shadowOf.get(edge.id);
    if (f === undefined) {
      const ca = graph.nodes.get(edge.a);
      const cb = graph.nodes.get(edge.b);
      f = ca && cb ? edgeShadowFraction([ca, cb], field) : 0;
      shadowOf.set(edge.id, f);
    }
    return 1 - f; // 0 = fully shaded, 1 = full sun
  };

  const edgeOf = (ref) => graph.edges[ref.edgeId];

  const timeCost = (ref) => {
    const e = edgeOf(ref);
    return e.length * (e.isSteps ? stairsFactor : 1);
  };
  const weightedCost = (w) => (ref) => {
    const e = edgeOf(ref);
    const base = e.length * (e.isSteps ? stairsFactor : 1);
    return base * (1 + DETOUR_TOLERANCE * w * sunExposure(e));
  };

  const metric = (r, label) => {
    let distance = 0, shadeLen = 0, stairs = 0, effortDist = 0;
    const coords = [];
    for (const id of r.path) coords.push(graph.nodes.get(id));
    for (const eid of r.edgeIds) {
      const e = graph.edges[eid];
      distance += e.length;
      effortDist += e.length * (e.isSteps ? stairsFactor : 1); // stairs cost extra effort
      shadeLen += e.length * (1 - sunExposure(e)); // length * shadowFraction
      if (e.isSteps) stairs += e.length;
    }
    return {
      label,
      path: r.path,
      edgeIds: r.edgeIds,
      coords,
      distance,
      timeSec: distance / walkSpeedMps,        // real walking time (for display)
      effortSec: effortDist / walkSpeedMps,    // stairs-weighted, for ranking
      avgShadow: distance > 0 ? shadeLen / distance : 0,
      stairsLen: stairs,
    };
  };

  // Candidate routes.
  const raw = [];
  const shortest = dijkstra(graph, startNode, goalNode, timeCost);
  if (shortest) raw.push(metric(shortest, 'Shortest'));

  const shadiest = dijkstra(graph, startNode, goalNode, weightedCost(1));
  if (shadiest) raw.push(metric(shadiest, 'Shadiest'));

  const weighted = dijkstra(graph, startNode, goalNode, weightedCost(shadowWeight));
  if (weighted) raw.push(metric(weighted, 'Balanced'));

  for (const alt of alternativeRoutes(graph, startNode, goalNode, weightedCost(shadowWeight), alternatives))
    raw.push(metric(alt, 'Alternative'));

  // Dedupe by path signature.
  const seen = new Set();
  const candidates = [];
  for (const c of raw) {
    const key = c.edgeIds.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }
  if (candidates.length === 0) return null;

  // Score each candidate by the slider preference and pick the best.
  scoreCandidates(candidates, shadowWeight);
  const ranked = candidates.slice().sort((a, b) => a.score - b.score);
  const recommended = ranked[0];

  return {
    recommended,
    candidates: ranked,
    shortest: candidates.find((c) => c.label === 'Shortest') || null,
    shadiest: candidates.find((c) => c.label === 'Shadiest') || null,
    sunValid: field.valid,
  };
}

/**
 * Assign a 0..1 score to each candidate (lower = better) given the shadow weight.
 * The time term is the *relative detour* over the fastest candidate (so the slider
 * reflects how much extra time the shade actually costs), and it uses effort-time
 * which includes the stairs penalty — so an "avoid stairs" route is genuinely
 * preferred at ranking, not only inside Dijkstra.
 */
function scoreCandidates(candidates, w) {
  let tRef = Infinity;
  for (const c of candidates) if (c.effortSec < tRef) tRef = c.effortSec;
  for (const c of candidates) {
    const detour = tRef > 0 ? (c.effortSec - tRef) / tRef : 0; // 0 = no detour
    const normTime = Math.min(1, detour / DETOUR_CAP);
    const sun = 1 - c.avgShadow; // 0 = fully shaded
    c.score = (1 - w) * normTime + w * sun;
    c.normTime = normTime;
  }
}
