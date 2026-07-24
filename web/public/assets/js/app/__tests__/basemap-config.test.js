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
 * Unit tests for the shared stacked-basemap factory.
 *
 * The basemap is two always-on native Leaflet tile layers — a CARTO Voyager base
 * and an opaque HOT overlay stacked on top — built once by
 * {@link createBasemapLayer} and shared by both maps. These tests lock the URLs,
 * the per-layer options (classes, subdomains, retina, z-index stacking), and the
 * ``{ base, overlay }`` / ``null`` factory contract.
 *
 * @module __tests__/basemap-config
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOT_TILE_URL,
  HOT_TILE_OPTIONS,
  CARTO_TILE_URL,
  CARTO_TILE_OPTIONS,
  createBasemapLayer,
} from '../basemap-config.js';

/**
 * Build a minimal Leaflet stub whose ``tileLayer(url, options)`` records its
 * arguments, mirroring the shape ``createBasemapLayer`` consumes. ``calls``
 * captures every constructed layer in order for assertions.
 *
 * @returns {{tileLayer: Function, calls: Array<{url: string, options: Object}>}}
 *   The stub and its call log.
 */
function makeLeafletStub() {
  const calls = [];
  return {
    calls,
    tileLayer(url, options) {
      const layer = { _url: url, options: options || {} };
      calls.push(layer);
      return layer;
    },
  };
}

test('HOT is the overlay tile source with the dark-filter class and top z-index', () => {
  assert.match(HOT_TILE_URL, /tile\.openstreetmap\.fr\/hot/);
  assert.equal(HOT_TILE_OPTIONS.subdomains, 'abc');
  assert.equal(HOT_TILE_OPTIONS.crossOrigin, 'anonymous');
  assert.equal(HOT_TILE_OPTIONS.maxZoom, 19);
  assert.equal(HOT_TILE_OPTIONS.className, 'map-tiles-hot');
  assert.equal(HOT_TILE_OPTIONS.zIndex, 2);
});

test('CARTO Voyager is the base tile source with the dark-filter class and bottom z-index', () => {
  assert.match(CARTO_TILE_URL, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
  assert.equal(CARTO_TILE_OPTIONS.subdomains, 'abcd');
  assert.equal(CARTO_TILE_OPTIONS.detectRetina, true);
  assert.equal(CARTO_TILE_OPTIONS.crossOrigin, 'anonymous');
  assert.equal(CARTO_TILE_OPTIONS.maxZoom, 19);
  assert.equal(CARTO_TILE_OPTIONS.className, 'map-tiles-fallback');
  assert.equal(CARTO_TILE_OPTIONS.zIndex, 1);
});

test('the HOT overlay stacks above the CARTO base (opaque coverage)', () => {
  // The overlay must sit above the base so a loaded (opaque) HOT tile covers the
  // CARTO tile beneath it; neither layer reduces its own opacity (dimming is the
  // single pane veil in base.css, SB4).
  assert.ok(HOT_TILE_OPTIONS.zIndex > CARTO_TILE_OPTIONS.zIndex);
  assert.equal(HOT_TILE_OPTIONS.opacity, undefined);
  assert.equal(CARTO_TILE_OPTIONS.opacity, undefined);
});

test('createBasemapLayer returns null when Leaflet is unavailable', () => {
  assert.equal(createBasemapLayer(null), null);
  assert.equal(createBasemapLayer(undefined), null);
  assert.equal(createBasemapLayer({}), null);
});

test('createBasemapLayer builds the CARTO base + HOT overlay pair', () => {
  const L = makeLeafletStub();
  const layers = createBasemapLayer(L);

  assert.ok(layers);
  assert.deepEqual(Object.keys(layers).sort(), ['base', 'overlay']);

  // Base is CARTO Voyager with its options; overlay is HOT with its options.
  assert.equal(layers.base._url, CARTO_TILE_URL);
  assert.equal(layers.base.options, CARTO_TILE_OPTIONS);
  assert.equal(layers.overlay._url, HOT_TILE_URL);
  assert.equal(layers.overlay.options, HOT_TILE_OPTIONS);

  // Both are built via L.tileLayer (native layers, no custom subclass), base first.
  assert.equal(L.calls.length, 2);
  assert.equal(L.calls[0]._url, CARTO_TILE_URL);
  assert.equal(L.calls[1]._url, HOT_TILE_URL);
});
