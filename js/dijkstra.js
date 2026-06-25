// Dijkstra shortest path + alternative routes via the edge-penalty method.
// Pure, browser + Node.

// Minimal binary min-heap keyed by numeric priority.
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < a.length && a[l].k < a[s].k) s = l;
        if (r < a.length && a[r].k < a[s].k) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * Dijkstra over graph.adjacency.
 * @param graph  { adjacency: Map<id, [{to, length, edgeId}]> }
 * @param start  start node id
 * @param goal   goal node id
 * @param costFn (edgeRef, neighborId) => number   cost of traversing an edge
 * @param penalty optional Map<edgeId, multiplier> applied to costs
 * @returns {path:number[], edgeIds:number[], cost:number} | null
 */
export function dijkstra(graph, start, goal, costFn, penalty) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();      // node -> {from, edgeId}
  const visited = new Set();
  const heap = new MinHeap();
  heap.push({ k: 0, node: start });

  while (heap.size) {
    const { node } = heap.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === goal) break;

    const neighbors = graph.adjacency.get(node) || [];
    for (const e of neighbors) {
      if (visited.has(e.to)) continue;
      let c = costFn(e, node);
      if (penalty && penalty.has(e.edgeId)) c *= penalty.get(e.edgeId);
      const nd = dist.get(node) + c;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: node, edgeId: e.edgeId });
        heap.push({ k: nd, node: e.to });
      }
    }
  }

  if (!dist.has(goal)) return null;

  const path = [goal];
  const edgeIds = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) return null; // disconnected
    edgeIds.push(p.edgeId);
    cur = p.from;
    path.push(cur);
  }
  path.reverse();
  edgeIds.reverse();
  return { path, edgeIds, cost: dist.get(goal) };
}

/** Stable signature for a path so we can dedupe alternatives. */
function pathKey(edgeIds) {
  return edgeIds.join(',');
}

/**
 * Generate up to k distinct routes using the iterative edge-penalty method:
 * repeatedly inflate the cost of edges already used, forcing the router onto
 * fresh corridors.
 * @returns Array<{path, edgeIds, cost}>
 */
export function alternativeRoutes(graph, start, goal, costFn, k = 4, penaltyFactor = 2.5) {
  const results = [];
  const seen = new Set();
  const penalty = new Map();
  let consecutiveDup = 0;

  for (let i = 0; i < k * 5 && results.length < k && consecutiveDup < 3; i++) {
    const r = dijkstra(graph, start, goal, costFn, penalty);
    if (!r) break;
    const key = pathKey(r.edgeIds);
    if (seen.has(key)) {
      consecutiveDup++;
    } else {
      seen.add(key);
      results.push(r);
      consecutiveDup = 0;
    }
    // Inflate EVERY edge actually used (head and tail included) so the next run
    // is forced onto a different corridor. Penalizing only a central slice let
    // routes that diverge near the start/goal silently reproduce the same path.
    // Endpoints stay reachable because only on-route edges are inflated.
    for (const id of r.edgeIds) {
      penalty.set(id, (penalty.get(id) || 1) * penaltyFactor);
    }
  }
  return results;
}
