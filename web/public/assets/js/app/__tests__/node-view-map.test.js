/*
 * Copyright (C) 2025 l5yth
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

import { initializeNodeMap } from '../node-view-map.js';

/**
 * Construct a Leaflet stub that records map interactions.
 *
 * @returns {Object} Leaflet-like stub with recorded state.
 */
function createLeafletStub() {
  class StubMap {
    constructor() {
      this.layers = [];
      this.fitBoundsCalls = [];
      this.setViewCalls = [];
      this.options = null;
    }

    addLayer(layer) {
      this.layers.push(layer);
      return layer;
    }

    fitBounds(bounds, options) {
      this.fitBoundsCalls.push({ bounds, options });
    }

    setView(latLng, zoom) {
      this.setViewCalls.push({ latLng, zoom });
    }
  }

  const mapInstance = new StubMap();
  const markers = [];
  const polylines = [];
  const tileContainer = {
    style: {},
    ownerDocument: {
      body: {},
      defaultView: {
        getComputedStyle() {
          return {
            getPropertyValue() {
              return '';
            }
          };
        }
      }
    }
  };

  const leaflet = {
    map(container, options) {
      mapInstance.container = container;
      mapInstance.options = options;
      return mapInstance;
    },
    tileLayer(url, options) {
      return {
        url,
        options,
        added: false,
        handlers: {},
        addTo(map) {
          this.added = true;
          map.addLayer(this);
        },
        on(event, handler) {
          this.handlers[event] = handler;
        },
        getContainer() {
          return tileContainer;
        }
      };
    },
    circleMarker(latLng, options) {
      const marker = {
        latLng,
        options,
        added: false,
        tooltip: null,
        addTo(map) {
          this.added = true;
          map.addLayer(this);
        },
        bindTooltip(text, opts) {
          this.tooltip = { text, opts };
        }
      };
      markers.push(marker);
      return marker;
    },
    polyline(latLngs, options) {
      const polyline = {
        latLngs,
        options,
        added: false,
        addTo(map) {
          this.added = true;
          map.addLayer(this);
        }
      };
      polylines.push(polyline);
      return polyline;
    },
    latLngBounds(latLngs) {
      return { latLngs };
    }
  };

  leaflet._map = mapInstance;
  leaflet._markers = markers;
  leaflet._polylines = polylines;
  leaflet._tileContainer = tileContainer;
  return leaflet;
}

function createContainer() {
  const ownerDocument = {
    body: {},
    defaultView: {
      getComputedStyle() {
        return {
          getPropertyValue() {
            return '';
          }
        };
      }
    }
  };
  return { innerHTML: '', ownerDocument };
}

test('initializeNodeMap renders message when no positions are available', () => {
  const container = createContainer();
  const result = initializeNodeMap({ container, positions: [] });
  assert.equal(result, null);
  assert.match(container.innerHTML, /No positions recorded/);
});

test('initializeNodeMap renders message when Leaflet is missing', () => {
  const container = createContainer();
  const positions = [
    { timestampMs: Date.now(), latitude: 1, longitude: 2 }
  ];
  const result = initializeNodeMap({ container, positions, leaflet: null });
  assert.equal(result, null);
  assert.match(container.innerHTML, /Map rendering is unavailable/);
});

test('initializeNodeMap adds markers and polylines to the map', () => {
  const container = createContainer();
  const leaflet = createLeafletStub();
  const now = Date.now();
  const positions = [
    { timestampMs: now - 10_000, latitude: 10, longitude: 20 },
    { timestampMs: now, latitude: 12, longitude: 22 }
  ];
  const result = initializeNodeMap({ container, positions, theme: 'dark', leaflet });
  assert.ok(result);
  assert.equal(leaflet._markers.length, 2);
  assert.ok(result.polyline);
  assert.equal(leaflet._map.fitBoundsCalls.length, 1);
});

test('initializeNodeMap requires a container element', () => {
  assert.throws(() => initializeNodeMap({ container: null, positions: [] }), /container element is required/);
});
