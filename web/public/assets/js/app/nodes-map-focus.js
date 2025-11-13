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

/**
 * Default zoom level used when focusing the map on a specific node.
 *
 * @type {number}
 */
export const DEFAULT_NODE_FOCUS_ZOOM = 15;

/**
 * Convert arbitrary values to finite coordinates when possible.
 *
 * @param {*} value Raw coordinate value.
 * @returns {number|null} Parsed coordinate or ``null`` when invalid.
 */
function toFiniteCoordinate(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Build a handler that recentres a map instance on a set of coordinates.
 *
 * @param {{
 *   getMap: () => ({
 *     setView?: Function,
 *     flyTo?: Function,
 *     panTo?: Function,
 *     setZoom?: Function
 *   }) | null,
 *   autoFitController?: { handleUserInteraction?: Function } | null,
 *   leaflet?: { latLng?: Function } | null,
 *   defaultZoom?: number,
 *   setMapCenter?: (value: unknown) => void
 * }} dependencies External services used to reposition the map.
 * @returns {(lat: *, lon: *, options?: { zoom?: number, animate?: boolean }) => boolean}
 *   Map focusing function returning ``true`` when the view changed.
 */
export function createMapFocusHandler({
  getMap,
  autoFitController = null,
  leaflet = null,
  defaultZoom = DEFAULT_NODE_FOCUS_ZOOM,
  setMapCenter = () => {}
}) {
  if (typeof getMap !== 'function') {
    throw new TypeError('getMap must be a function that returns the active map instance.');
  }

  const autoFit = autoFitController && typeof autoFitController.handleUserInteraction === 'function'
    ? autoFitController
    : null;
  const leafletApi = leaflet && typeof leaflet.latLng === 'function' ? leaflet : null;
  const zoomDefault = Number.isFinite(defaultZoom) && defaultZoom > 0 ? defaultZoom : DEFAULT_NODE_FOCUS_ZOOM;
  const updateCenter = typeof setMapCenter === 'function' ? setMapCenter : () => {};

  return (lat, lon, options = {}) => {
    const map = getMap();
    if (!map) return false;

    const latNum = toFiniteCoordinate(lat);
    const lonNum = toFiniteCoordinate(lon);
    if (latNum == null || lonNum == null) return false;

    const zoomCandidate = toFiniteCoordinate(options.zoom);
    const zoom = zoomCandidate != null ? zoomCandidate : zoomDefault;
    if (!Number.isFinite(zoom) || zoom <= 0) return false;

    if (autoFit) {
      autoFit.handleUserInteraction();
    }

    const target = [latNum, lonNum];
    const animate = options.animate !== false;
    if (typeof map.setView === 'function') {
      map.setView(target, zoom, { animate });
    } else if (typeof map.flyTo === 'function') {
      map.flyTo(target, zoom, { animate });
    } else if (typeof map.panTo === 'function') {
      map.panTo(target, { animate });
      if (typeof map.setZoom === 'function') {
        map.setZoom(zoom);
      }
    } else {
      return false;
    }

    if (leafletApi) {
      try {
        const latLng = leafletApi.latLng(latNum, lonNum);
        updateCenter(latLng);
        return true;
      } catch (error) {
        // Fall through to the numeric fallback below when Leaflet rejects the coordinates.
      }
    }
    updateCenter({ lat: latNum, lon: lonNum });
    return true;
  };
}

export const __testUtils = {
  toFiniteCoordinate
};
