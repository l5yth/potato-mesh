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
  captureKeyedAnchors,
  restoreKeyedAnchors,
  neighborSegmentKey,
  traceSegmentKey,
} from '../map-overlay-anchors.js';

/**
 * Overlay-stack double: tracks open anchors and records reanchor calls.
 *
 * @returns {{ open: Set, reanchored: Array, isOpen: Function, reanchor: Function }}
 */
function fakeStack() {
  const open = new Set();
  const reanchored = [];
  return {
    open,
    reanchored,
    isOpen: anchor => open.has(anchor),
    reanchor: (oldAnchor, newAnchor) => {
      if (!open.has(oldAnchor)) return false;
      open.delete(oldAnchor);
      open.add(newAnchor);
      reanchored.push([oldAnchor, newAnchor]);
      return true;
    },
  };
}

/**
 * Leaflet-layer double with an element and an optional bound tooltip.
 *
 * @param {Object} element The layer's DOM element stand-in.
 * @param {{ tooltipOpen?: boolean, latLng?: Object }} [options] Tooltip state.
 * @returns {Object} Layer double recording ``openTooltip`` calls.
 */
function fakeLayer(element, { tooltipOpen = false, latLng = null } = {}) {
  const layer = {
    opened: [],
    tooltipOpen,
    getElement: () => element,
    isTooltipOpen: () => layer.tooltipOpen,
    getTooltip: () => ({ getLatLng: () => latLng }),
    openTooltip(at) {
      layer.opened.push(at);
      layer.tooltipOpen = true;
      return layer;
    },
  };
  return layer;
}

test('captureKeyedAnchors records open overlays and open tooltips by key', () => {
  const stack = fakeStack();
  const lineEl = { id: 'line' };
  const pinEl = { id: 'pin' };
  stack.open.add(lineEl);
  const at = { lat: 1, lng: 2 };
  const layers = new Map([
    ['neighbor:!a→!b', fakeLayer(lineEl, { tooltipOpen: true, latLng: at })],
    ['trace:7#0', fakeLayer({ id: 'trace' }, { tooltipOpen: true })],
    ['wp:1', fakeLayer(pinEl)],
    ['wp:2', fakeLayer({ id: 'closed' })],
  ]);
  stack.open.add(pinEl);
  assert.deepEqual(captureKeyedAnchors(stack, layers), [
    { key: 'neighbor:!a→!b', anchor: lineEl, tooltipOpen: true, tooltipLatLng: at },
    { key: 'trace:7#0', anchor: null, tooltipOpen: true, tooltipLatLng: null },
    { key: 'wp:1', anchor: pinEl, tooltipOpen: false, tooltipLatLng: null },
  ]);
});

test('captureKeyedAnchors tolerates partial layers, a stack without isOpen and bad args', () => {
  const stack = fakeStack();
  assert.deepEqual(captureKeyedAnchors(stack, null), []);
  assert.deepEqual(captureKeyedAnchors(stack, [['k', fakeLayer({})]]), []);
  // No getElement, a null element, and a tooltip without a position.
  const noTooltipPosition = { getElement: () => null, isTooltipOpen: () => true, getTooltip: () => ({}) };
  const noGetTooltip = { isTooltipOpen: () => true };
  const nullLatLng = { isTooltipOpen: () => true, getTooltip: () => ({ getLatLng: () => undefined }) };
  // Leaflet 1.9: a layer without a bound tooltip throws from isTooltipOpen().
  const unbound = {
    getElement: () => ({ id: 'pin' }),
    getTooltip: () => undefined,
    isTooltipOpen: () => {
      throw new TypeError("Cannot read properties of undefined (reading 'isOpen')");
    },
  };
  assert.deepEqual(
    captureKeyedAnchors(
      stack,
      new Map([['a', {}], ['b', noTooltipPosition], ['c', noGetTooltip], ['d', nullLatLng], ['e', null], ['f', unbound]]),
    ),
    [
      { key: 'b', anchor: null, tooltipOpen: true, tooltipLatLng: null },
      { key: 'd', anchor: null, tooltipOpen: true, tooltipLatLng: null },
    ],
  );
  // Without isOpen only tooltips are captured.
  const el = { id: 'x' };
  assert.deepEqual(captureKeyedAnchors({}, new Map([['x', fakeLayer(el)]])), []);
  assert.deepEqual(captureKeyedAnchors(null, new Map([['x', fakeLayer(el, { tooltipOpen: true })]])), [
    { key: 'x', anchor: null, tooltipOpen: true, tooltipLatLng: null },
  ]);
});

test('restoreKeyedAnchors moves overlays and reopens tooltips on the rebuilt layer with the same key', () => {
  const stack = fakeStack();
  const oldLine = { id: 'old-line' };
  const oldPin = { id: 'old-pin' };
  stack.open.add(oldLine);
  stack.open.add(oldPin);
  const at = { lat: 52.5, lng: 13.4 };
  const before = new Map([
    ['neighbor:!a→!b', fakeLayer(oldLine, { tooltipOpen: true, latLng: at })],
    ['wp:1', fakeLayer(oldPin)],
    ['trace:7#1', fakeLayer({ id: 'old-trace' }, { tooltipOpen: true })],
  ]);
  const captured = captureKeyedAnchors(stack, before);

  // The rebuild: fresh layers and elements for the same keys.
  const newLine = { id: 'new-line' };
  const newPin = { id: 'new-pin' };
  const rebuiltLine = fakeLayer(newLine);
  const rebuiltTrace = fakeLayer({ id: 'new-trace' });
  const after = new Map([
    ['neighbor:!a→!b', rebuiltLine],
    ['wp:1', fakeLayer(newPin)],
    ['trace:7#1', rebuiltTrace],
  ]);
  assert.deepEqual(restoreKeyedAnchors(stack, captured, after), { overlays: 2, tooltips: 2 });
  assert.deepEqual(stack.reanchored, [[oldLine, newLine], [oldPin, newPin]]);
  assert.equal(stack.isOpen(newLine), true);
  assert.equal(stack.isOpen(oldLine), false);
  // A sticky tooltip reopens where it stood; one without a position at the layer default.
  assert.deepEqual(rebuiltLine.opened, [at]);
  assert.deepEqual(rebuiltTrace.opened, [undefined]);
});

test('restoreKeyedAnchors leaves a key the rebuild dropped for cleanup', () => {
  const stack = fakeStack();
  const oldEl = { id: 'old' };
  stack.open.add(oldEl);
  const captured = [
    { key: 'gone', anchor: oldEl, tooltipOpen: true, tooltipLatLng: null },
    null,
  ];
  assert.deepEqual(restoreKeyedAnchors(stack, captured, new Map()), { overlays: 0, tooltips: 0 });
  assert.equal(stack.isOpen(oldEl), true, 'the overlay is left on its detached anchor for cleanupOrphans');
});

test('restoreKeyedAnchors skips what the rebuilt layer or the stack cannot take', () => {
  const stack = fakeStack();
  const oldEl = { id: 'old' };
  stack.open.add(oldEl);
  const entry = { key: 'k', anchor: oldEl, tooltipOpen: true, tooltipLatLng: null };
  // A rebuilt layer without an element or openTooltip restores nothing.
  assert.deepEqual(restoreKeyedAnchors(stack, [entry], new Map([['k', { getElement: () => null }]])), {
    overlays: 0,
    tooltips: 0,
  });
  // A refused reanchor is not counted.
  const refusing = { ...stack, reanchor: () => false };
  assert.deepEqual(restoreKeyedAnchors(refusing, [entry], new Map([['k', fakeLayer({ id: 'n' })]])), {
    overlays: 0,
    tooltips: 1,
  });
  // A stack without reanchor still reopens tooltips.
  const tooltipOnly = fakeLayer({ id: 't' });
  assert.deepEqual(restoreKeyedAnchors(null, [entry], new Map([['k', tooltipOnly]])), { overlays: 0, tooltips: 1 });
  // A rebuilt layer with no tooltip bound gets no reopen.
  const unbound = { getElement: () => ({ id: 'u' }), getTooltip: () => undefined, openTooltip: () => assert.fail('no tooltip to open') };
  assert.deepEqual(restoreKeyedAnchors(null, [entry], new Map([['k', unbound]])), { overlays: 0, tooltips: 0 });
  assert.deepEqual(restoreKeyedAnchors(stack, null, new Map()), { overlays: 0, tooltips: 0 });
  assert.deepEqual(restoreKeyedAnchors(stack, [entry], null), { overlays: 0, tooltips: 0 });
});

test('neighborSegmentKey names a directed neighbour line, or nothing without both ids', () => {
  assert.equal(neighborSegmentKey('!a', '!b'), 'neighbor:!a→!b');
  assert.notEqual(neighborSegmentKey('!a', '!b'), neighborSegmentKey('!b', '!a'));
  assert.equal(neighborSegmentKey('', '!b'), null);
  assert.equal(neighborSegmentKey('!a', null), null);
  assert.equal(neighborSegmentKey(1, '!b'), null);
});

test('traceSegmentKey names a trace hop by trace id and position, or nothing without them', () => {
  assert.equal(traceSegmentKey(42, 0), 'trace:42#0');
  assert.equal(traceSegmentKey('abc', 3), 'trace:abc#3');
  assert.equal(traceSegmentKey(0, 1), 'trace:0#1');
  assert.equal(traceSegmentKey(null, 0), null);
  assert.equal(traceSegmentKey(undefined, 0), null);
  assert.equal(traceSegmentKey('', 0), null);
  assert.equal(traceSegmentKey(42, -1), null);
  assert.equal(traceSegmentKey(42, 1.5), null);
});
