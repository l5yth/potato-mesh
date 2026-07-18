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
 * ({@link createBasemapLayer}), so the tile URLs, layer options, and fallback
 * behaviour live here once instead of being duplicated per page.
 *
 * The **primary** basemap is OpenStreetMap France **HOT** (Humanitarian OSM
 * Team) — a natively colourful raster basemap greyed to match the dark UI by the
 * static ``grayscale``/``invert`` CSS filter on ``.map-tiles-hot``. **CARTO Dark
 * Matter** (natively dark-grey) is retained as a **per-tile fallback**: any HOT
 * tile that errors or fails to load within {@link FALLBACK_TIMEOUT_MS} is
 * individually replaced by the CARTO tile at the same coordinate (see
 * ``main/fallback-tile-layer.js``). Both providers are keyless, CORS-enabled
 * public CDNs.
 *
 * @module app/basemap-config
 */

import { createFallbackTileLayer } from './main/fallback-tile-layer.js';

/**
 * Tile URL template for the primary OpenStreetMap France HOT basemap.
 *
 * ``{s}`` rotates over the ``abc`` subdomains and ``{z}/{x}/{y}`` is the standard
 * slippy-map tile coordinate. HOT serves no ``@2x`` retina variant, so the
 * template carries no ``{r}`` suffix.
 *
 * @type {string}
 */
export const HOT_TILE_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';

/**
 * Leaflet ``tileLayer`` options for the primary HOT layer.
 *
 * - ``maxZoom`` caps zoom at the basemap's supported detail level.
 * - ``className`` tags the tile *container* for the existing tile-pane opacity.
 * - ``crossOrigin`` requests tiles with CORS so the canvas-based OG-image capture
 *   and any pixel reads stay untainted (HOT serves ``access-control-allow-origin``).
 * - ``subdomains`` spreads requests across HOT's three tile hosts (``a``/``b``/``c``).
 *
 * @type {{maxZoom: number, className: string, crossOrigin: string, subdomains: string}}
 */
export const HOT_TILE_OPTIONS = {
  maxZoom: 19,
  className: 'map-tiles',
  crossOrigin: 'anonymous',
  subdomains: 'abc',
};

/**
 * Tile URL template for the CARTO Dark Matter fallback basemap.
 *
 * ``{s}`` rotates over the ``abcd`` subdomains, ``{r}`` expands to ``@2x`` on
 * HiDPI displays, and ``{z}/{x}/{y}`` is the standard slippy-map tile coordinate.
 *
 * @type {string}
 */
export const CARTO_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

/**
 * Leaflet ``tileLayer`` options describing the CARTO fallback source.
 *
 * Only ``subdomains`` and ``detectRetina`` are consumed to build a fallback tile
 * URL ({@link createBasemapLayer}); the layer itself is never instantiated,
 * because CARTO tiles are fetched per-tile only when a HOT tile fails.
 *
 * @type {{maxZoom: number, className: string, crossOrigin: string, subdomains: string, detectRetina: boolean}}
 */
export const CARTO_TILE_OPTIONS = {
  maxZoom: 19,
  className: 'map-tiles',
  crossOrigin: 'anonymous',
  subdomains: 'abcd',
  detectRetina: true,
};

/**
 * Per-tile timeout, in milliseconds, before a slow HOT tile falls back to CARTO.
 *
 * The single source of truth for the fallback deadline; a HOT tile that has
 * neither loaded nor errored within this window is swapped to CARTO.
 *
 * @type {number}
 */
export const FALLBACK_TIMEOUT_MS = 1000;

/**
 * Whether the current display should request ``@2x`` (HiDPI) fallback tiles.
 *
 * Mirrors Leaflet's ``detectRetina`` heuristic using ``devicePixelRatio`` so the
 * CARTO fallback matches the crispness the primary layer would deliver.
 *
 * @returns {boolean} ``true`` when the device pixel ratio exceeds 1.
 */
export function prefersRetinaTiles() {
  return (
    typeof globalThis !== 'undefined' &&
    Number.isFinite(globalThis.devicePixelRatio) &&
    globalThis.devicePixelRatio > 1
  );
}

/**
 * Build the shared basemap tile layer used by both maps.
 *
 * Returns the HOT-primary layer with per-tile CARTO fallback (built by
 * ``createFallbackTileLayer``), or ``null`` when Leaflet (or its extendable
 * ``TileLayer``) is unavailable. Both call sites (``main.js`` /
 * ``federation-page.js``) only invoke this inside an existing Leaflet-presence
 * guard, so the ``null`` return is a defensive contract exercised by unit tests
 * rather than a runtime path with real Leaflet.
 *
 * @param {Object|null} L Leaflet global.
 * @returns {Object|null} A configured Leaflet tile layer, or ``null`` when Leaflet is missing.
 */
export function createBasemapLayer(L) {
  return createFallbackTileLayer(L, {
    hotUrl: HOT_TILE_URL,
    hotOptions: HOT_TILE_OPTIONS,
    fallbackUrl: CARTO_TILE_URL,
    fallbackSubdomains: CARTO_TILE_OPTIONS.subdomains,
    fallbackRetina: prefersRetinaTiles(),
    timeoutMs: FALLBACK_TIMEOUT_MS,
  });
}
