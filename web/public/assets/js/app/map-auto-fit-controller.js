/**
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

/**
 * @typedef {[number, number]} LatLngTuple
 * @typedef {[LatLngTuple, LatLngTuple]} LatLngBoundsTuple
 * @typedef {{ paddingPx: number, maxZoom?: number }} FitOptionsSnapshot
 */

/**
 * Safely clone a Leaflet-compatible bounds tuple to avoid accidental mutation.
 *
 * @param {LatLngBoundsTuple} bounds - Bounds tuple to duplicate.
 * @returns {LatLngBoundsTuple} Deep copy of the provided bounds.
 */
function cloneBounds(bounds) {
  return [
    [bounds[0][0], bounds[0][1]],
    [bounds[1][0], bounds[1][1]]
  ];
}

/**
 * Determine whether the provided structure resembles a Leaflet bounds tuple.
 *
 * @param {unknown} value - Potential bounds input.
 * @returns {value is LatLngBoundsTuple} True when the input is structurally valid.
 */
function isValidBounds(value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [southWest, northEast] = value;
  if (!Array.isArray(southWest) || !Array.isArray(northEast)) return false;
  if (southWest.length !== 2 || northEast.length !== 2) return false;
  const numbers = [southWest[0], southWest[1], northEast[0], northEast[1]];
  return numbers.every(number => Number.isFinite(number));
}

/**
 * Create a controller for coordinating map auto-fit behaviour.
 *
 * @param {object} options - Controller configuration options.
 * @param {HTMLInputElement|null} [options.toggleEl] - Checkbox controlling auto-fit.
 * @param {Window|undefined} [options.windowObject] - Browser window instance.
 * @param {number} [options.defaultPaddingPx=32] - Padding fallback when none supplied.
 * @returns {{
 *   attachResizeListener(callback: (snapshot: { bounds: LatLngBoundsTuple, options: FitOptionsSnapshot } | null) => void): () => void,
 *   getLastFit(): { bounds: LatLngBoundsTuple, options: FitOptionsSnapshot } | null,
 *   handleUserInteraction(): boolean,
 *   isAutoFitEnabled(): boolean,
 *   recordFit(bounds: LatLngBoundsTuple, options?: { paddingPx?: number, maxZoom?: number }): void,
 *   runAutoFitOperation(fn: () => unknown): unknown
 * }} Map auto-fit controller instance.
 */
export function createMapAutoFitController({
  toggleEl = null,
  windowObject = typeof window !== 'undefined' ? window : undefined,
  defaultPaddingPx = 32
} = {}) {
  /** @type {LatLngBoundsTuple|null} */
  let lastBounds = null;
  /** @type {FitOptionsSnapshot} */
  let lastOptions = { paddingPx: defaultPaddingPx };
  let autoFitInProgress = false;

  /**
   * Record the most recent set of bounds used for auto-fitting.
   *
   * @param {LatLngBoundsTuple} bounds - Leaflet bounds tuple.
   * @param {{ paddingPx?: number, maxZoom?: number }} [options] - Fit options to persist.
   * @returns {void}
   */
  function recordFit(bounds, options = {}) {
    if (!isValidBounds(bounds)) return;
    const paddingPx = Number.isFinite(options.paddingPx) && options.paddingPx >= 0 ? options.paddingPx : defaultPaddingPx;
    const maxZoom = Number.isFinite(options.maxZoom) && options.maxZoom > 0 ? options.maxZoom : undefined;
    lastBounds = cloneBounds(bounds);
    lastOptions = { paddingPx };
    if (maxZoom !== undefined) {
      lastOptions.maxZoom = maxZoom;
    } else {
      delete lastOptions.maxZoom;
    }
  }

  /**
   * Return a snapshot of the most recently recorded fit bounds.
   *
   * @returns {{ bounds: LatLngBoundsTuple, options: FitOptionsSnapshot } | null} Snapshot or ``null`` when unavailable.
   */
  function getLastFit() {
    if (!lastBounds) return null;
    return { bounds: cloneBounds(lastBounds), options: { ...lastOptions } };
  }

  /**
   * Test whether auto-fit is currently enabled by the user.
   *
   * @returns {boolean} True when the toggle exists and is checked.
   */
  function isAutoFitEnabled() {
    return Boolean(toggleEl && toggleEl.checked);
  }

  /**
   * Execute a callback while marking auto-fit as in-progress.
   *
   * @template T
   * @param {() => T} fn - Operation to run while suppressing interaction side-effects.
   * @returns {T | undefined} Result of ``fn`` when provided.
   */
  function runAutoFitOperation(fn) {
    if (typeof fn !== 'function') return undefined;
    autoFitInProgress = true;
    try {
      return fn();
    } finally {
      autoFitInProgress = false;
    }
  }

  /**
   * Disable auto-fit in response to manual user interactions with the map.
   *
   * @returns {boolean} True when the toggle was modified.
   */
  function handleUserInteraction() {
    if (!toggleEl || !toggleEl.checked || autoFitInProgress) {
      return false;
    }
    toggleEl.checked = false;
    const event = new Event('change', { bubbles: true });
    toggleEl.dispatchEvent(event);
    return true;
  }

  /**
   * Attach resize listeners that notify the consumer when a refit may be required.
   *
   * @param {(snapshot: { bounds: LatLngBoundsTuple, options: FitOptionsSnapshot } | null) => void} callback - Resize handler.
   * @returns {() => void} Function that removes the registered listeners.
   */
  function attachResizeListener(callback) {
    if (!windowObject || typeof windowObject.addEventListener !== 'function' || typeof callback !== 'function') {
      return () => {};
    }
    const handler = () => {
      callback(getLastFit());
    };
    windowObject.addEventListener('resize', handler, { passive: true });
    windowObject.addEventListener('orientationchange', handler, { passive: true });
    return () => {
      windowObject.removeEventListener('resize', handler);
      windowObject.removeEventListener('orientationchange', handler);
    };
  }

  return {
    attachResizeListener,
    getLastFit,
    handleUserInteraction,
    isAutoFitEnabled,
    recordFit,
    runAutoFitOperation
  };
}
