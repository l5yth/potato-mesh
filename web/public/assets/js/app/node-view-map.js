/*
 * Copyright (C) 2025 l5yth
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const TILE_LAYER_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
const TILE_LAYER_OPTIONS = { maxZoom: 19, className: 'map-tiles', crossOrigin: 'anonymous' };
const MAP_PADDING = [28, 28];

/**
 * Apply the computed theme tile filter to the provided element.
 *
 * @param {Element} element DOM element wrapping Leaflet tiles.
 * @returns {void}
 */
function applyTileFilter(element) {
  if (!element || typeof element !== 'object') return;
  const ownerDocument = element.ownerDocument || globalThis.document;
  if (!ownerDocument || typeof ownerDocument.defaultView?.getComputedStyle !== 'function') return;
  const computed = ownerDocument.defaultView.getComputedStyle(ownerDocument.body);
  const filterValue = computed.getPropertyValue('--map-tiles-filter') || '';
  if (filterValue) {
    element.style.filter = filterValue;
    element.style.webkitFilter = filterValue;
  }
}

/**
 * Create a Leaflet map describing node movement over time.
 *
 * @param {Object} options Behaviour customisation options.
 * @param {Element} options.container Target element that will host the map.
 * @param {Array<Object>} options.positions Normalised positions sorted oldest first.
 * @param {string} [options.theme='light'] Theme identifier to influence colours.
 * @param {Object} [options.leaflet=globalThis.L] Leaflet instance injected for testing.
 * @returns {Object|null} Object describing created layers or ``null`` when skipped.
 */
export function initializeNodeMap({
  container,
  positions,
  theme = 'light',
  leaflet = globalThis.L
} = {}) {
  if (!container || typeof container !== 'object') {
    throw new TypeError('container element is required');
  }
  if (!Array.isArray(positions) || positions.length === 0) {
    container.innerHTML = '<p class="node-view__plot-empty">No positions recorded in the last 7 days.</p>';
    return null;
  }
  if (!leaflet || typeof leaflet.map !== 'function' || typeof leaflet.tileLayer !== 'function') {
    container.innerHTML = '<p class="node-view__plot-empty">Map rendering is unavailable in this environment.</p>';
    return null;
  }

  const map = leaflet.map(container, { worldCopyJump: true, attributionControl: false });
  const tileLayer = leaflet.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS);
  tileLayer.addTo(map);
  if (typeof tileLayer.on === 'function') {
    tileLayer.on('load', () => {
      const tileContainer = typeof tileLayer.getContainer === 'function' ? tileLayer.getContainer() : null;
      if (tileContainer) applyTileFilter(tileContainer);
    });
  }

  const pathColor = theme === 'dark' ? '#5fa8ff' : '#2b6cb0';
  const markerFill = theme === 'dark' ? '#f6ad55' : '#c05621';

  const latLngs = [];
  const markers = [];
  positions.forEach((position, index) => {
    const latLng = [position.latitude, position.longitude];
    latLngs.push(latLng);
    const marker = leaflet.circleMarker(latLng, {
      radius: 5,
      weight: 1,
      opacity: 0.85,
      color: pathColor,
      fillColor: markerFill,
      fillOpacity: 0.95
    });
    const timestamp = new Date(position.timestampMs);
    marker.bindTooltip?.(
      `${timestamp.toISOString().replace('T', ' ').replace('Z', ' UTC')}`,
      { direction: index === positions.length - 1 ? 'top' : 'bottom' }
    );
    marker.addTo(map);
    markers.push(marker);
  });

  let polyline = null;
  if (latLngs.length >= 2) {
    polyline = leaflet.polyline(latLngs, { color: pathColor, opacity: 0.65, weight: 3 });
    polyline.addTo(map);
    if (typeof map.fitBounds === 'function' && typeof leaflet.latLngBounds === 'function') {
      const bounds = leaflet.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: MAP_PADDING, maxZoom: 15 });
    }
  } else if (latLngs.length === 1 && typeof map.setView === 'function') {
    map.setView(latLngs[0], 13);
  }

  return { map, tileLayer, markers, polyline };
}

export { applyTileFilter, TILE_LAYER_URL };
