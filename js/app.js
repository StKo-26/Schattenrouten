// Main controller: map, UI, and the shade-aware routing pipeline. Browser only.
import { sunPosition } from './solar.js';
import { fetchOsm, bboxAreaKm2 } from './overpass.js';
import { geocode, reverseGeocode } from './geocode.js';
import { buildGraph, nearestNode } from './graph.js';
import { buildShadowField } from './shadow.js';
import { computeRoutes } from './routing.js';

const KA_CENTER = [49.0094, 8.4044]; // Karlsruhe Marktplatz
const PRESETS = {
  'hbf-schloss': [
    { label: 'Karlsruhe Hauptbahnhof', lat: 48.9939, lon: 8.4017 },
    { label: 'Karlsruher Schloss', lat: 49.0136, lon: 8.4044 },
  ],
  'kit-markt': [
    { label: 'KIT Campus Süd', lat: 49.0119, lon: 8.4170 },
    { label: 'Marktplatz Karlsruhe', lat: 49.0094, lon: 8.4044 },
  ],
  'europa-zoo': [
    { label: 'Europaplatz', lat: 49.0096, lon: 8.3960 },
    { label: 'Zoologischer Stadtgarten', lat: 48.9962, lon: 8.4012 },
  ],
};

const state = {
  map: null,
  start: null, // {lat, lon, label}
  end: null,
  markers: { start: null, end: null },
  pickMode: null,
  routeLayer: null,    // L.layerGroup of candidate polylines
  shadowLayer: null,
  entries: [],         // [{route, layer, baseStyle}]
  osmCache: new Map(), // bboxKey -> elements
  lastField: null,     // last computed shadow field (for re-drawing the overlay)
  geoCtrl: { start: null, end: null }, // in-flight reverse-geocode controllers
};

// ---------------------------------------------------------------- map
function initMap() {
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(KA_CENTER, 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  map.on('click', onMapClick);
  state.map = map;
  state.routeLayer = L.layerGroup().addTo(map);
  state.shadowLayer = L.layerGroup().addTo(map);
}

function markerIcon(kind) {
  return L.divIcon({
    className: `leaflet-marker-${kind}`,
    html: kind === 'start' ? '🟢' : '🏁',
    iconSize: [28, 28],
    iconAnchor: [14, 26],
  });
}

function setEndpoint(which, lat, lon, label) {
  state[which] = { lat, lon, label: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  const input = document.getElementById(`${which}-input`);
  if (label) input.value = label;

  if (state.markers[which]) {
    state.markers[which].setLatLng([lat, lon]);
  } else {
    const m = L.marker([lat, lon], {
      icon: markerIcon(which), draggable: true, autoPan: true,
    }).addTo(state.map);
    m.on('dragend', () => {
      const ll = m.getLatLng();
      state[which] = { lat: ll.lat, lon: ll.lng, label: 'Locating…' };
      input.value = 'Locating…';
      fillReverseLabel(which, ll.lat, ll.lng);
    });
    state.markers[which] = m;
  }
}

// Reverse-geocode a point and write the label, ignoring stale responses so a
// fast drag/click sequence can't overwrite the final position's label.
async function fillReverseLabel(which, lat, lon) {
  state.geoCtrl[which]?.abort();
  const ctrl = new AbortController();
  state.geoCtrl[which] = ctrl;
  const name = await reverseGeocode(lat, lon, { signal: ctrl.signal }).catch(() => null);
  if (ctrl !== state.geoCtrl[which] || name == null || !state[which]) return; // superseded
  state[which].label = name;
  document.getElementById(`${which}-input`).value = name;
}

function onMapClick(e) {
  if (!state.pickMode) return;
  const which = state.pickMode;
  setPickMode(null);
  const { lat, lng } = e.latlng;
  setEndpoint(which, lat, lng, 'Locating…');
  fillReverseLabel(which, lat, lng);
}

function setPickMode(mode) {
  state.pickMode = mode;
  document.querySelectorAll('.pin-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.pick === mode));
  const hint = document.getElementById('pick-hint');
  if (mode) {
    hint.hidden = false;
    hint.textContent = `Tap the map to set the ${mode === 'start' ? 'start' : 'destination'}`;
  } else {
    hint.hidden = true;
  }
}

// ---------------------------------------------------------------- geocode autocomplete
function wireAutocomplete(which) {
  const input = document.getElementById(`${which}-input`);
  const box = document.getElementById(`${which}-suggest`);
  let timer = null, ctrl = null, activeIndex = -1;

  const options = () => Array.from(box.querySelectorAll('button'));
  const setActive = (i) => {
    const opts = options();
    if (!opts.length) return;
    activeIndex = (i + opts.length) % opts.length;
    opts.forEach((o, k) => {
      const on = k === activeIndex;
      o.classList.toggle('active', on);
      o.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) { input.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); }
    });
  };
  const close = () => {
    box.hidden = true; activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  box._close = close; // used by renderSuggestions on selection

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const results = await geocode(q, { signal: ctrl.signal });
        renderSuggestions(which, results);
        activeIndex = -1;
        input.setAttribute('aria-expanded', results.length ? 'true' : 'false');
      } catch (err) {
        if (err.name !== 'AbortError') close();
      }
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      const opts = options();
      if (opts.length) { e.preventDefault(); (opts[activeIndex] || opts[0]).click(); }
    } else if (e.key === 'Escape') { close(); input.focus(); }
  });

  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && e.target !== input) close();
  });
}

function renderSuggestions(which, results) {
  const box = document.getElementById(`${which}-suggest`);
  box.innerHTML = '';
  if (!results.length) { box.hidden = true; return; }
  results.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `${which}-opt-${i}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = r.short || r.label;
    btn.title = r.label;
    btn.addEventListener('click', () => {
      setEndpoint(which, r.lat, r.lon, r.short || r.label);
      box._close?.();
      fitToEndpoints();
    });
    box.appendChild(btn);
  });
  box.hidden = false;
}

function fitToEndpoints() {
  if (state.start && state.end) {
    state.map.fitBounds(
      [[state.start.lat, state.start.lon], [state.end.lat, state.end.lon]],
      { padding: [60, 60] }
    );
  } else if (state.start) {
    state.map.setView([state.start.lat, state.start.lon], 15);
  } else if (state.end) {
    state.map.setView([state.end.lat, state.end.lon], 15);
  }
}

// ---------------------------------------------------------------- sun / UI helpers
function currentDate() {
  const v = document.getElementById('datetime').value;
  const d = v ? new Date(v) : new Date();
  return isNaN(d) ? new Date() : d;
}

function sunCenter() {
  if (state.start && state.end)
    return { lat: (state.start.lat + state.end.lat) / 2, lon: (state.start.lon + state.end.lon) / 2 };
  return { lat: KA_CENTER[0], lon: KA_CENTER[1] };
}

function updateSunInfo() {
  const c = sunCenter();
  const sun = sunPosition(currentDate(), c.lat, c.lon);
  const el = document.getElementById('sun-info');
  if (sun.elevationDeg <= 0.5) {
    el.innerHTML = '🌙 Sun is below the horizon — no shade differences right now.';
  } else {
    el.innerHTML = `☀️ Sun ${sun.elevationDeg.toFixed(0)}° high, from the ${compass(sun.azimuthDeg)} (${sun.azimuthDeg.toFixed(0)}°).`;
  }
}

function compass(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function updateWeightLabel() {
  const w = +document.getElementById('weight').value;
  const labels = [[15, 'Fastest'], [40, 'Prefer speed'], [60, 'Balanced'], [85, 'Prefer shade'], [101, 'Most shade']];
  document.getElementById('weight-label').textContent =
    labels.find(([t]) => w < t)[1];
}

// ---------------------------------------------------------------- routing pipeline
function status(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function computeBbox(a, b) {
  let s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
  let w = Math.min(a.lon, b.lon), e = Math.max(a.lon, b.lon);
  const padLat = Math.max((n - s) * 0.35, 0.0045);
  const padLon = Math.max((e - w) * 0.35, 0.0065);
  return [s - padLat, w - padLon, n + padLat, e + padLon];
}

async function findRoute() {
  if (!state.start || !state.end) {
    status('Please set both a start and a destination.', true);
    return;
  }
  const btn = document.getElementById('find');
  btn.disabled = true;
  clearRoutes();
  try {
    const bbox = computeBbox(state.start, state.end);
    const area = bboxAreaKm2(bbox);
    if (area > 60) {
      status(`That route spans ~${area.toFixed(0)} km² — too large to analyse in the browser. Pick closer points.`, true);
      btn.disabled = false; return;
    }

    const key = bbox.map((x) => x.toFixed(4)).join(',');
    let elements = state.osmCache.get(key);
    if (!elements) {
      elements = await fetchOsm(bbox, { onStatus: status });
      if (elements.length) state.osmCache.set(key, elements); // never cache an empty/failed result
    }
    status('Building the walking network…');
    await yieldUI();
    const graph = buildGraph(elements);
    if (graph.edges.length === 0) throw new Error('No walkable paths found in this area.');

    const snapStart = nearestNode(graph, state.start.lat, state.start.lon);
    const snapEnd = nearestNode(graph, state.end.lat, state.end.lon);
    if (!snapStart.id || !snapEnd.id) throw new Error('Could not snap points to the path network.');

    const date = currentDate();
    const c = sunCenter();
    const sun = sunPosition(date, c.lat, c.lon);
    status(`Estimating shadows from ${graph.buildings.length} buildings and ${graph.trees.length} trees…`);
    await yieldUI();
    const field = buildShadowField(
      graph.buildings, graph.trees, sun, c.lat, c.lon, date.getMonth() + 1
    );

    const result = computeRoutes(graph, field, snapStart.id, snapEnd.id, {
      shadowWeight: +document.getElementById('weight').value / 100,
      walkSpeedMps: +document.getElementById('pace').value,
      avoidStairs: document.getElementById('avoid-stairs').checked,
      alternatives: 4,
    });
    if (!result) throw new Error('No route found between these points.');

    renderResult(result, field);
    if (!result.sunValid) {
      status('Sun is below the horizon — showing the fastest route (no shade to optimise).');
    } else {
      status(`Done — compared ${result.candidates.length} routes.`);
    }
  } catch (err) {
    console.error(err);
    status(err.message || 'Something went wrong.', true);
  } finally {
    btn.disabled = false;
  }
}

const PALETTE = {
  recommended: { color: '#1f6f54', weight: 8, opacity: 0.95 },
  shortest: { color: '#e8a13a', weight: 5, opacity: 0.9, dashArray: '2 9' },
  other: { color: '#7c8a84', weight: 4, opacity: 0.7 },
};

function clearRoutes() {
  state.routeLayer.clearLayers();
  state.shadowLayer.clearLayers();
  state.entries = [];
  document.getElementById('results').innerHTML = '';
}

function styleFor(route, isRecommended) {
  if (isRecommended) return PALETTE.recommended;
  if (route.label === 'Shortest') return PALETTE.shortest;
  return PALETTE.other;
}

function renderResult(result, field) {
  clearRoutes();
  state.lastField = field;
  refreshShadows();

  const rec = result.recommended;
  // Draw non-recommended first so the recommended sits on top.
  const ordered = result.candidates.slice().sort((a, b) => (a === rec ? 1 : 0) - (b === rec ? 1 : 0));
  for (const route of ordered) {
    const isRec = route === rec;
    const base = styleFor(route, isRec);
    const layer = L.polyline(route.coords.map((c) => [c.lat, c.lon]), base).addTo(state.routeLayer);
    const entry = { route, layer, base };
    layer.on('click', () => selectEntry(entry));
    state.entries.push(entry);
  }

  renderCards(result);
  const all = result.candidates.flatMap((r) => r.coords.map((c) => [c.lat, c.lon]));
  if (all.length) state.map.fitBounds(all, { padding: [50, 50] });
}

function renderCards(result) {
  const wrap = document.getElementById('results');
  wrap.innerHTML = '';
  const rec = result.recommended;
  // Show recommended first, then the rest, deduped by label preference.
  const list = [rec, ...result.candidates.filter((c) => c !== rec)];
  for (const route of list) {
    const isRec = route === rec;
    const style = styleFor(route, isRec);
    const card = document.createElement('div');
    card.className = 'route-card' + (isRec ? ' recommended active' : '');
    card.innerHTML = `
      <div class="route-head">
        <span class="route-swatch" style="background:${style.color}"></span>
        <span class="route-title">${isRec ? 'Recommended' : route.label}</span>
        ${isRec ? '<span class="route-badge">most shade for your setting</span>' : ''}
      </div>
      <div class="route-stats">
        <span><b>${fmtTime(route.timeSec)}</b></span>
        <span><b>${fmtDist(route.distance)}</b></span>
        <span>☂ <b>${Math.round(route.avgShadow * 100)}%</b> shaded</span>
        ${route.stairsLen > 1 ? `<span>🪜 ${Math.round(route.stairsLen)} m steps</span>` : ''}
      </div>
      <div class="shade-bar"><div class="shade-fill" style="width:${Math.round(route.avgShadow * 100)}%"></div></div>
    `;
    const entry = state.entries.find((e) => e.route === route);
    card.addEventListener('click', () => entry && selectEntry(entry));
    wrap.appendChild(card);
    if (entry) entry.card = card;
  }
}

function selectEntry(entry) {
  for (const e of state.entries) {
    e.layer.setStyle(e.base);
    e.card?.classList.remove('active');
  }
  entry.layer.setStyle({ ...entry.base, weight: entry.base.weight + 3, opacity: 1 });
  entry.layer.bringToFront();
  entry.card?.classList.add('active');
  entry.card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Redraw the shadow overlay to match the checkbox + current viewport.
function refreshShadows() {
  state.shadowLayer.clearLayers();
  if (document.getElementById('show-shadows').checked && state.lastField && state.lastField.valid) {
    renderShadows(state.lastField);
  }
}

function renderShadows(field) {
  const bounds = state.map.getBounds();
  const inView = (latlon) => bounds.contains(latlon);
  let drawn = 0;
  const CAP = 3000;
  for (const s of field.buildingShadows) {
    if (drawn >= CAP) break;
    const ring = s.poly.map((p) => {
      const ll = field.projector.unproject(p.x, p.y);
      return [ll.lat, ll.lon];
    });
    if (!ring.some((ll) => inView(ll))) continue;
    L.polygon(ring, { stroke: false, fillColor: '#33415c', fillOpacity: 0.16 }).addTo(state.shadowLayer);
    drawn++;
  }
  for (const s of field.treeShadows) {
    if (drawn >= CAP) break;
    const ll = field.projector.unproject(s.c.x, s.c.y);
    if (!inView([ll.lat, ll.lon])) continue;
    L.circle([ll.lat, ll.lon], { radius: s.r, stroke: false, fillColor: '#2e7d32', fillOpacity: 0.14 * s.opacity + 0.06 }).addTo(state.shadowLayer);
    drawn++;
  }
}

// ---------------------------------------------------------------- formatting
function fmtTime(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtDist(m) {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
function yieldUI() {
  return new Promise((r) => setTimeout(r, 16));
}

// ---------------------------------------------------------------- init / events
function defaultDatetime() {
  const d = new Date();
  d.setHours(14, 0, 0, 0); // 2 pm: strong, well-defined shadows
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function init() {
  initMap();
  document.getElementById('datetime').value = defaultDatetime();
  updateSunInfo();
  updateWeightLabel();

  wireAutocomplete('start');
  wireAutocomplete('end');

  document.querySelectorAll('.pin-btn').forEach((b) =>
    b.addEventListener('click', () => setPickMode(state.pickMode === b.dataset.pick ? null : b.dataset.pick)));

  document.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => {
      const [a, c] = PRESETS[b.dataset.preset];
      setEndpoint('start', a.lat, a.lon, a.label);
      setEndpoint('end', c.lat, c.lon, c.label);
      fitToEndpoints();
      updateSunInfo();
    }));

  document.getElementById('weight').addEventListener('input', updateWeightLabel);
  document.getElementById('datetime').addEventListener('input', updateSunInfo);
  document.getElementById('find').addEventListener('click', findRoute);
  document.getElementById('show-shadows').addEventListener('change', refreshShadows);

  // Re-fill panned-in shadows while the overlay is on.
  state.map.on('moveend', () => {
    if (document.getElementById('show-shadows').checked) refreshShadows();
  });

  const toggleBtn = document.getElementById('panel-toggle');
  toggleBtn.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.setAttribute('aria-label', collapsed ? 'Expand options' : 'Collapse options');
    toggleBtn.title = collapsed ? 'Expand' : 'Collapse';
    toggleBtn.textContent = collapsed ? '▴' : '▾';
    setTimeout(() => state.map.invalidateSize(), 250);
  });

  // Keep the Leaflet map correctly sized across load, window resize and rotation.
  requestAnimationFrame(() => state.map.invalidateSize());
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => state.map.invalidateSize(), 150);
  });
  window.addEventListener('orientationchange', () => setTimeout(() => state.map.invalidateSize(), 200));

  // Helpful default so the app shows something immediately.
  const [a, c] = PRESETS['hbf-schloss'];
  setEndpoint('start', a.lat, a.lon, a.label);
  setEndpoint('end', c.lat, c.lon, c.label);
  fitToEndpoints();
}

init();
