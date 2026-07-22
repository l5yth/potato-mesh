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
 * static ``grayscale``/``invert`` CSS filter on ``.map-tiles-hot``. **CARTO
 * Voyager** (also a natively colourful raster basemap) is retained as a
 * **per-tile fallback**: any HOT tile that errors or fails to load within
 * {@link FALLBACK_TIMEOUT_MS} is individually replaced by the CARTO tile at the
 * same coordinate (see ``main/fallback-tile-layer.js``) and is greyed by the
 * *same* dark filter (``.map-tiles-fallback``), so a viewport mixing both
 * providers renders as one coherent dark basemap rather than a light/dark
 * checkerboard. Both providers are keyless, CORS-enabled public CDNs.
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
 * Tile URL template for the CARTO Voyager fallback basemap.
 *
 * Voyager is CARTO's natively colourful raster style (unlike the previously used
 * Dark Matter, which was already dark). A colourful source is deliberate: the
 * per-tile CARTO fallback is greyed by the *same* ``grayscale``/``invert`` filter
 * as HOT (``.map-tiles-fallback``), so both providers converge to the same dark
 * look. ``{s}`` rotates over the ``abcd`` subdomains, ``{r}`` expands to ``@2x``
 * on HiDPI displays, and ``{z}/{x}/{y}`` is the standard slippy-map tile
 * coordinate.
 *
 * @type {string}
 */
export const CARTO_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

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
 * neither loaded nor errored within this window is swapped to CARTO. Set at
 * **2500 ms** (raised from an aggressive 1000 ms) so a slow-but-arriving HOT tile
 * beats the deadline rather than falling back — keeping fallback the rare safety
 * net it is meant to be, given HOT's real-world latency. Fewer routine fallbacks
 * (combined with the shared dark filter on ``.map-tiles-fallback``) is what keeps
 * a viewport from rendering as a HOT/CARTO checkerboard.
 *
 * @type {number}
 */
export const FALLBACK_TIMEOUT_MS = 2500;

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
