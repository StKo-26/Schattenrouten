// Address search / reverse geocoding via OpenStreetMap Nominatim. Browser-only.
// Biased toward Karlsruhe. Respect the usage policy: low volume, debounced.

const NOMINATIM = 'https://nominatim.openstreetmap.org';

// Karlsruhe viewbox (west, north, east, south) to bias results toward the city.
const KA_VIEWBOX = '8.27,49.10,8.55,48.94';

/** Search for an address/place. Returns [{label, lat, lon}]. */
export async function geocode(query, { signal } = {}) {
  if (!query || !query.trim()) return [];
  const url = new URL(NOMINATIM + '/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('viewbox', KA_VIEWBOX);
  url.searchParams.set('countrycodes', 'de');
  const res = await fetch(url, {
    signal,
    headers: { 'Accept-Language': 'de,en' },
  });
  if (!res.ok) throw new Error('Geocoding failed: HTTP ' + res.status);
  const data = await res.json();
  return data.map((d) => ({
    label: d.display_name,
    short: shortLabel(d),
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
  }));
}

/** Reverse geocode a coordinate to a human label. */
export async function reverseGeocode(lat, lon, { signal } = {}) {
  const url = new URL(NOMINATIM + '/reverse');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lon);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '18');
  try {
    const res = await fetch(url, { signal, headers: { 'Accept-Language': 'de,en' } });
    if (!res.ok) return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const d = await res.json();
    return shortLabel(d) || d.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  } catch {
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }
}

function shortLabel(d) {
  const a = d.address || {};
  const road = a.road || a.pedestrian || a.footway || a.neighbourhood || d.name;
  const num = a.house_number ? ' ' + a.house_number : '';
  const place = a.city || a.town || a.village || a.suburb || '';
  if (road) return `${road}${num}${place ? ', ' + place : ''}`;
  return d.display_name?.split(',').slice(0, 2).join(',') || '';
}
