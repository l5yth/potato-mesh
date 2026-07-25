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
 * SB-A5 — dashboard basemap wiring: two stacked layers feed one liveness policy.
 *
 * The dashboard basemap is a CARTO Voyager base under an opaque HOT overlay
 * ({@link createBasemapLayer}); ``initializeApp`` adds both to the map and wires
 * a single ``createTileFailurePolicy`` to BOTH layers' ``tileload`` /
 * ``tileerror`` / ``load`` events. This suite drives those events through the
 * Leaflet stub (which records the created tile/grid layers and exposes ``_fire``)
 * to prove:
 *
 * - both layers are created (base first, overlay second) and added to the map,
 *   each with the three event handlers registered;
 * - a ``tileload`` from *either* provider latches the basemap "alive", so later
 *   isolated ``tileerror``s never swap in the offline placeholder;
 * - the offline placeholder fires only on a comprehensive dual outage (zero
 *   successes), and when it does it removes *both* online layers.
 *
 * @module __tests__/main-app-map-init
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupAppWithLeaflet } from './main-app-leaflet-stub.js';
import { CARTO_TILE_URL, HOT_TILE_URL } from '../basemap-config.js';

/**
 * Run a test body with a freshly initialised dashboard app (Leaflet stub) and
 * the map-init handles it exposes, ensuring cleanup regardless of outcome.
 *
 * @param {function({leaflet: Object, map: Object, base: Object, overlay: Object,
 *   gridLayers: Object[]}): void} fn Receives the stub, the map, the two basemap
 *   layers, and the recorded offline grid-layer list.
 * @returns {void}
 */
function withMapInit(fn) {
  const { leaflet, cleanup } = setupAppWithLeaflet();
  try {
    const [base, overlay] = leaflet._recorded.tileLayers;
    fn({
      leaflet,
      map: leaflet._map,
      base,
      overlay,
      gridLayers: leaflet._recorded.gridLayers,
    });
  } finally {
    cleanup();
  }
}

test('both stacked layers are created (base then overlay) and added to the map', () => {
  withMapInit(({ leaflet, map, base, overlay }) => {
    // Exactly two basemap tile layers, in CARTO-base-then-HOT-overlay order.
    assert.equal(leaflet._recorded.tileLayers.length, 2);
    assert.equal(base._url, CARTO_TILE_URL);
    assert.equal(overlay._url, HOT_TILE_URL);

    // Both were added to the map...
    assert.ok(map.hasLayer(base));
    assert.ok(map.hasLayer(overlay));

    // ...and both carry the full liveness-policy event wiring.
    for (const layer of [base, overlay]) {
      assert.ok(layer._events.has('tileload'));
      assert.ok(layer._events.has('tileerror'));
      assert.ok(layer._events.has('load'));
    }
  });
});

test('a tileload from either provider latches "alive"; later tileerrors are tolerated', () => {
  withMapInit(({ map, base, overlay, gridLayers }) => {
    // One successful CARTO tile latches the basemap alive.
    base._fire('tileload');
    // Now flood the overlay with errors — well past the error threshold.
    for (let i = 0; i < 20; i += 1) overlay._fire('tileerror');

    // The offline placeholder never activates while a tile has loaded.
    assert.equal(gridLayers.length, 0);
    assert.ok(map.hasLayer(base));
    assert.ok(map.hasLayer(overlay));
  });
});

test('a comprehensive dual outage (tileerror threshold, zero loads) swaps to offline and removes both layers', () => {
  withMapInit(({ map, base, overlay, gridLayers }) => {
    // Eight pre-success errors (DEFAULT_ERROR_THRESHOLD) with no tileload — the
    // basemap is judged comprehensively unreachable. Split across both layers to
    // prove the single shared policy counts errors from either provider.
    for (let i = 0; i < 4; i += 1) base._fire('tileerror');
    for (let i = 0; i < 4; i += 1) overlay._fire('tileerror');

    // Offline placeholder activated: one grid layer, added; both online layers gone.
    assert.equal(gridLayers.length, 1);
    assert.ok(map.hasLayer(gridLayers[0]));
    assert.ok(!map.hasLayer(base));
    assert.ok(!map.hasLayer(overlay));
  });
});

test('a layer load with zero successes but at least one error swaps to offline', () => {
  withMapInit(({ map, base, overlay, gridLayers }) => {
    // A single error keeps us under the eager threshold (no activation yet)...
    base._fire('tileerror');
    assert.equal(gridLayers.length, 0);
    // ...but the viewport finishing with zero successes is a comprehensive miss.
    base._fire('load');

    assert.equal(gridLayers.length, 1);
    assert.ok(!map.hasLayer(base));
    assert.ok(!map.hasLayer(overlay));
  });
});

test('a layer load after a successful tile keeps the online basemap', () => {
  withMapInit(({ map, base, overlay, gridLayers }) => {
    base._fire('tileload');
    overlay._fire('load');

    // A viewport that produced at least one success never falls back.
    assert.equal(gridLayers.length, 0);
    assert.ok(map.hasLayer(base));
    assert.ok(map.hasLayer(overlay));
  });
});

// Post-Deploy review 04: freshness is the coarse marker-stacking channel, so
// the map creates three panes (stale below, live on top). The role ladder still
// orders within a pane; both circle and chip markers are assigned by bucket.
test('three freshness marker panes are created with ascending z-index (SPEC PD3)', () => {
  withMapInit(({ leaflet }) => {
    const panes = leaflet._recorded.panes;
    const names = panes.map(pane => pane.name);
    for (const expected of ['markers-stale', 'markers-today', 'markers-live']) {
      assert.ok(names.includes(expected), `pane ${expected} is created`);
    }
    const zOf = name => Number(panes.find(pane => pane.name === name).style.zIndex);
    assert.ok(zOf('markers-stale') < zOf('markers-today'), 'stale stacks below today');
    assert.ok(zOf('markers-today') < zOf('markers-live'), 'today stacks below live');
  });
});
