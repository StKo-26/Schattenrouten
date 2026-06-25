// Fetch the pedestrian network, building footprints and trees from OpenStreetMap
// via the Overpass API. Browser-only (uses fetch). Open data, no API key needed.

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Build the Overpass QL query for a bbox [south, west, north, east]. */
function buildQuery([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];
(
  way["highway"](${b});
  way["building"](${b});
  way["building:part"](${b});
  relation["building"](${b});
  node["natural"="tree"](${b});
);
(._;>;);
out body;`;
}

/** Rough area of a bbox in km² (for a "too large" guard). */
export function bboxAreaKm2([s, w, n, e]) {
  const midLat = (s + n) / 2;
  const h = (n - s) * 111.32;
  const wkm = (e - w) * 111.32 * Math.cos(midLat * Math.PI / 180);
  return Math.abs(h * wkm);
}

/**
 * @param bbox [south, west, north, east]
 * @param opts {signal, onStatus}
 * @returns Array of Overpass elements
 */
export async function fetchOsm(bbox, opts = {}) {
  const { signal, onStatus } = opts;
  const query = buildQuery(bbox);
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      onStatus?.(`Querying OpenStreetMap (${hostOf(url)})…`);
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      // Overpass signals overload/timeout with HTTP 200 + an empty body and a
      // `remark`. Treat that as an endpoint failure so the fallback loop runs.
      if (json.remark && /(timed out|runtime error|rate_?limited)/i.test(json.remark) &&
          (!json.elements || json.elements.length === 0)) {
        throw new Error('server busy: ' + json.remark);
      }
      if (!json.elements) throw new Error('no elements');
      return json.elements;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      onStatus?.(`Endpoint ${hostOf(url)} failed, trying another…`);
    }
  }
  throw new Error('All Overpass endpoints failed: ' + (lastErr?.message || 'unknown'));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
