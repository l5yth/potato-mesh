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
 * Basemap-liveness policy: decide when the online basemap has *comprehensively*
 * failed and the offline placeholder should take over.
 *
 * A few isolated tile errors — a gap over the ocean at high zoom, a stray 404 —
 * must **not** blank the whole map. The offline fallback is reserved for the
 * case where the basemap is genuinely unreachable: the initial viewport
 * produced **no** successful tiles. Once any tile has loaded the basemap is
 * latched "alive" and later isolated errors are ignored, so a transient blip
 * never tears down a working map.
 *
 * The policy is intentionally Leaflet-free (it consumes plain event signals, not
 * Leaflet objects) so it can be unit-tested standalone; the dashboard wires
 * Leaflet's ``tileload`` / ``tileerror`` / ``load`` events to it.
 *
 * @module main/tile-failure-policy
 */

/**
 * Default number of pre-success tile errors that, with zero successes, is
 * treated as comprehensive failure even before Leaflet's ``load`` event fires.
 *
 * This defends against a provider whose tiles are slow to resolve the layer
 * ``load`` while clearly failing (every request erroring). Eight covers a
 * typical initial viewport without firing on a couple of incidental misses.
 *
 * @type {number}
 */
export const DEFAULT_ERROR_THRESHOLD = 8;

/**
 * Create a basemap-liveness policy instance.
 *
 * Each ``record*`` method returns ``true`` **iff** that event should trigger the
 * offline fallback *now*. The policy latches: it returns ``true`` at most once,
 * and never after a tile has successfully loaded.
 *
 * @param {{errorThreshold?: number}} [options] Optional configuration.
 *   ``errorThreshold`` overrides {@link DEFAULT_ERROR_THRESHOLD}; non-positive or
 *   non-finite values fall back to the default.
 * @returns {{
 *   recordTileLoad: function(): boolean,
 *   recordTileError: function(): boolean,
 *   recordLayerLoad: function(): boolean,
 *   isAlive: function(): boolean,
 *   hasActivatedOffline: function(): boolean
 * }} The policy handle.
 */
export function createTileFailurePolicy(options = {}) {
  const requested = options ? options.errorThreshold : undefined;
  const errorThreshold =
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_ERROR_THRESHOLD;

  let successes = 0;
  let errors = 0;
  let alive = false;
  let offlineActivated = false;

  /**
   * Latch the one-shot offline activation. Returns ``true`` only the first time
   * it is reached while the basemap is not alive.
   *
   * @returns {boolean} Whether the offline fallback should activate now.
   */
  function activateOnce() {
    if (alive || offlineActivated) return false;
    offlineActivated = true;
    return true;
  }

  return {
    /**
     * Record a successful tile load. Latches the basemap "alive" so no later
     * error can trigger the fallback.
     *
     * @returns {boolean} Always ``false`` — a success never triggers fallback.
     */
    recordTileLoad() {
      successes += 1;
      alive = true;
      return false;
    },

    /**
     * Record a failed tile. Triggers the fallback only when no tile has ever
     * loaded **and** the pre-success error count has crossed the threshold.
     *
     * @returns {boolean} Whether the offline fallback should activate now.
     */
    recordTileError() {
      errors += 1;
      if (alive) return false;
      if (errors >= errorThreshold) return activateOnce();
      return false;
    },

    /**
     * Record Leaflet's layer ``load`` event (the current viewport finished
     * loading every tile, success or error). Triggers the fallback when the
     * viewport produced zero successes but did attempt tiles (at least one
     * error) — i.e. the basemap is unreachable, not merely empty.
     *
     * @returns {boolean} Whether the offline fallback should activate now.
     */
    recordLayerLoad() {
      if (successes === 0 && errors > 0) return activateOnce();
      return false;
    },

    /**
     * @returns {boolean} Whether any tile has loaded (the basemap is alive).
     */
    isAlive() {
      return alive;
    },

    /**
     * @returns {boolean} Whether the offline fallback has been activated.
     */
    hasActivatedOffline() {
      return offlineActivated;
    },
  };
}
