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
  captureOpenMarkerOverlays,
  restoreMarkerOverlays,
} from '../marker-overlay-preservation.js';

/** Minimal overlay-stack double tracking open anchors and reanchor calls. */
function fakeStack() {
  const open = new Set();
  const reanchored = [];
  return {
    open,
    reanchored,
    isOpen: (anchor) => open.has(anchor),
    reanchor: (oldAnchor, newAnchor) => {
      if (!open.has(oldAnchor)) return false;
      open.delete(oldAnchor);
      open.add(newAnchor);
      reanchored.push([oldAnchor, newAnchor]);
      return true;
    },
  };
}

/** Build a marker double whose getElement returns `el`. */
const marker = (el) => ({ getElement: () => el });

test('captureOpenMarkerOverlays snapshots only nodes whose marker overlay is open', () => {
  const stack = fakeStack();
  const elA = { id: 'A' };
  const elB = { id: 'B' };
  stack.open.add(elA);
  const markerByNodeId = new Map([
    ['!a', marker(elA)],
    ['!b', marker(elB)],
  ]);
  assert.deepEqual(captureOpenMarkerOverlays(stack, markerByNodeId), [
    { nodeId: '!a', anchor: elA },
  ]);
});

test('captureOpenMarkerOverlays ignores markers without getElement and bad args', () => {
  const stack = fakeStack();
  assert.deepEqual(captureOpenMarkerOverlays(null, new Map()), []);
  assert.deepEqual(captureOpenMarkerOverlays({}, new Map()), []);
  assert.deepEqual(captureOpenMarkerOverlays(stack, null), []);
  // Marker without a getElement() is skipped (no anchor to key on).
  assert.deepEqual(captureOpenMarkerOverlays(stack, new Map([['!x', {}]])), []);
});

test('restoreMarkerOverlays re-anchors captured overlays onto rebuilt markers', () => {
  const stack = fakeStack();
  const oldEl = { id: 'old' };
  const newEl = { id: 'new' };
  stack.open.add(oldEl);
  const captured = [{ nodeId: '!a', anchor: oldEl }];
  const rebuilt = new Map([['!a', marker(newEl)]]);
  assert.equal(restoreMarkerOverlays(stack, captured, rebuilt), 1);
  assert.deepEqual(stack.reanchored, [[oldEl, newEl]]);
  assert.equal(stack.isOpen(newEl), true);
  assert.equal(stack.isOpen(oldEl), false);
});

test('restoreMarkerOverlays leaves a vanished node for cleanup (no rebuilt marker)', () => {
  const stack = fakeStack();
  const oldEl = { id: 'old' };
  stack.open.add(oldEl);
  const captured = [{ nodeId: '!gone', anchor: oldEl }, null];
  assert.equal(restoreMarkerOverlays(stack, captured, new Map()), 0);
  assert.deepEqual(stack.reanchored, []);
});

test('restoreMarkerOverlays tolerates bad args', () => {
  assert.equal(restoreMarkerOverlays(null, [], new Map()), 0);
  assert.equal(restoreMarkerOverlays({}, [], new Map()), 0);
  const stack = fakeStack();
  assert.equal(restoreMarkerOverlays(stack, null, new Map()), 0);
  assert.equal(restoreMarkerOverlays(stack, [], null), 0);
});

test('a full capture->rebuild->restore cycle keeps the overlay on the new marker', () => {
  const stack = fakeStack();
  const elA = { id: 'A' };
  stack.open.add(elA);
  const before = new Map([['!a', marker(elA)]]);
  const captured = captureOpenMarkerOverlays(stack, before);
  // Map re-render: a fresh marker element for the same node id.
  const elA2 = { id: 'A2' };
  const after = new Map([['!a', marker(elA2)]]);
  restoreMarkerOverlays(stack, captured, after);
  assert.equal(stack.isOpen(elA2), true);
  assert.equal(stack.isOpen(elA), false);
});
