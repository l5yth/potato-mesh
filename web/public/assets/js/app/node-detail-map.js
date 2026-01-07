/*
 * Copyright © 2025-26 l5yth & contributors
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

const DEFAULT_FETCH_OPTIONS = Object.freeze({ cache: 'no-store' });
const DAY_SECONDS = 86_400;
const MAP_PADDING = [18, 18];
const MAX_FIT_ZOOM = 14;
const DEFAULT_ZOOM = 12;
const MAP_CONTEXT_WAIT_INTERVAL_MS = 50;
const MAP_CONTEXT_WAIT_TIMEOUT_MS = 1500;
const ROLE_BY_DAY = Object.freeze([
  'LOST_AND_FOUND',
  'ROUTER',
  'ROUTER_LATE',
  'REPEATER',
  'CLIENT_BASE',
  'CLIENT',
  'CLIENT_MUTE',
  'TRACKER',
  'SENSOR',
  'CLIENT_HIDDEN',
]);
const MAX_DAYS = ROLE_BY_DAY.length;

/**
 * Coerce a candidate coordinate into a finite number.
 *
 * @param {*} value Raw coordinate candidate.
 * @returns {?number} Finite number or ``null`` when invalid.
 */
function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Resolve the node identifier from a reference payload.
 *
 * @param {*} reference Node reference payload.
 * @returns {?string} Canonical identifier or ``null`` when unavailable.
 */
function resolveReferenceId(reference) {
  if (!reference || typeof reference !== 'object') return null;
  const nodeId = reference.nodeId ?? reference.node_id;
  const nodeNum = reference.nodeNum ?? reference.node_num ?? reference.num;
  const candidate = nodeId ?? nodeNum;
  if (candidate == null) return null;
  const text = String(candidate).trim();
  return text.length ? text : null;
}

/**
 * Locate the shared map instance exposed by the dashboard.
 *
 * @param {Object} options Optional configuration.
 * @returns {{ map: ?Object, leaflet: ?Object }} Map context.
 */
function resolveMapContext(options) {
  if (typeof options.getMapContext === 'function') {
    return options.getMapContext() || { map: null, leaflet: null };
  }
  const namespace = options.namespace ?? globalThis.PotatoMesh ?? null;
  if (namespace && typeof namespace.getMapContext === 'function') {
    return namespace.getMapContext() || { map: null, leaflet: null };
  }
  return {
    map: namespace?.map ?? null,
    leaflet: namespace?.leaflet ?? globalThis.L ?? null,
    layers: namespace?.mapLayers ?? null,
  };
}

/**
 * Wait briefly for the shared map context to become available.
 *
 * @param {Object} options Optional configuration.
 * @returns {Promise<{ map: ?Object, leaflet: ?Object }>} Map context.
 */
async function waitForMapContext(options) {
  const deadline = Date.now() + MAP_CONTEXT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const context = resolveMapContext(options);
    if (context.map && context.leaflet) {
      return context;
    }
    await new Promise(resolve => setTimeout(resolve, MAP_CONTEXT_WAIT_INTERVAL_MS));
  }
  return resolveMapContext(options);
}

/**
 * Resolve the map panel element for reuse.
 *
 * @param {?Document} doc Host document reference.
 * @param {Object} options Optional overrides.
 * @returns {?HTMLElement} Map panel element.
 */
function resolveMapPanel(doc, options) {
  if (options.mapPanel) return options.mapPanel;
  if (!doc || typeof doc.getElementById !== 'function') return null;
  return doc.getElementById('mapPanel');
}

/**
 * Hide the map section when no map data is available.
 *
 * @param {?HTMLElement} section Map panel section.
 * @param {?HTMLElement} statusEl Status element.
 * @returns {void}
 */
function hidePanel(section, statusEl) {
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.hidden = true;
  }
  if (section) {
    section.hidden = true;
  }
}

/**
 * Interpolate a color channel.
 *
 * @param {number} start Start value.
 * @param {number} end End value.
 * @param {number} t Interpolation factor.
 * @returns {number} Interpolated channel value.
 */
function colorForDay(dayIndex, getRoleColor) {
  if (typeof getRoleColor !== 'function') return null;
  const clampedDay = Math.max(0, Math.min(dayIndex, ROLE_BY_DAY.length - 1));
  const role = ROLE_BY_DAY[clampedDay];
  return getRoleColor(role);
}

/**
 * Extract usable position entries from a raw payload.
 *
 * @param {Array<Object>} positions Position payload entries.
 * @param {number} nowSec Reference timestamp in seconds.
 * @returns {Array<{ lat: number, lon: number, time: number, day: number }>} Parsed entries.
 */
function extractPositionEntries(positions, nowSec) {
  if (!Array.isArray(positions)) return [];
  const entries = [];
  positions.forEach(entry => {
    const lat = toFiniteNumber(entry?.latitude ?? entry?.lat);
    const lon = toFiniteNumber(entry?.longitude ?? entry?.lon ?? entry?.lng);
    if (lat == null || lon == null) return;
    const time = toFiniteNumber(entry?.position_time ?? entry?.positionTime) ??
      toFiniteNumber(entry?.rx_time ?? entry?.rxTime);
    if (time == null || time <= 0) return;
    const ageSec = Math.max(0, nowSec - time);
    const dayIndex = Math.floor(ageSec / DAY_SECONDS);
    if (dayIndex >= MAX_DAYS) return;
    entries.push({ lat, lon, time, day: dayIndex });
  });
  return entries;
}

/**
 * Fetch position history for a node reference.
 *
 * @param {string} identifier Canonical node identifier.
 * @param {Function} fetchFn Fetch implementation.
 * @returns {Promise<Array<Object>>} Position payloads.
 */
async function fetchPositions(identifier, fetchFn) {
  const url = `/api/positions/${encodeURIComponent(identifier)}`;
  const response = await fetchFn(url, DEFAULT_FETCH_OPTIONS);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Failed to load node positions (HTTP ${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Move the shared map panel into the overlay slot and return a restore handler.
 *
 * @param {HTMLElement} mapPanel Shared map panel element.
 * @param {HTMLElement} slot Target slot element.
 * @returns {Function} Cleanup handler restoring the original panel placement.
 */
function moveMapPanel(mapPanel, slot) {
  if (!mapPanel || !slot) {
    return () => {};
  }
  if (mapPanel.parentNode === slot) {
    return () => {};
  }
  const parent = mapPanel.parentNode;
  const nextSibling = mapPanel.nextSibling;
  slot.appendChild(mapPanel);
  if (mapPanel.classList) {
    mapPanel.classList.add('map-panel--embedded');
  }
  return () => {
    if (mapPanel.classList) {
      mapPanel.classList.remove('map-panel--embedded');
    }
    if (parent && typeof parent.insertBefore === 'function') {
      parent.insertBefore(mapPanel, nextSibling);
    }
  };
}

/**
 * Initialize the node detail map panel using the shared map instance.
 *
 * @param {Element} root Root element containing the map panel.
 * @param {Object} reference Node reference payload.
 * @param {{
 *   fetchImpl?: Function,
 *   leaflet?: Object,
 *   logger?: Console,
 *   document?: Document,
 *   mapPanel?: HTMLElement,
 *   getMapContext?: Function,
 *   namespace?: Object,
 * }} [options] Optional overrides.
 * @returns {Promise<Function|null>} Cleanup handler when the panel is shown.
 */
export async function initializeNodeDetailMapPanel(root, reference, options = {}) {
  const section = root?.querySelector?.('[data-node-map-panel]') ?? null;
  const slot = root?.querySelector?.('[data-node-map-slot]') ?? null;
  if (!section || !slot) return null;

  const statusEl = root?.querySelector?.('[data-node-map-status]') ?? null;
  const identifier = resolveReferenceId(reference);
  if (!identifier) {
    hidePanel(section, statusEl);
    return null;
  }

  const fetchFn = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    hidePanel(section, statusEl);
    return null;
  }

  const mapPanel = resolveMapPanel(options.document ?? globalThis.document, options);
  if (!mapPanel) {
    hidePanel(section, statusEl);
    return null;
  }
  const { map, leaflet, layers } = await waitForMapContext(options);
  if (!map || !leaflet) {
    hidePanel(section, statusEl);
    return null;
  }

  let restorePanel = null;
  let restoreFitBounds = null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const positions = await fetchPositions(identifier, fetchFn);
    const entries = extractPositionEntries(positions, nowSec);
    if (entries.length === 0) {
      hidePanel(section, statusEl);
      return null;
    }

    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = `${entries.length} position${entries.length === 1 ? '' : 's'}`;
    }
    section.hidden = false;

    restorePanel = moveMapPanel(mapPanel, slot);
    const fitBoundsEl = options.document?.getElementById?.('fitBounds') ?? null;
    if (fitBoundsEl && typeof fitBoundsEl.checked === 'boolean') {
      const previous = fitBoundsEl.checked;
      fitBoundsEl.checked = false;
      restoreFitBounds = () => {
        fitBoundsEl.checked = previous;
      };
    }

    const prevCenter = typeof map.getCenter === 'function' ? map.getCenter() : null;
    const prevZoom = typeof map.getZoom === 'function' ? map.getZoom() : null;

    const getRoleColor =
      typeof options.getRoleColor === 'function'
        ? options.getRoleColor
        : options.namespace?.getRoleColor ?? globalThis.PotatoMesh?.getRoleColor;
    const latest = entries.reduce((acc, entry) => (entry.time > acc.time ? entry : acc), entries[0]);
    const latestColor = colorForDay(latest.day, getRoleColor) ?? '#2b6cb0';

    const ordered = entries.slice().sort((a, b) => b.time - a.time);
    const pathLatLngs = ordered.map(entry => [entry.lat, entry.lon]);

    const layerGroup = leaflet.layerGroup().addTo(map);
    if (layers?.markersLayer && typeof layers.markersLayer.clearLayers === 'function') {
      layers.markersLayer.clearLayers();
    }
    if (layers?.neighborLinesLayer && typeof layers.neighborLinesLayer.clearLayers === 'function') {
      layers.neighborLinesLayer.clearLayers();
    }
    if (layers?.traceLinesLayer && typeof layers.traceLinesLayer.clearLayers === 'function') {
      layers.traceLinesLayer.clearLayers();
    }
    const polyline = leaflet.polyline(pathLatLngs, {
      color: latestColor,
      weight: 2,
      opacity: 0.42,
      className: 'neighbor-connection-line node-detail-path-line'
    });
    polyline.addTo(layerGroup);

    ordered.forEach(entry => {
      const color = colorForDay(entry.day, getRoleColor) ?? '#2b6cb0';
      const marker = leaflet.circleMarker([entry.lat, entry.lon], {
        radius: 9,
        color: '#000',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.7,
        opacity: 0.7
      });
      marker.addTo(layerGroup);
    });

    if (pathLatLngs.length > 1 && typeof map.fitBounds === 'function') {
      map.fitBounds(pathLatLngs, { padding: MAP_PADDING, maxZoom: MAX_FIT_ZOOM });
    } else if (typeof map.setView === 'function') {
      map.setView(pathLatLngs[pathLatLngs.length - 1], DEFAULT_ZOOM);
    }

    if (typeof map.invalidateSize === 'function') {
      map.invalidateSize(true);
    }

    return () => {
      if (layerGroup && typeof map.removeLayer === 'function') {
        map.removeLayer(layerGroup);
      } else if (layerGroup && typeof layerGroup.remove === 'function') {
        layerGroup.remove();
      }
      restorePanel();
      if (restoreFitBounds) {
        restoreFitBounds();
      }
      if (prevCenter && typeof map.setView === 'function') {
        map.setView(prevCenter, prevZoom ?? map.getZoom?.());
      }
      if (typeof map.invalidateSize === 'function') {
        map.invalidateSize(true);
      }
    };
  } catch (error) {
    if (restorePanel) {
      restorePanel();
    }
    if (restoreFitBounds) {
      restoreFitBounds();
    }
    if (options.logger && typeof options.logger.error === 'function') {
      options.logger.error('Failed to load node positions', error);
    }
    hidePanel(section, statusEl);
    return null;
  }
}

export const __testUtils = {
  toFiniteNumber,
  resolveReferenceId,
  extractPositionEntries,
  colorForDay,
  ROLE_BY_DAY,
};
