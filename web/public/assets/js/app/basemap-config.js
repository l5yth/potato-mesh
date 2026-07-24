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
 * Shared basemap (map tile) configuration for every Leaflet map in the app.
 *
 * Both the dashboard map (``app/main.js``) and the federation map
 * (``app/federation-page.js``) render the same basemap through a single factory
 * ({@link createBasemapLayer}), so the tile URLs and layer options live here once
 * instead of being duplicated per page.
 *
 * **Two always-on stacked layers.** The basemap is built from two native Leaflet
 * tile layers requested simultaneously on every viewport:
 *
 * - a **base** layer — CARTO **Voyager**, a natively colourful raster basemap
 *   ({@link CARTO_TILE_URL}, ``zIndex`` 1);
 * - an **overlay** layer — OpenStreetMap France **HOT** (Humanitarian OSM Team),
 *   also natively colourful ({@link HOT_TILE_URL}, ``zIndex`` 2), rendered
 *   **opaque** so a loaded HOT tile fully covers the CARTO tile beneath it.
 *
 * Both wear the *same* ``grayscale``/``invert`` dark filter (``.map-tiles-hot`` /
 * ``.map-tiles-fallback`` in ``base.css``), so a viewport mixing an
 * already-arrived HOT tile and a not-yet-arrived cell (where the CARTO base shows
 * through) renders as one coherent dark basemap rather than a light/dark
 * checkerboard. Because both layers load at once, a slow HOT tile shows the
 * already-present CARTO tile in the meantime instead of a blank cell — there is
 * **no** per-tile deadline or swap (the earlier timeout mechanism is retired).
 * Each HOT tile fades in over Leaflet's built-in tile-fade (~200 ms) as it lands,
 * so the CARTO→HOT handover reads as a dissolve. Both providers are keyless,
 * cookieless, CORS-enabled public CDNs.
 *
 * @module app/basemap-config
 */

/**
 * Tile URL template for the OpenStreetMap France HOT overlay basemap.
 *
 * ``{s}`` rotates over the ``abc`` subdomains and ``{z}/{x}/{y}`` is the standard
 * slippy-map tile coordinate. HOT serves no ``@2x`` retina variant, so the
 * template carries no ``{r}`` suffix.
 *
 * @type {string}
 */
export const HOT_TILE_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';

/**
 * Leaflet ``tileLayer`` options for the HOT **overlay** layer.
 *
 * - ``maxZoom`` caps zoom at the basemap's supported detail level.
 * - ``className`` tags the layer *container* (``.leaflet-layer``) so the static
 *   dark tile filter in ``base.css`` greys HOT's whole tile set as a group.
 * - ``crossOrigin`` requests tiles with CORS so the canvas-based OG-image capture
 *   and any pixel reads stay untainted (HOT serves ``access-control-allow-origin``).
 * - ``subdomains`` spreads requests across HOT's three tile hosts (``a``/``b``/``c``).
 * - ``zIndex`` ``2`` stacks HOT **above** the CARTO base ({@link CARTO_TILE_OPTIONS}),
 *   so a loaded (opaque) HOT tile covers the CARTO tile beneath it.
 *
 * @type {{maxZoom: number, className: string, crossOrigin: string, subdomains: string, zIndex: number}}
 */
export const HOT_TILE_OPTIONS = {
  maxZoom: 19,
  className: 'map-tiles-hot',
  crossOrigin: 'anonymous',
  subdomains: 'abc',
  zIndex: 2,
};

/**
 * Tile URL template for the CARTO Voyager base basemap.
 *
 * Voyager is CARTO's natively colourful raster style (unlike the previously used
 * Dark Matter, which was already dark). A colourful source is deliberate: the
 * base layer is greyed by the *same* ``grayscale``/``invert`` filter as the HOT
 * overlay (``.map-tiles-fallback``), so both providers converge to the same dark
 * look and a HOT/CARTO mix never reads as a checkerboard. ``{s}`` rotates over the
 * ``abcd`` subdomains, ``{r}`` expands to ``@2x`` on HiDPI displays (via Leaflet's
 * native ``detectRetina``), and ``{z}/{x}/{y}`` is the standard slippy-map tile
 * coordinate.
 *
 * @type {string}
 */
export const CARTO_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

/**
 * Leaflet ``tileLayer`` options for the CARTO Voyager **base** layer.
 *
 * - ``maxZoom`` matches the HOT overlay's cap.
 * - ``className`` tags the layer *container* so the static dark tile filter in
 *   ``base.css`` greys CARTO's whole tile set identically to HOT.
 * - ``crossOrigin`` keeps the canvas OG-image capture untainted.
 * - ``subdomains`` spreads requests across CARTO's four tile hosts.
 * - ``detectRetina`` lets Leaflet request ``@2x`` tiles on HiDPI displays.
 * - ``zIndex`` ``1`` places CARTO **below** the HOT overlay ({@link HOT_TILE_OPTIONS}).
 *
 * @type {{maxZoom: number, className: string, crossOrigin: string, subdomains: string, detectRetina: boolean, zIndex: number}}
 */
export const CARTO_TILE_OPTIONS = {
  maxZoom: 19,
  className: 'map-tiles-fallback',
  crossOrigin: 'anonymous',
  subdomains: 'abcd',
  detectRetina: true,
  zIndex: 1,
};

/**
 * Build the shared stacked basemap for both maps.
 *
 * Returns the CARTO Voyager **base** layer and the HOT **overlay** layer as a
 * ``{ base, overlay }`` pair — both native ``L.tileLayer`` instances, meant to be
 * added to the map together (base first, overlay second). Returns ``null`` when
 * Leaflet (or its ``tileLayer`` factory) is unavailable; both call sites
 * (``main.js`` / ``federation-page.js``) only invoke this inside an existing
 * Leaflet-presence guard, so the ``null`` return is a defensive contract
 * exercised by unit tests rather than a runtime path with real Leaflet.
 *
 * @param {Object|null} L Leaflet global.
 * @returns {{base: Object, overlay: Object}|null} The base/overlay layer pair, or
 *   ``null`` when Leaflet is missing.
 */
export function createBasemapLayer(L) {
  if (!L || typeof L.tileLayer !== 'function') {
    return null;
  }
  return {
    base: L.tileLayer(CARTO_TILE_URL, CARTO_TILE_OPTIONS),
    overlay: L.tileLayer(HOT_TILE_URL, HOT_TILE_OPTIONS),
  };
}
