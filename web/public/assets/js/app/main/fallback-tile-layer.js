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
 * Per-tile timeout → CARTO fallback basemap tile layer.
 *
 * The primary basemap is OpenStreetMap France **HOT** (Humanitarian OSM Team),
 * dark-styled by the CSS ``grayscale``/``invert`` filter on
 * {@link HOT_TILE_CLASS}. Any HOT tile that fires ``error`` or fails to load
 * within a short timeout is individually swapped to the corresponding **CARTO
 * Voyager** tile at the same ``z/x/y``; the swapped tile drops
 * {@link HOT_TILE_CLASS} for {@link FALLBACK_TILE_CLASS}, which carries the
 * *same* dark filter (both providers are natively colourful), so a fallback tile
 * blends with its HOT neighbours instead of standing out as a checkerboard cell.
 *
 * The URL builder ({@link buildFallbackTileUrl}) and the per-tile state machine
 * ({@link wireTileFallback}) are Leaflet-free — they operate on a plain
 * ``<img>``-shaped object and injectable timers, so they unit-test standalone.
 * {@link createFallbackTileLayer} supplies the thin Leaflet ``TileLayer``
 * subclass that wires them to Leaflet's ``createTile`` / ``done`` contract, so an
 * isolated HOT failure feeds Leaflet a ``tileload`` (via CARTO) rather than a
 * ``tileerror`` — only a tile that fails on **both** providers signals
 * ``tileerror`` to the dashboard's offline-fallback policy.
 *
 * @module main/fallback-tile-layer
 */

/**
 * CSS class marking a HOT tile that receives the dark colour filter.
 *
 * Leaflet applies a layer's ``className`` option to the tile *container*, not to
 * each ``<img>``, so per-tile filtering (HOT filtered, CARTO fallback not)
 * requires a class on the individual tile element. This is that class.
 *
 * @type {string}
 */
export const HOT_TILE_CLASS = 'map-tiles-hot';

/**
 * CSS class marking a tile that has fallen back to CARTO.
 *
 * Carries the same ``grayscale``/``invert`` dark filter as {@link HOT_TILE_CLASS}
 * (CARTO Voyager is natively colourful, like HOT), so a fallback tile blends with
 * its HOT neighbours rather than reading as a distinct checkerboard cell.
 *
 * @type {string}
 */
export const FALLBACK_TILE_CLASS = 'map-tiles-fallback';

/**
 * Build the CARTO fallback tile URL for a Leaflet tile coordinate.
 *
 * Pure string templating (no Leaflet): substitutes ``{s}`` (subdomain, chosen
 * from ``subdomains`` by ``(x + y) % length``), ``{r}`` (``@2x`` when ``retina``,
 * else empty), and ``{z}`` / ``{x}`` / ``{y}``. The CARTO tile at the *same*
 * ``z/x/y`` as the HOT tile covers the identical geographic area, so no zoom
 * offset is applied; ``@2x`` merely requests a higher-DPI render of that tile.
 *
 * @param {{x: number, y: number, z: number}} coords Leaflet tile coordinate.
 * @param {{template: string, subdomains: string, retina: boolean}} config CARTO URL config.
 * @returns {string} The fully-substituted CARTO tile URL.
 */
export function buildFallbackTileUrl(coords, config) {
  const subdomains = config.subdomains || 'abc';
  const index = Math.abs((coords.x || 0) + (coords.y || 0)) % subdomains.length;
  const subdomain = subdomains.charAt(index);
  const retinaSuffix = config.retina ? '@2x' : '';
  return config.template
    .replace('{s}', subdomain)
    .replace('{r}', retinaSuffix)
    .replace('{z}', String(coords.z))
    .replace('{x}', String(coords.x))
    .replace('{y}', String(coords.y));
}

/**
 * Wire a tile ``<img>`` to the HOT-primary / CARTO-fallback state machine.
 *
 * Sets the HOT ``src`` and starts a ``timeoutMs`` timer. On HOT ``load`` the tile
 * is kept (filtered) and the timer cancelled. On HOT ``error`` **or** timer
 * expiry the tile is swapped to ``fallbackUrl``, its {@link HOT_TILE_CLASS}
 * replaced by {@link FALLBACK_TILE_CLASS}. The Leaflet ``done(err, tile)``
 * callback is invoked exactly once, at the terminal state: ``done(null, tile)``
 * when HOT **or** CARTO serves the tile (Leaflet ``tileload``), and
 * ``done(error, tile)`` only when the CARTO fallback *also* fails (``tileerror``).
 *
 * @param {Object} tile Tile element — a DOM ``<img>`` or a compatible test double
 *   exposing ``addEventListener``, ``removeEventListener``, ``classList``, and ``src``.
 * @param {Object} options Wiring options.
 * @param {string} options.hotUrl Primary HOT tile URL.
 * @param {string} options.fallbackUrl CARTO fallback tile URL.
 * @param {number} options.timeoutMs Milliseconds to wait for HOT before swapping.
 * @param {function(Error=, Object=): void} options.done Leaflet tile-ready callback.
 * @param {function(function, number): *} [options.setTimeoutFn] Timer scheduler (injectable for tests).
 * @param {function(*): void} [options.clearTimeoutFn] Timer canceller (injectable for tests).
 * @returns {{isSettled: function(): boolean, isFallback: function(): boolean}} Handle for tests/cleanup.
 */
export function wireTileFallback(tile, options) {
  const {
    hotUrl,
    fallbackUrl,
    timeoutMs,
    done,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  let settled = false;
  let fellBack = false;
  let timer = null;

  /**
   * Cancel the pending HOT timeout. ``clearTimeout`` on a ``null`` / already-fired
   * id is a documented no-op, so no guard is needed.
   *
   * @returns {void}
   */
  function cancelTimer() {
    clearTimeoutFn(timer);
    timer = null;
  }

  /**
   * Terminal success: the HOT tile loaded before the timeout elapsed.
   *
   * @returns {void}
   */
  function handleHotLoad() {
    if (settled) return;
    settled = true;
    cancelTimer();
    done(null, tile);
  }

  /**
   * Terminal success: the swapped-in CARTO fallback tile loaded.
   *
   * @returns {void}
   */
  function handleFallbackLoad() {
    done(null, tile);
  }

  /**
   * Terminal failure: the CARTO fallback tile also failed to load.
   *
   * @param {*} [event] The DOM error event (or an Error).
   * @returns {void}
   */
  function handleFallbackError(event) {
    done(
      event instanceof Error ? event : new Error('basemap tile failed on both providers'),
      tile
    );
  }

  /**
   * Swap the tile to the CARTO fallback source exactly once.
   *
   * @returns {void}
   */
  function swapToFallback() {
    if (settled) return;
    settled = true;
    fellBack = true;
    cancelTimer();
    tile.removeEventListener('load', handleHotLoad);
    tile.removeEventListener('error', handleHotError);
    if (tile.classList) {
      tile.classList.remove(HOT_TILE_CLASS);
      tile.classList.add(FALLBACK_TILE_CLASS);
    }
    tile.addEventListener('load', handleFallbackLoad, { once: true });
    tile.addEventListener('error', handleFallbackError, { once: true });
    tile.src = fallbackUrl;
  }

  /**
   * The HOT tile errored — trigger the fallback swap.
   *
   * @returns {void}
   */
  function handleHotError() {
    swapToFallback();
  }

  tile.addEventListener('load', handleHotLoad);
  tile.addEventListener('error', handleHotError);
  tile.src = hotUrl;
  timer = setTimeoutFn(swapToFallback, timeoutMs);

  return {
    isSettled: () => settled,
    isFallback: () => fellBack,
  };
}

/**
 * Create the Leaflet HOT-primary / CARTO-fallback basemap tile layer.
 *
 * Returns ``null`` when Leaflet (or its extendable ``TileLayer``) is unavailable,
 * so callers can degrade gracefully — mirroring ``createOfflineTileLayer``.
 *
 * @param {Object|null} L Leaflet global.
 * @param {Object} config Layer configuration.
 * @param {string} config.hotUrl Primary HOT tile-URL template.
 * @param {Object} config.hotOptions Leaflet ``TileLayer`` options for the HOT layer.
 * @param {string} config.fallbackUrl CARTO fallback tile-URL template.
 * @param {string} config.fallbackSubdomains CARTO subdomains string.
 * @param {boolean} config.fallbackRetina Whether to request ``@2x`` CARTO tiles.
 * @param {number} config.timeoutMs Per-tile HOT timeout (ms) before falling back.
 * @returns {Object|null} A configured Leaflet tile layer, or ``null`` when Leaflet is missing.
 */
export function createFallbackTileLayer(L, config) {
  if (!L || !L.TileLayer || typeof L.TileLayer.extend !== 'function') {
    return null;
  }
  const FallbackTileLayer = L.TileLayer.extend({
    /**
     * Create a tile ``<img>`` wired to the HOT→CARTO per-tile fallback.
     *
     * @param {{x: number, y: number, z: number}} coords Leaflet tile coordinate.
     * @param {function(Error=, HTMLElement=): void} done Leaflet tile-ready callback.
     * @returns {HTMLElement} The tile image element.
     */
    createTile(coords, done) {
      const tile = document.createElement('img');
      if (tile.classList) {
        tile.classList.add(HOT_TILE_CLASS);
      }
      const crossOrigin = this.options.crossOrigin;
      if (crossOrigin || crossOrigin === '') {
        tile.crossOrigin = crossOrigin === true ? '' : crossOrigin;
      }
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      wireTileFallback(tile, {
        hotUrl: this.getTileUrl(coords),
        fallbackUrl: buildFallbackTileUrl(coords, {
          template: config.fallbackUrl,
          subdomains: config.fallbackSubdomains,
          retina: config.fallbackRetina,
        }),
        timeoutMs: config.timeoutMs,
        done,
      });
      return tile;
    },
  });
  return new FallbackTileLayer(config.hotUrl, config.hotOptions);
}
