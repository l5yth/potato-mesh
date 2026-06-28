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
 * (``app/federation-page.js``) render the same basemap, so the tile URL and
 * layer options live here once instead of being duplicated per page.
 *
 * The basemap is **CARTO Dark Matter** — a keyless, CORS-enabled, natively
 * dark-grey raster basemap. Because the tiles are already dark-grey there is no
 * CSS colour filter: the previous ``grayscale``/``invert`` pipeline (a remnant
 * of the removed light theme) was deleted along with this swap.
 *
 * @module app/basemap-config
 */

/**
 * Tile URL template for the CARTO Dark Matter basemap.
 *
 * ``{s}`` rotates over the ``abcd`` subdomains, ``{r}`` expands to ``@2x`` on
 * HiDPI displays (via ``detectRetina``) for crisp tiles, and ``{z}/{x}/{y}`` is
 * the standard slippy-map tile coordinate.
 *
 * @type {string}
 */
export const TILE_LAYER_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

/**
 * Leaflet ``tileLayer`` options shared by every map.
 *
 * - ``maxZoom`` caps zoom at the basemap's supported detail level.
 * - ``className`` tags tiles for CSS (opacity) and offline-fallback styling.
 * - ``crossOrigin`` requests tiles with CORS so the canvas-based OG-image
 *   capture and any pixel reads stay untainted (CARTO returns
 *   ``access-control-allow-origin: *``).
 * - ``subdomains`` spreads requests across CARTO's four tile hosts.
 * - ``detectRetina`` serves ``@2x`` tiles on HiDPI displays.
 *
 * @type {{maxZoom: number, className: string, crossOrigin: string, subdomains: string, detectRetina: boolean}}
 */
export const TILE_LAYER_OPTIONS = {
  maxZoom: 19,
  className: 'map-tiles',
  crossOrigin: 'anonymous',
  subdomains: 'abcd',
  detectRetina: true,
};
