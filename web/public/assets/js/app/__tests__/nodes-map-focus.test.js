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

import { createMapFocusHandler, DEFAULT_NODE_FOCUS_ZOOM, __testUtils } from '../nodes-map-focus.js';

const { toFiniteCoordinate } = __testUtils;

test('createMapFocusHandler recentres the map using Leaflet setView', () => {
  let interactions = 0;
  const autoFitController = {
    handleUserInteraction() {
      interactions += 1;
    }
  };
  const map = {
    calls: [],
    setView(target, zoom, options) {
      this.calls.push({ target, zoom, options });
    }
  };
  const centers = [];
  const handler = createMapFocusHandler({
    getMap: () => map,
    autoFitController,
    leaflet: {
      latLng(lat, lon) {
        return { lat, lng: lon, source: 'leaflet' };
      }
    },
    defaultZoom: 11,
    setMapCenter: value => centers.push(value)
  });

  const result = handler('51.5', '-0.12');

  assert.equal(result, true);
  assert.equal(interactions, 1);
  assert.equal(map.calls.length, 1);
  assert.deepEqual(map.calls[0], { target: [51.5, -0.12], zoom: 11, options: { animate: true } });
  assert.deepEqual(centers, [{ lat: 51.5, lng: -0.12, source: 'leaflet' }]);
});

test('createMapFocusHandler supports panTo fallback and numeric centres', () => {
  const panCalls = [];
  const zoomCalls = [];
  const map = {
    panTo(target, options) {
      panCalls.push({ target, options });
    },
    setZoom(value) {
      zoomCalls.push(value);
    }
  };
  const centers = [];
  const handler = createMapFocusHandler({
    getMap: () => map,
    leaflet: {
      latLng() {
        throw new Error('Leaflet latLng unavailable');
      }
    },
    defaultZoom: DEFAULT_NODE_FOCUS_ZOOM,
    setMapCenter: value => centers.push(value)
  });

  const result = handler(40.7128, -74.006, { zoom: 9, animate: false });

  assert.equal(result, true);
  assert.deepEqual(panCalls, [{ target: [40.7128, -74.006], options: { animate: false } }]);
  assert.deepEqual(zoomCalls, [9]);
  assert.deepEqual(centers, [{ lat: 40.7128, lon: -74.006 }]);
});

test('createMapFocusHandler validates inputs and map availability', () => {
  assert.throws(() => {
    createMapFocusHandler({ getMap: null });
  }, /getMap/);

  const missingMapHandler = createMapFocusHandler({ getMap: () => null });
  assert.equal(missingMapHandler(10, 20), false);

  const map = {
    setView() {}
  };
  const handler = createMapFocusHandler({ getMap: () => map });
  assert.equal(handler(null, 2), false);
  assert.equal(handler(1, undefined), false);
  assert.equal(handler(1, 2, { zoom: -5 }), false);
});

test('toFiniteCoordinate converts valid strings and rejects invalid values', () => {
  assert.equal(toFiniteCoordinate('42.5'), 42.5);
  assert.equal(toFiniteCoordinate(19), 19);
  assert.equal(toFiniteCoordinate('abc'), null);
  assert.equal(toFiniteCoordinate(null), null);
});
