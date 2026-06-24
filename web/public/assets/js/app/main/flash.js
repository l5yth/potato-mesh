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
 * Live-update flash helper.
 *
 * Applies a brief (<100 ms) white highlight to a DOM element when a live SSE
 * update lands on it (SPEC VF5). The visual itself — and its suppression under
 * `prefers-reduced-motion` — lives entirely in CSS (`.live-flash` in
 * `base.css`); this module only toggles the class, so it has no dependency on a
 * real layout engine and is fully unit-testable. The class is removed after the
 * highlight so a subsequent update can re-trigger it.
 *
 * @module main/flash
 */

/** CSS class that drives the one-shot highlight animation. */
export const FLASH_CLASS = 'live-flash';

/** Highlight lifetime in ms; kept below 100 ms per VF5. Matches the keyframe. */
export const FLASH_DURATION_MS = 90;

/**
 * Default removal scheduler (real timer). Injectable so tests stay deterministic.
 *
 * @param {Function} callback Removal callback.
 * @param {number} delay Delay in ms.
 * @returns {*} The timer handle.
 */
function defaultSchedule(callback, delay) {
  return setTimeout(callback, delay);
}

/**
 * Flash a single element white.
 *
 * Removes then re-adds {@link FLASH_CLASS} so the animation restarts even when a
 * previous flash is still mid-flight, then schedules class removal so a future
 * update can flash the same element again. A missing or non-element argument is
 * a safe no-op.
 *
 * @param {?Element} element Target element (must expose `classList`).
 * @param {{ duration?: number, schedule?: Function }} [options] Overrides for
 *   the highlight lifetime and the removal scheduler (tests inject `schedule`).
 * @returns {boolean} true when the element was flashed; false when skipped.
 */
export function flashElement(element, options = {}) {
  if (!element || !element.classList || typeof element.classList.add !== 'function') {
    return false;
  }
  const duration = typeof options.duration === 'number' ? options.duration : FLASH_DURATION_MS;
  const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule;
  // Restart the animation by clearing any in-flight highlight before re-adding.
  element.classList.remove(FLASH_CLASS);
  element.classList.add(FLASH_CLASS);
  schedule(() => element.classList.remove(FLASH_CLASS), duration);
  return true;
}

/**
 * Flash a Leaflet vector marker (e.g. a node's `circleMarker`) white.
 *
 * SVG markers can't use the `.live-flash` box-shadow, so this briefly overrides
 * the marker's fill to white via Leaflet's `setStyle`, then restores the
 * original fill after {@link FLASH_DURATION_MS}. A marker without `setStyle` is
 * a safe no-op.
 *
 * @param {?{setStyle: Function, options?: Object}} marker Leaflet vector marker.
 * @param {{ duration?: number, schedule?: Function }} [options] See {@link flashElement}.
 * @returns {boolean} true when the marker was flashed; false when skipped.
 */
export function flashMarker(marker, options = {}) {
  if (!marker || typeof marker.setStyle !== 'function') return false;
  const duration = typeof options.duration === 'number' ? options.duration : FLASH_DURATION_MS;
  const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule;
  const current = marker.options || {};
  const original = { fillColor: current.fillColor, fillOpacity: current.fillOpacity };
  marker.setStyle({ fillColor: '#ffffff', fillOpacity: 1 });
  schedule(() => marker.setStyle(original), duration);
  return true;
}

/**
 * Flash every UI target for a set of changed nodes: each node's table row(s)
 * (`[data-node-row="<id>"]`) and its map marker (SPEC VF3).
 *
 * DOM and marker lookups are injected so this is unit-testable without a real
 * document or Leaflet. Each is optional — a caller on a page without the node
 * table (or without a map) simply passes one of them.
 *
 * @param {?Iterable<string>} nodeIds Canonical node ids to flash.
 * @param {Object} [options] Lookups + flash overrides.
 * @param {?{querySelectorAll: Function}} [options.documentRef] Document to query rows in.
 * @param {?{get: Function}} [options.markerByNodeId] Map of node id → Leaflet marker.
 * @param {{ duration?: number, schedule?: Function }} [options.flashOptions] Passed to the flash primitives.
 * @returns {number} count of row + marker targets flashed.
 */
export function flashNodeTargets(nodeIds, options = {}) {
  if (!nodeIds || typeof nodeIds[Symbol.iterator] !== 'function') return 0;
  const { documentRef = null, markerByNodeId = null, flashOptions = {} } = options;
  let count = 0;
  for (const id of nodeIds) {
    if (documentRef && typeof documentRef.querySelectorAll === 'function') {
      count += flashElements(documentRef.querySelectorAll(`[data-node-row="${id}"]`), flashOptions);
    }
    const marker = markerByNodeId && typeof markerByNodeId.get === 'function'
      ? markerByNodeId.get(id)
      : null;
    if (marker && flashMarker(marker, flashOptions)) count += 1;
  }
  return count;
}

/**
 * Flash every UI target for a set of changed messages: each message's chat
 * row(s) (`[data-message-id="<id>"]`, present in the Log tab and the channel
 * tab) and the header of each affected channel tab (`[data-tab-id="<id>"]`)
 * once (SPEC VF3).
 *
 * @param {?Iterable<string>} messageIds Message ids that changed.
 * @param {Object} [options] Lookups + flash overrides.
 * @param {?{querySelectorAll: Function}} [options.documentRef] Document to query in.
 * @param {?{get: Function}} [options.messageTabId] Map of message id → channel tab id.
 * @param {{ duration?: number, schedule?: Function }} [options.flashOptions] Passed to the flash primitives.
 * @returns {number} count of row + tab-header targets flashed.
 */
export function flashMessageTargets(messageIds, options = {}) {
  if (!messageIds || typeof messageIds[Symbol.iterator] !== 'function') return 0;
  const { documentRef = null, messageTabId = null, flashOptions = {} } = options;
  const canQuery = Boolean(documentRef) && typeof documentRef.querySelectorAll === 'function';
  let count = 0;
  const tabIds = new Set();
  for (const id of messageIds) {
    if (canQuery) {
      count += flashElements(documentRef.querySelectorAll(`[data-message-id="${id}"]`), flashOptions);
    }
    const tabId = messageTabId && typeof messageTabId.get === 'function' ? messageTabId.get(id) : null;
    if (tabId) tabIds.add(tabId);
  }
  // Flash each affected channel tab header exactly once.
  if (canQuery) {
    for (const tabId of tabIds) {
      count += flashElements(documentRef.querySelectorAll(`[data-tab-id="${tabId}"]`), flashOptions);
    }
  }
  return count;
}

/**
 * Flash several elements, skipping any that are missing/invalid.
 *
 * @param {?Iterable<Element>} elements Elements to flash.
 * @param {{ duration?: number, schedule?: Function }} [options] See {@link flashElement}.
 * @returns {number} count of elements actually flashed.
 */
export function flashElements(elements, options = {}) {
  if (!elements || typeof elements[Symbol.iterator] !== 'function') return 0;
  let count = 0;
  for (const element of elements) {
    if (flashElement(element, options)) count += 1;
  }
  return count;
}
