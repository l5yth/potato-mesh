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

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOT_TILE_URL,
  HOT_TILE_OPTIONS,
  CARTO_TILE_URL,
  CARTO_TILE_OPTIONS,
  FALLBACK_TIMEOUT_MS,
  prefersRetinaTiles,
  createBasemapLayer,
} from '../basemap-config.js';
import {
  HOT_TILE_CLASS,
  FALLBACK_TILE_CLASS,
} from '../main/fallback-tile-layer.js';
import {
  makeLeafletTileLayerStub,
  withImgDocument,
} from '../main/__tests__/tile-test-helpers.js';

test('HOT is the primary tile source; CARTO is retained for the fallback', () => {
  assert.match(HOT_TILE_URL, /tile\.openstreetmap\.fr\/hot/);
  assert.equal(HOT_TILE_OPTIONS.subdomains, 'abc');
  assert.equal(HOT_TILE_OPTIONS.crossOrigin, 'anonymous');
  assert.equal(HOT_TILE_OPTIONS.maxZoom, 19);
  assert.match(CARTO_TILE_URL, /basemaps\.cartocdn\.com\/dark_all/);
  assert.equal(CARTO_TILE_OPTIONS.subdomains, 'abcd');
  assert.equal(CARTO_TILE_OPTIONS.detectRetina, true);
  assert.equal(FALLBACK_TIMEOUT_MS, 1000);
});

test('prefersRetinaTiles reflects the device pixel ratio', () => {
  const previous = globalThis.devicePixelRatio;
  try {
    globalThis.devicePixelRatio = 2;
    assert.equal(prefersRetinaTiles(), true);
    globalThis.devicePixelRatio = 1;
    assert.equal(prefersRetinaTiles(), false);
    globalThis.devicePixelRatio = undefined;
    assert.equal(prefersRetinaTiles(), false);
  } finally {
    globalThis.devicePixelRatio = previous;
  }
});

test('createBasemapLayer returns null when Leaflet is unavailable', () => {
  assert.equal(createBasemapLayer(null), null);
});

test('createBasemapLayer builds the HOT-primary layer with CARTO fallback wiring', () => {
  const previous = globalThis.devicePixelRatio;
  const doc = withImgDocument();
  try {
    globalThis.devicePixelRatio = 1; // non-retina fallback
    const L = makeLeafletTileLayerStub();
    const layer = createBasemapLayer(L);
    assert.ok(layer);
    assert.equal(layer._url, HOT_TILE_URL);
    assert.equal(layer.options, HOT_TILE_OPTIONS);
    const tile = layer.createTile({ x: 2, y: 1, z: 6 }, () => {});
    assert.equal(tile.classList.contains(HOT_TILE_CLASS), true);
    // (2 + 1) % 3 = 0 -> 'a' HOT
    assert.equal(tile.src, 'https://a.tile.openstreetmap.fr/hot/6/2/1.png');
    tile.dispatch('error'); // fall back
    // (2 + 1) % 4 = 3 -> 'd' CARTO, non-retina
    assert.equal(tile.src, 'https://d.basemaps.cartocdn.com/dark_all/6/2/1.png');
    assert.equal(tile.classList.contains(FALLBACK_TILE_CLASS), true);
  } finally {
    globalThis.devicePixelRatio = previous;
    doc.restore();
  }
});

test('createBasemapLayer requests @2x CARTO fallback tiles on HiDPI displays', () => {
  const previous = globalThis.devicePixelRatio;
  const doc = withImgDocument();
  try {
    globalThis.devicePixelRatio = 3;
    const L = makeLeafletTileLayerStub();
    const layer = createBasemapLayer(L);
    const tile = layer.createTile({ x: 0, y: 0, z: 2 }, () => {});
    tile.dispatch('error');
    assert.match(tile.src, /@2x\.png$/);
  } finally {
    globalThis.devicePixelRatio = previous;
    doc.restore();
  }
});
