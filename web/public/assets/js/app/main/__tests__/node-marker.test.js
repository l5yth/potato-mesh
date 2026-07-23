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

// Regression guard for audit finding D-013 (SPEC UX7 / ACCEPTANCE UX-A5):
// protocol must be a shape channel — MeshCore renders square divIcon chips,
// Meshtastic keeps circular markers; colour keeps encoding role for both.

import test from 'node:test';
import assert from 'node:assert/strict';

import { nodeMarkerShapeForProtocol, createNodeMarker } from '../node-marker.js';

/**
 * Build a minimal Leaflet stub recording marker construction calls.
 *
 * @returns {{L: Object, calls: Array<Object>}} Stub and its recorded calls.
 */
function leafletStub() {
  const calls = [];
  const marker = options => ({
    on: () => {},
    bindPopup: () => {},
    bindTooltip: () => {},
    options: { ...(options || {}) },
  });
  const L = {
    circleMarker: (latlng, options) => {
      calls.push({ kind: 'circleMarker', latlng, options });
      return marker(options);
    },
    marker: (latlng, options) => {
      calls.push({ kind: 'marker', latlng, options });
      return marker(options);
    },
    divIcon: options => {
      calls.push({ kind: 'divIcon', options });
      return { divIcon: true, options };
    },
  };
  return { L, calls };
}

test('protocol shape mapping: meshcore is square, everything else circular', () => {
  assert.equal(nodeMarkerShapeForProtocol('meshcore'), 'square');
  assert.equal(nodeMarkerShapeForProtocol('MeshCore'), 'square');
  assert.equal(nodeMarkerShapeForProtocol('meshtastic'), 'circle');
  assert.equal(nodeMarkerShapeForProtocol(null), 'circle');
  assert.equal(nodeMarkerShapeForProtocol(undefined), 'circle');
});

test('meshtastic nodes stay L.circleMarker with the given style', () => {
  const { L, calls } = leafletStub();
  createNodeMarker(L, [52.5, 13.4], {
    protocol: 'meshtastic',
    color: '#ff0019',
    radius: 9,
    fillOpacity: 0.85,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'circleMarker');
  assert.deepEqual(calls[0].latlng, [52.5, 13.4]);
  assert.equal(calls[0].options.fillColor, '#ff0019');
  assert.equal(calls[0].options.radius, 9);
  assert.equal(calls[0].options.fillOpacity, 0.85);
});

test('meshcore nodes render as square divIcon chips in the role colour', () => {
  const { L, calls } = leafletStub();
  createNodeMarker(L, [52.5, 13.4], {
    protocol: 'meshcore',
    color: '#40749E',
    radius: 9,
    fillOpacity: 0.55,
  });
  const divIconCall = calls.find(call => call.kind === 'divIcon');
  assert.ok(divIconCall, 'meshcore markers are built from L.divIcon');
  assert.ok(
    String(divIconCall.options.className).includes('node-marker-chip'),
    'chip carries its styling class',
  );
  assert.ok(
    String(divIconCall.options.html).includes('#40749E'),
    'chip html carries the role colour',
  );
  assert.ok(
    String(divIconCall.options.html).includes('0.55'),
    'chip html carries the bucket fill opacity',
  );
  assert.deepEqual(divIconCall.options.iconSize, [18, 18], 'chip hit box is 2 × radius');
  const markerCall = calls.find(call => call.kind === 'marker');
  assert.ok(markerCall, 'the chip is placed via L.marker');
  assert.deepEqual(markerCall.latlng, [52.5, 13.4]);
});

test('created markers expose the shared interaction surface', () => {
  const { L } = leafletStub();
  for (const protocol of ['meshtastic', 'meshcore']) {
    const created = createNodeMarker(L, [0, 0], { protocol, color: '#abc', radius: 6, fillOpacity: 0.85 });
    assert.equal(typeof created.on, 'function');
    assert.equal(typeof created.bindPopup, 'function');
    assert.equal(typeof created.bindTooltip, 'function');
  }
});

test('meshcore chips mirror the circleMarker flash surface (setStyle + options)', () => {
  const { L } = leafletStub();
  const chip = createNodeMarker(L, [0, 0], {
    protocol: 'meshcore',
    color: '#40749E',
    radius: 9,
    fillOpacity: 0.55,
  });
  assert.equal(chip.options.fillColor, '#40749E');
  assert.equal(chip.options.fillOpacity, 0.55);
  const fill = { style: {} };
  chip.getElement = () => ({ querySelector: () => fill });
  assert.equal(chip.setStyle({ fillColor: '#ffffff', fillOpacity: 1 }), chip);
  assert.equal(chip.options.fillColor, '#ffffff');
  assert.equal(chip.options.fillOpacity, 1);
  assert.equal(fill.style.background, '#ffffff');
  assert.equal(fill.style.opacity, '1');
});

test('the chip setStyle shim tolerates detached markers and bad input', () => {
  const { L } = leafletStub();
  const chip = createNodeMarker(L, [0, 0], {
    protocol: 'meshcore',
    color: '#40749E',
    radius: 9,
    fillOpacity: 0.55,
  });
  assert.doesNotThrow(() => chip.setStyle({ fillOpacity: 0.3 }));
  assert.equal(chip.options.fillOpacity, 0.3, 'options track even without an element');
  assert.equal(chip.setStyle(null), chip, 'invalid style is a no-op');
});

test('the pane option passes through to both marker shapes', () => {
  const { L, calls } = leafletStub();
  createNodeMarker(L, [0, 0], { protocol: 'meshtastic', color: '#abc', radius: 6, fillOpacity: 0.85, pane: 'p1' });
  createNodeMarker(L, [0, 0], { protocol: 'meshcore', color: '#abc', radius: 6, fillOpacity: 0.85, pane: 'p2' });
  const circle = calls.find(call => call.kind === 'circleMarker');
  const chip = calls.find(call => call.kind === 'marker');
  assert.equal(circle.options.pane, 'p1');
  assert.equal(chip.options.pane, 'p2');
});
