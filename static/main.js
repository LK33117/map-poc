import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.15.0/dist/maplibre-gl.mjs';

const ACCENT = '#A9C7B6';
const INK = '#111111';
const state = { center: null, radiusKm: 3 }; // set by search or "Use my location"
const $ = (id) => document.getElementById(id);
const setStatus = (text) => { $('status').textContent = text; };

// lists
function fillList(list, items, label, onPick) {
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const button = li.appendChild(document.createElement('button'));
    button.textContent = label(item); // textContent: names can never inject code
    button.onclick = () => onPick(item);
    return li;
  }));
}

//three layers we fill in later 
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [36.3060, 33.5108],
  zoom: 10,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

map.on('load', () => {
  const empty = { type: 'FeatureCollection', features: [] };
  for (const id of ['area', 'services', 'center']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'area', type: 'fill', source: 'area',
    paint: { 'fill-color': ACCENT, 'fill-opacity': 0.35, 'fill-outline-color': INK } });
  map.addLayer({ id: 'services', type: 'circle', source: 'services',
    paint: { 'circle-radius': 6, 'circle-stroke-width': 1.5, 'circle-stroke-color': INK,
             'circle-color': ['case', ['==', ['get', 'rank'], 1], INK, ACCENT] } }); // closest is black
  map.addLayer({ id: 'center', type: 'circle', source: 'center',
    paint: { 'circle-radius': 7, 'circle-color': '#fff', 'circle-stroke-width': 3, 'circle-stroke-color': INK } });
  map.on('click', 'services', (e) => showPopup(e.features[0]));
    useSavedLocation();
});

//drawing radius (flat-map math)
function drawArea(fit) {
  const { lat, lng } = state.center;
  const dLat = state.radiusKm / 111.32;                                   // about 111 km per degree
  const dLng = state.radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180)); // longitude degrees are shorter
  const ring = [];
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  map.getSource('area')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
  map.getSource('center')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } });
  if (fit) map.fitBounds([[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]], { padding: 40 });
}

//Fetch the closest services for map and list
let popup;
function showPopup(f) {
  const p = f.properties;
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: false })
    .setLngLat(f.geometry.coordinates)
    .setText(`${p.name} · ${p.distance_km} km`)
    .addTo(map);
}

async function refresh() {
  if (!state.center) return;
  drawArea(true);
  const { lat, lng } = state.center;
  try {
    const res = await fetch(`/api/services/nearby?lat=${lat}&lng=${lng}&km=${state.radiusKm}&limit=50`);
    const data = await res.json();
    map.getSource('services')?.setData(data);
    fillList($('results'), data.features,
      (f) => `${f.properties.rank}. ${f.properties.name} · ${f.properties.distance_km} km`,
      (f) => { map.flyTo({ center: f.geometry.coordinates, zoom: 15 }); showPopup(f); });
    const shown = data.features.length;
    setStatus(`${data.total_in_radius} services within ${state.radiusKm} km`
      + (data.total_in_radius > shown ? `, showing the closest ${shown}` : ''));
  } catch {
    setStatus('Could not load services. Is the backend running?');
  }
}

// ask for suggestions afte r some pause 
const searchInput = $('search-input');
let typingTimer;

searchInput.oninput = () => {
  clearTimeout(typingTimer);
  const query = searchInput.value.trim();
  if (query.length < 3) return $('suggestions').replaceChildren();
  typingTimer = setTimeout(async () => {
    const { lat, lng } = state.center ?? map.getCenter(); //currently the map's nearby services 
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}&lat=${lat}&lng=${lng}`);
      const places = await res.json();
      if (query !== searchInput.value.trim()) return; // user kept typing: ignore this old answer
      fillList($('suggestions'), places, (p) => p.label, (p) => {
        searchInput.value = p.label;
        $('suggestions').replaceChildren();
        state.center = { lat: p.lat, lng: p.lng };
        refresh();
      });
    } catch {
      setStatus('Search is unavailable right now.');
    }
  }, 300);
};
//user's stored location
const SAVED_LOCATION = {
  label: 'Old City, Damascus, Syria',
  lat: 33.5108,
  lng: 36.3060
};
function useSavedLocation() {
  searchInput.value = SAVED_LOCATION.label;
  state.center = { lat: SAVED_LOCATION.lat, lng: SAVED_LOCATION.lng };
  refresh();
}
$('locate-btn').onclick = useSavedLocation;

const slider = $('radius-input');
slider.oninput = () => {
  state.radiusKm = Number(slider.value);
  $('radius-value').textContent = state.radiusKm;
  if (state.center) drawArea(false);
};
slider.onchange = refresh;