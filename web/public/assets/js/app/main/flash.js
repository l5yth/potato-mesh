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
 * Applies a ~1.2 s white->role-colour fade to a DOM element when a live SSE
 * update lands on it (SPEC LV1/LV2/LV3, amends VF5). The visual itself — and its
 * suppression under
 * `prefers-reduced-motion` — lives entirely in CSS (`.live-flash` in
 * `base.css`); this module only toggles the class, so it has no dependency on a
 * real layout engine and is fully unit-testable. The class is removed after the
 * highlight so a subsequent update can re-trigger it.
 *
 * @module main/flash
 */

/** CSS class that drives the one-shot highlight animation. */
export const FLASH_CLASS = 'live-flash';

/** Element highlight lifetime in ms; the role-colour fade keyframe runs ~1.2 s (LV1). */
export const FLASH_DURATION_MS = 1200;

/** Marker white-pulse lifetime in ms (interim; the LV5 wave layers on top). */
export const MARKER_FLASH_DURATION_MS = 90;

/** Map-marker wave ring lifetime in ms; matches the LV5 keyframe (~1.2s). */
export const WAVE_DURATION_MS = 1200;

/** Property key holding an element's pending flash-removal timer (LV2). */
const FLASH_TIMER_KEY = '__liveFlashTimer';

/**
 * Default removal scheduler (real timer). Injectable so tests stay deterministic.
 *
 * @param {Function} callback Removal callback.
 * @param {number} delay Delay in ms.
 * @returns {*} The timer handle.
 */
function defaultSchedule(callback, delay) {
  const handle = setTimeout(callback, delay);
  // Don't let a pending fade-removal timer keep a Node process alive (tests).
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Default timer canceller (pairs with {@link defaultSchedule}). Injectable so
 * tests can assert that a re-flash cancels the prior removal timer.
 *
 * @param {*} handle Timer handle returned by the scheduler.
 * @returns {void}
 */
function defaultCancel(handle) {
  clearTimeout(handle);
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
  const cancel = typeof options.cancel === 'function' ? options.cancel : defaultCancel;
  // Cancel any in-flight removal timer so a re-flash mid-fade restarts cleanly
  // and is never cut short by the previous timer (LV2 stacked, per-element timers).
  if (element[FLASH_TIMER_KEY] != null) {
    cancel(element[FLASH_TIMER_KEY]);
    element[FLASH_TIMER_KEY] = null;
  }
  // Restart the animation: clearing the class and forcing a style read between
  // remove and re-add restarts the CSS animation even while one is mid-flight.
  element.classList.remove(FLASH_CLASS);
  // Reading offsetWidth forces the reflow that restarts the animation; harmless
  // (undefined) when no layout engine is present (tests).
  void element.offsetWidth;
  element.classList.add(FLASH_CLASS);
  element[FLASH_TIMER_KEY] = schedule(() => {
    element.classList.remove(FLASH_CLASS);
    element[FLASH_TIMER_KEY] = null;
  }, duration);
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
  const duration = typeof options.duration === 'number' ? options.duration : MARKER_FLASH_DURATION_MS;
  const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule;
  const current = marker.options || {};
  const original = { fillColor: current.fillColor, fillOpacity: current.fillOpacity };
  marker.setStyle({ fillColor: '#ffffff', fillOpacity: 1 });
  schedule(() => marker.setStyle(original), duration);
  return true;
}

/**
 * Emit an expanding "wave" ring from a Leaflet marker (SPEC LV5).
 *
 * Creates a transient, non-interactive divIcon marker at the marker's location
 * whose `.live-flash-wave` ring grows and fades toward the role colour over
 * ~1.2s (the animation lives in `base.css`), then removes it from the host
 * layer. Leaflet and the layer are injected so this unit-tests without a real
 * map. A marker without `getLatLng`, or a missing Leaflet/layer, is a safe no-op.
 *
 * @param {?{getLatLng: Function}} marker Source Leaflet marker.
 * @param {Object} [options] Wave configuration.
 * @param {?Object} [options.leaflet] Leaflet namespace (`L`), injected by the caller.
 * @param {?{addLayer: Function, removeLayer: Function}} [options.layer] Layer to host the wave.
 * @param {?string} [options.color] Role colour for the ring (`--flash-role-color`).
 * @param {number} [options.duration] Lifetime before removal (ms).
 * @param {Function} [options.schedule] Removal scheduler (tests inject this).
 * @returns {boolean} true when a wave was emitted; false when skipped.
 */
export function emitMarkerWave(marker, options = {}) {
  if (!marker || typeof marker.getLatLng !== 'function') return false;
  const leaflet = options.leaflet || null;
  const layer = options.layer || null;
  if (!leaflet || typeof leaflet.divIcon !== 'function' || typeof leaflet.marker !== 'function') {
    return false;
  }
  if (!layer || typeof layer.addLayer !== 'function') return false;
  const duration = typeof options.duration === 'number' ? options.duration : WAVE_DURATION_MS;
  const schedule = typeof options.schedule === 'function' ? options.schedule : defaultSchedule;
  const color = typeof options.color === 'string' && options.color ? options.color : 'rgba(255, 255, 255, 0.85)';
  const icon = leaflet.divIcon({
    className: 'live-flash-wave-icon',
    html: `<div class="live-flash-wave" style="--flash-role-color: ${color}"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
  const wave = leaflet.marker(marker.getLatLng(), { icon, interactive: false, keyboard: false });
  layer.addLayer(wave);
  schedule(() => {
    if (typeof layer.removeLayer === 'function') layer.removeLayer(wave);
  }, duration);
  return true;
}

/**
 * Emit a wave from each changed node's marker (SPEC LV5). Looks up each node's
 * marker and role colour and delegates to {@link emitMarkerWave}; nodes without
 * a marker are skipped. Pure over its injected lookups, so it unit-tests without
 * a real map.
 *
 * @param {?Iterable<string>} nodeIds Canonical node ids that changed.
 * @param {Object} [options] Lookups + wave config.
 * @param {?{get: Function}} [options.markerByNodeId] node id -> Leaflet marker.
 * @param {?Object} [options.leaflet] Leaflet namespace (`L`).
 * @param {?{addLayer: Function, removeLayer: Function}} [options.layer] Wave host layer.
 * @param {?(id: string) => ?string} [options.colorForNodeId] Resolves a node's wave colour.
 * @param {Object} [options.waveOptions] Extra options forwarded to {@link emitMarkerWave}.
 * @returns {number} count of waves emitted.
 */
export function emitNodeWaves(nodeIds, options = {}) {
  if (!nodeIds || typeof nodeIds[Symbol.iterator] !== 'function') return 0;
  const { markerByNodeId = null, leaflet = null, layer = null, colorForNodeId = null, waveOptions = {} } = options;
  if (!markerByNodeId || typeof markerByNodeId.get !== 'function') return 0;
  let count = 0;
  for (const id of nodeIds) {
    const marker = markerByNodeId.get(id);
    if (!marker) continue;
    const color = typeof colorForNodeId === 'function' ? colorForNodeId(id) : null;
    if (emitMarkerWave(marker, { ...waveOptions, leaflet, layer, color })) count += 1;
  }
  return count;
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
