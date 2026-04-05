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
 * Default zoom level used when resetting to the configured map centre and no
 * last-fit bounds are available.
 *
 * @type {number}
 */
export const DEFAULT_CENTER_RESET_ZOOM = 10;

/**
 * Build a handler that resets the map view to fit all known nodes.
 *
 * When invoked, the handler:
 * 1. Re-enables the auto-fit checkbox (unless the element is disabled, e.g.
 *    when a hard zoom override is in effect).
 * 2. Re-applies the last recorded auto-fit bounds via ``fitMapToBounds`` when
 *    available — this is the bounds computed during the most recent
 *    ``renderMap`` call and covers all visible nodes.
 * 3. Falls back to ``map.setView`` at the configured centre coordinates when no
 *    prior fit has been recorded (e.g. before the first data refresh).
 *
 * @param {object} options - Factory configuration.
 * @param {() => object | null} options.getMap - Returns the active Leaflet map instance.
 * @param {{
 *   getLastFit(): { bounds: [[number,number],[number,number]], options: { paddingPx: number, maxZoom?: number } } | null,
 *   runAutoFitOperation(fn: () => void): void
 * }} options.autoFitController - Auto-fit controller created by ``createMapAutoFitController``.
 * @param {HTMLInputElement | null} [options.fitBoundsEl] - The auto-fit toggle checkbox.
 * @param {(bounds: [[number,number],[number,number]], options?: object) => void} options.fitMapToBounds - Fits the map to bounds.
 * @param {{ lat: number, lon: number }} options.mapCenterCoords - Configured map centre coordinates.
 * @param {number | null} [options.mapZoomOverride] - Hard zoom level from server config, or null when absent.
 * @returns {() => void} Handler to call when the centre-reset button is clicked.
 */
export function createMapCenterResetHandler({
  getMap,
  autoFitController,
  fitBoundsEl = null,
  fitMapToBounds,
  mapCenterCoords,
  mapZoomOverride = null,
}) {
  if (typeof getMap !== 'function') {
    throw new TypeError('getMap must be a function that returns the active map instance.');
  }
  if (!autoFitController || typeof autoFitController.getLastFit !== 'function') {
    throw new TypeError('autoFitController must expose getLastFit().');
  }
  if (typeof fitMapToBounds !== 'function') {
    throw new TypeError('fitMapToBounds must be a function.');
  }
  if (!mapCenterCoords || !Number.isFinite(mapCenterCoords.lat) || !Number.isFinite(mapCenterCoords.lon)) {
    throw new TypeError('mapCenterCoords must be an object with finite lat and lon.');
  }

  return function handleCenterReset() {
    const map = getMap();
    if (!map) return;

    // Re-enable autofit when the checkbox is present and not locked out by a
    // hard zoom override (the element is disabled in that case). Dispatch a
    // change event so any listeners that synchronise UI state (e.g. aria
    // attributes) are notified, mirroring the pattern in handleUserInteraction.
    if (fitBoundsEl && !fitBoundsEl.disabled) {
      autoFitController.runAutoFitOperation(() => {
        fitBoundsEl.checked = true;
        fitBoundsEl.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Re-apply the last known node-fit bounds produced by renderMap.
    // fitMapToBounds already calls runAutoFitOperation internally, so the
    // movestart/zoomstart handlers cannot uncheck auto-fit during the pan.
    const lastFit = autoFitController.getLastFit();
    if (lastFit) {
      fitMapToBounds(lastFit.bounds, {
        animate: true,
        paddingPx: lastFit.options.paddingPx,
        maxZoom: lastFit.options.maxZoom,
      });
      return;
    }

    // Fallback: no prior fit recorded yet — reset to the configured centre.
    // Wrap in runAutoFitOperation so the movestart/zoomstart handlers see
    // autoFitInProgress=true and do not immediately uncheck the auto-fit
    // checkbox as a side-effect of the programmatic setView call.
    const zoom = Number.isFinite(mapZoomOverride) && mapZoomOverride > 0
      ? mapZoomOverride
      : DEFAULT_CENTER_RESET_ZOOM;
    if (typeof map.setView === 'function') {
      autoFitController.runAutoFitOperation(() => {
        map.setView([mapCenterCoords.lat, mapCenterCoords.lon], zoom, { animate: true });
      });
    }
  };
}
