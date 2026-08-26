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
// protocol must be a shape channel — MeshCore renders equal-area rotated-diamond
// divIcon chips (sized round(radius × 1.78); the 45° rotation + corner rounding
// live in base.css), Meshtastic keeps circular markers; colour keeps encoding
// role for both.

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

test('reticulum resolves to hexagon, case-insensitively (RD6)', () => {
  assert.equal(nodeMarkerShapeForProtocol('reticulum'), 'hexagon');
  assert.equal(nodeMarkerShapeForProtocol('Reticulum'), 'hexagon');
  // A protocol nobody has heard of still falls back rather than throwing.
  assert.equal(nodeMarkerShapeForProtocol('zigbee'), 'circle');
});

test('the reticulum chip is equal-area and shape-modified (RD6)', () => {
  // A reserved slot: RNS announces carry no position, so nothing reaches this
  // on the map today. Built correctly now so the shape channel is complete the
  // moment positions exist.
  const { L, calls } = leafletStub();
  createNodeMarker(L, [52.5, 13.4], {
    protocol: 'reticulum',
    color: '#a08bff',
    radius: 9,
    fillOpacity: 0.8,
  });
  const icon = calls.find(call => call.kind === 'divIcon');
  assert.ok(icon, 'reticulum should build a divIcon chip, not a circleMarker');
  assert.match(icon.options.html, /node-marker-chip__fill--hexagon/);
  // round(9 × 2.07) = 19. The hexagon's clip-path removes 27% of its box, so
  // it needs a larger side than the diamond's 1.78 to carry the same optical
  // weight as the circle it replaces.
  assert.equal(icon.options.iconSize[0], 19);
  assert.deepEqual(icon.options.iconAnchor, [9.5, 9.5]);
});

test('the meshcore chip is untouched by the hexagon (FU-A3 regression)', () => {
  const { L, calls } = leafletStub();
  createNodeMarker(L, [52.5, 13.4], {
    protocol: 'meshcore',
    color: '#7A9EBC',
    radius: 9,
    fillOpacity: 0.8,
  });
  const icon = calls.find(call => call.kind === 'divIcon');
  // Still the bare diamond class, still round(9 × 1.78) = 16.
  assert.doesNotMatch(icon.options.html, /--hexagon/);
  assert.match(icon.options.html, /class="node-marker-chip__fill"/);
  assert.equal(icon.options.iconSize[0], 16);
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

test('meshcore nodes render as equal-area diamond divIcon chips in the role colour', () => {
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
  assert.deepEqual(
    divIconCall.options.iconSize,
    [16, 16],
    'chip box is round(radius × 1.78) = 16 at radius 9 — equal optical area to the circle',
  );
  assert.deepEqual(divIconCall.options.iconAnchor, [8, 8], 'anchor stays box-centred');
  assert.ok(
    String(divIconCall.options.html).includes('width:16px;height:16px;'),
    'chip fill span is sized to match the box',
  );
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
