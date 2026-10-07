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
 * Carrying the reader's place across a keyed reconcile (#881, SPEC DR1):
 * focus, overlays anchored to badges, and the row under a scrolled page, on
 * the live DOM model.
 *
 * @module main/__tests__/reader-place
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveDocument } from '../../__tests__/live-dom-model.js';
import { createKeyedRowReconciler } from '../keyed-rows.js';
import {
  captureReaderPlace,
  describeControl,
  locateControl,
  restoreReaderPlace,
  rowOfControl,
  supportsNativeScrollAnchoring,
} from '../reader-place.js';

/** Markup of one row: a badge, a link and two buttons sharing a class. */
const ROW_HTML = '<td class="c0"><span class="badge">B</span></td>' +
  '<td class="c1"><a class="link" href="#">L</a></td>' +
  '<td class="c2"><button class="btn">1</button><button class="btn">2</button></td>';

/**
 * A live table with keyed rows `keys`, each built from {@link ROW_HTML}.
 *
 * @param {Object} [options] Live model options.
 * @param {Array<string>} [keys] Row keys.
 * @returns {Object} Handles, plus `render(keys, changed)` re-rendering with
 *   the rows in `changed` rebuilt.
 */
function liveTable(options = {}, keys = ['a', 'b', 'c']) {
  const live = createLiveDocument(options);
  const table = live.document.createElement('table');
  const tbody = live.document.createElement('tbody');
  table.appendChild(tbody);
  live.body.appendChild(table);
  live.model.geometryParent = tbody;
  const reconciler = createKeyedRowReconciler();
  const generation = new Map();
  /**
   * Reconcile the table to `order`, rebuilding the rows in `changed`.
   *
   * @param {Array<string>} order Row keys in render order.
   * @param {Array<string>} [changed] Keys whose content changed.
   * @returns {Object} The reconcile result.
   */
  const render = (order, changed = []) => {
    for (const key of changed) generation.set(key, (generation.get(key) || 0) + 1);
    return reconciler.reconcile(tbody, order.map(key => ({
      key,
      signature: `${key}:${generation.get(key) || 0}`,
      create: () => {
        const tr = live.document.createElement('tr');
        tr.innerHTML = ROW_HTML;
        return tr;
      },
    })));
  };
  render(keys);
  live.model.resetStats();
  return { ...live, tbody, reconciler, render, row: i => tbody.children[i] };
}

/**
 * Overlay stack double recording re-anchors.
 *
 * @param {Array<Element>} anchors Anchors with an open overlay.
 * @param {boolean} [accept] What `reanchor` answers.
 * @returns {Object} Stack double with a `moves` log.
 */
function overlayStackWith(anchors, accept = true) {
  const moves = [];
  return {
    moves,
    getOpenOverlays: () => anchors.map(anchor => ({ anchor, element: {} })),
    /**
     * Record a re-anchor and answer as configured.
     *
     * @param {Object} from Old anchor.
     * @param {Object} to New anchor.
     * @returns {boolean} The configured answer.
     */
    reanchor(from, to) {
      moves.push([from, to]);
      return accept;
    },
  };
}

/**
 * Capture, re-render and restore in one step.
 *
 * @param {Object} t Table handles from {@link liveTable}.
 * @param {Array<string>} order New row order.
 * @param {Array<string>} changed Keys rebuilt.
 * @param {?Object} [overlayStack] Overlay stack.
 * @returns {Object} The restore outcome.
 */
function rerender(t, order, changed, overlayStack = null) {
  const place = captureReaderPlace({
    tbody: t.tbody,
    keyOf: t.reconciler.keyOf,
    documentRef: t.document,
    overlayStack,
    windowRef: t.window,
  });
  const { elements } = t.render(order, changed);
  return restoreReaderPlace(place, {
    tbody: t.tbody, elements, documentRef: t.document, overlayStack, windowRef: t.window,
  });
}

test('rowOfControl finds the row holding a control', () => {
  const t = liveTable();
  const link = t.row(1).querySelector('.link');
  assert.ok(rowOfControl(t.tbody, link) === t.row(1));
  assert.ok(rowOfControl(t.tbody, t.row(2)) === t.row(2));
  assert.equal(rowOfControl(t.tbody, t.body), null, 'a node outside the rows has none');
  assert.equal(rowOfControl(t.tbody, t.tbody), null);
});

test('a control is described by cell, tag, class and ordinal and found again in a rebuilt row', () => {
  const t = liveTable();
  const row = t.row(0);
  const second = row.querySelectorAll('.btn')[1];
  const locator = describeControl(row, second);
  assert.deepEqual(locator, { cell: 2, tagName: 'BUTTON', className: 'btn', ordinal: 1 });
  t.render(['a', 'b', 'c'], ['a']);
  const rebuilt = t.row(0);
  assert.ok(rebuilt !== row, 'setup: the row was rebuilt');
  assert.ok(locateControl(rebuilt, locator) === rebuilt.querySelectorAll('.btn')[1]);

  const cellLocator = describeControl(rebuilt, rebuilt.children[1]);
  assert.deepEqual(cellLocator, { cell: 1, tagName: 'TD', className: 'c1', ordinal: -1 });
  assert.ok(locateControl(rebuilt, cellLocator) === rebuilt.children[1]);
  const rowLocator = describeControl(rebuilt, rebuilt);
  assert.equal(rowLocator.cell, -1);
  assert.ok(locateControl(rebuilt, rowLocator) === rebuilt);
});

test('a locator that no longer fits finds nothing rather than a guess', () => {
  const t = liveTable();
  const row = t.row(0);
  assert.equal(locateControl(null, { cell: 0 }), null);
  assert.equal(locateControl(row, null), null);
  assert.equal(locateControl(row, { cell: 9, tagName: 'A', className: 'link', ordinal: 0 }), null, 'no such cell');
  assert.equal(locateControl(row, { cell: 1, tagName: 'A', className: 'other', ordinal: 0 }), null, 'class changed');
  assert.equal(locateControl(row, { cell: 2, tagName: 'BUTTON', className: 'btn', ordinal: 2 }), null, 'fewer lookalikes');
  assert.equal(locateControl(row, { cell: 1, tagName: 'TD', className: 'c9', ordinal: -1 }), null, 'cell changed');
});

test('native scroll anchoring is detected through CSS.supports', () => {
  assert.equal(supportsNativeScrollAnchoring(null), false);
  assert.equal(supportsNativeScrollAnchoring({}), false);
  assert.equal(supportsNativeScrollAnchoring({ CSS: {} }), false);
  assert.equal(supportsNativeScrollAnchoring({ CSS: { supports: () => false } }), false);
  assert.equal(supportsNativeScrollAnchoring({ CSS: { supports: (p, v) => p === 'overflow-anchor' && v === 'auto' } }), true);
});

test('focus on a control of a rebuilt row moves to the same control of the replacement', () => {
  const t = liveTable();
  t.row(1).querySelectorAll('.btn')[1].focus();
  t.model.resetStats();
  const restored = rerender(t, ['a', 'b', 'c'], ['b']);
  assert.equal(restored.refocused, true);
  assert.ok(t.document.activeElement === t.row(1).querySelectorAll('.btn')[1]);
  assert.deepEqual(t.model.focusCalls.map(c => c.options), [{ preventScroll: true }]);
});

test('focus in a row moved by a plain insert returns to the same element', () => {
  const t = liveTable({ withMoveBefore: false });
  const link = t.row(0).querySelector('.link');
  link.focus();
  const restored = rerender(t, ['b', 'c', 'a'], []);
  assert.equal(restored.refocused, true);
  assert.ok(t.document.activeElement === link);
});

test('focus that survived, left the table, or lost its row is left alone', () => {
  const t = liveTable();
  const link = t.row(0).querySelector('.link');
  link.focus();
  assert.equal(rerender(t, ['a', 'b', 'c'], ['b']).refocused, false, 'kept row: nothing to do');
  assert.ok(t.document.activeElement === link);

  link.blur();
  assert.equal(rerender(t, ['a', 'b', 'c'], ['a']).refocused, false, 'nothing focused in the table');

  t.row(2).querySelector('.link').focus();
  assert.equal(rerender(t, ['a', 'b'], []).refocused, false, 'the row left the table');
  assert.ok(t.document.activeElement === t.body);

  const foreign = t.document.createElement('tr');
  const button = t.document.createElement('button');
  foreign.appendChild(button);
  t.tbody.appendChild(foreign);
  button.focus();
  assert.equal(rerender(t, ['a', 'b'], ['a']).refocused, false, 'a foreign row is not ours to restore');
});

test('focus moved elsewhere during the reconcile is never stolen back', () => {
  const t = liveTable();
  t.row(1).querySelector('.link').focus();
  const outside = t.document.createElement('button');
  t.body.appendChild(outside);
  const place = captureReaderPlace({ tbody: t.tbody, keyOf: t.reconciler.keyOf, documentRef: t.document });
  const { elements } = t.render(['a', 'b', 'c'], ['b']);
  outside.focus();
  const restored = restoreReaderPlace(place, { tbody: t.tbody, elements, documentRef: t.document });
  assert.equal(restored.refocused, false);
  assert.ok(t.document.activeElement === outside);
});

test('an overlay on a badge of a rebuilt row is re-anchored to the new badge', () => {
  const t = liveTable();
  const badge = t.row(1).querySelector('.badge');
  const kept = t.row(0).querySelector('.badge');
  const stack = overlayStackWith([badge, kept, t.body]);
  const restored = rerender(t, ['a', 'b', 'c'], ['b'], stack);
  assert.equal(restored.reanchored, 1, 'the kept row\'s overlay needs nothing');
  assert.equal(stack.moves.length, 1);
  assert.ok(stack.moves[0][0] === badge && stack.moves[0][1] === t.row(1).querySelector('.badge'));
});

test('an overlay whose row left, or that the stack refuses, is not counted', () => {
  const t = liveTable();
  const leaving = overlayStackWith([t.row(2).querySelector('.badge')]);
  assert.equal(rerender(t, ['a', 'b'], [], leaving).reanchored, 0);
  assert.equal(leaving.moves.length, 0, 'left for cleanupOrphans to close');

  const refusing = overlayStackWith([t.row(0).querySelector('.badge')], false);
  assert.equal(rerender(t, ['a', 'b'], ['a'], refusing).reanchored, 0);
  assert.equal(refusing.moves.length, 1);

  const foreign = t.document.createElement('tr');
  const span = t.document.createElement('span');
  foreign.appendChild(span);
  t.tbody.appendChild(foreign);
  const unkeyed = overlayStackWith([span]);
  assert.equal(rerender(t, ['a', 'b'], ['a'], unkeyed).reanchored, 0);
  assert.equal(unkeyed.moves.length, 0);
});

test('overlays are repositioned after a reconcile that shifted rows, and only then', () => {
  const t = liveTable();
  const calls = [];
  const stack = { getOpenOverlays: () => [], reanchor: () => true, positionAll: () => calls.push('positionAll') };
  const place = captureReaderPlace({ tbody: t.tbody, keyOf: t.reconciler.keyOf, overlayStack: stack });
  const { elements } = t.render(['c', 'a', 'b'], ['c']);
  assert.equal(restoreReaderPlace(place, { tbody: t.tbody, elements, overlayStack: stack, rowsShifted: true }).repositioned, true);
  assert.deepEqual(calls, ['positionAll'], 'one pass over every open overlay');
  assert.equal(restoreReaderPlace(place, { tbody: t.tbody, elements, overlayStack: stack, rowsShifted: false }).repositioned, false);
  assert.equal(restoreReaderPlace(place, { tbody: t.tbody, elements, rowsShifted: true }).repositioned, false, 'no stack, nothing to move');
  assert.deepEqual(calls, ['positionAll']);
});

test('a stack without getOpenOverlays contributes nothing', () => {
  const t = liveTable();
  const place = captureReaderPlace({ tbody: t.tbody, keyOf: t.reconciler.keyOf, overlayStack: {} });
  assert.deepEqual(place.overlays, []);
  assert.equal(place.focus, null, 'no document, no focus');
  assert.equal(place.anchor, null, 'no window, no anchor');
});

test('without native anchoring the row under a scrolled reader stays put', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const t = liveTable({ tableTop: 100, rowHeight: 20, viewportHeight: 60 }, keys);
  t.model.scrollY = 140;
  const reader = t.model.rowAt(5);
  assert.ok(reader === t.row(2), 'setup: the third row is under the reader');
  const restored = rerender(t, ['f', ...keys.slice(0, 5)], ['f']);
  assert.equal(restored.scrolledBy, 20);
  assert.ok(t.model.rowAt(5) === reader);
  assert.deepEqual(t.model.scrollCalls, [20]);
});

test('with the table top in view the fallback leaves the page alone, so content above it stays put', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const t = liveTable({ tableTop: 300, rowHeight: 20, viewportHeight: 600 }, keys);
  // The page is scrolled, but the table still starts 200 px down the
  // viewport: the reader looks at whatever sits above it (the chat).
  t.model.scrollY = 100;
  assert.equal(t.tbody.getBoundingClientRect().top, 200, 'setup: the table top is in view');
  const restored = rerender(t, ['f', ...keys.slice(0, 5)], ['f']);
  assert.equal(restored.scrolledBy, 0, 'a row landing in the table does not move the page');
  assert.deepEqual(t.model.scrollCalls, []);

  t.model.scrollY = 300;
  assert.equal(t.tbody.getBoundingClientRect().top, 0, 'setup: the table top sits exactly at the viewport top');
  assert.equal(rerender(t, keys, ['a']).scrolledBy, 0, 'nothing above the reader is in the table yet');
});

test('the anchor skips hidden and scrolled-past rows and falls back to the next kept row', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const t = liveTable({ tableTop: 100, rowHeight: 20, viewportHeight: 60 }, keys);
  t.row(3).hidden = true;
  t.model.scrollY = 140;
  const place = captureReaderPlace({ tbody: t.tbody, keyOf: t.reconciler.keyOf, windowRef: t.window });
  assert.deepEqual(place.anchor.map(entry => t.tbody.children.indexOf(entry.row)), [2, 4, 5],
    'rows above the viewport and hidden rows are skipped; capture stops below it');
  const { elements } = t.render(['f', 'a', 'b', 'c', 'd', 'e'], ['c', 'f']);
  const restored = restoreReaderPlace(place, { tbody: t.tbody, elements, windowRef: t.window });
  assert.equal(restored.scrolledBy, 20, 'the rebuilt reader row is skipped for the next kept one');
});

test('no manual scroll at the top of the page, with native anchoring, or when nothing moved', () => {
  const keys = ['a', 'b', 'c'];
  const top = liveTable({}, keys);
  assert.equal(captureReaderPlace({ tbody: top.tbody, keyOf: top.reconciler.keyOf, windowRef: top.window }).anchor, null);

  const native = liveTable({ nativeScrollAnchoring: true }, keys);
  native.model.scrollY = 50;
  assert.equal(captureReaderPlace({ tbody: native.tbody, keyOf: native.reconciler.keyOf, windowRef: native.window }).anchor, null);

  const noScrollApi = liveTable({}, keys);
  noScrollApi.model.scrollY = 50;
  assert.equal(captureReaderPlace({ tbody: noScrollApi.tbody, keyOf: noScrollApi.reconciler.keyOf, windowRef: {} }).anchor, null);

  const still = liveTable({ tableTop: 0, rowHeight: 20, viewportHeight: 100 }, keys);
  still.model.scrollY = 10;
  assert.equal(rerender(still, keys, ['c']).scrolledBy, 0, 'a change below the reader moves nothing');
  assert.deepEqual(still.model.scrollCalls, []);

  const gone = liveTable({ tableTop: 0, rowHeight: 20, viewportHeight: 30 }, keys);
  gone.model.scrollY = 10;
  assert.equal(rerender(gone, ['c'], []).scrolledBy, 0, 'no visible row survived');
});

test('a window without innerHeight anchors on the row crossing the top edge', () => {
  const t = liveTable({ tableTop: 0, rowHeight: 20 }, ['a', 'b', 'c']);
  t.model.scrollY = 10;
  const windowRef = { scrollY: 10, scrollBy: (x, y) => t.window.scrollBy(x, y) };
  const place = captureReaderPlace({ tbody: t.tbody, keyOf: t.reconciler.keyOf, windowRef });
  assert.deepEqual(place.anchor.map(entry => t.tbody.children.indexOf(entry.row)), [0]);
});

test('a tbody without contains() restores nothing and throws nothing', () => {
  const t = liveTable();
  t.row(0).querySelector('.link').focus();
  const place = captureReaderPlace({
    tbody: { children: [] },
    keyOf: () => 'a',
    documentRef: t.document,
    overlayStack: overlayStackWith([t.body]),
  });
  assert.equal(place.focus, null);
  assert.deepEqual(place.overlays, []);
});
