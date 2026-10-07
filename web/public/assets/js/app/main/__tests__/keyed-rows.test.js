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
 * Keyed row reconciliation (#881, SPEC DR1): element identity, removals and
 * moves are observed on the live DOM model, which counts every detach the way
 * a `MutationObserver` reports it.
 *
 * @module main/__tests__/keyed-rows
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveDocument } from '../../__tests__/live-dom-model.js';
import {
  SIGNATURE_CLOCK_SECONDS,
  createKeyedRowReconciler,
  longestIncreasingRun,
} from '../keyed-rows.js';

/**
 * A parent `tbody` attached to a live document.
 *
 * @param {Object} [options] Live model options.
 * @returns {{model: Object, document: Object, tbody: Object}} Handles.
 */
function liveTbody(options) {
  const live = createLiveDocument(options);
  const tbody = live.document.createElement('tbody');
  live.body.appendChild(tbody);
  live.model.resetStats();
  return { ...live, tbody };
}

/**
 * Row specs for `keys`, each row's text being its key unless overridden.
 *
 * @param {Object} document Live document.
 * @param {Array<string>} keys Row keys in render order.
 * @param {Object<string, string>} [signatures] Signature overrides by key.
 * @param {Array<string>} [synced] Receives the key of every synced row.
 * @returns {Array<Object>} Specs.
 */
function rowSpecs(document, keys, signatures = {}, synced = null) {
  return keys.map(key => ({
    key,
    signature: signatures[key] ?? key,
    create: () => {
      const tr = document.createElement('tr');
      tr.textContent = signatures[key] ?? key;
      return tr;
    },
    sync: synced ? tr => synced.push(`${key}:${tr.textContent}`) : undefined,
  }));
}

/**
 * Row texts of a parent, in order.
 *
 * @param {Object} parent Parent element.
 * @returns {Array<string>} Texts.
 */
const texts = parent => parent.children.map(row => row.textContent);

test('the signature clock is a fixed instant', () => {
  assert.equal(SIGNATURE_CLOCK_SECONDS, 0);
});

test('longestIncreasingRun picks one longest run of previous positions', () => {
  assert.deepEqual([...longestIncreasingRun([])], []);
  assert.deepEqual([...longestIncreasingRun([0, 1, 2])].sort(), [0, 1, 2]);
  assert.equal(longestIncreasingRun([2, 1, 0]).size, 1);
  assert.deepEqual([...longestIncreasingRun([4, 5, 0, 1, 2, 3])].sort(), [2, 3, 4, 5]);
  assert.deepEqual([...longestIncreasingRun([-1, 0, -1, 1])].sort(), [1, 3], 'fresh rows never join the run');
  assert.deepEqual([...longestIncreasingRun([3, -1, 1, 2])].sort(), [2, 3]);
  assert.deepEqual([...longestIncreasingRun([-1, -1])], []);
});

test('a first reconcile builds every row in order', () => {
  const { document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  const result = reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c']));
  assert.deepEqual(texts(tbody), ['a', 'b', 'c']);
  assert.deepEqual({ created: result.created, kept: result.kept, removed: result.removed, moved: result.moved },
    { created: 3, kept: 0, removed: 0, moved: 0 });
  assert.deepEqual([...result.elements.keys()], ['a', 'b', 'c']);
  assert.equal(reconciler.keyOf(tbody.children[1]), 'b');
});

test('an idle reconcile keeps every element and touches no position', () => {
  const { model, document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c']));
  const before = tbody.children;
  model.resetStats();
  const synced = [];
  const result = reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c'], {}, synced));
  assert.ok(tbody.children.every((row, i) => row === before[i]));
  assert.deepEqual(model.statsFor(tbody), { removed: 0, moved: 0, inserted: 0 });
  assert.equal(result.kept, 3);
  assert.deepEqual(synced, ['a:a', 'b:b', 'c:c'], 'sync runs on every kept row');
});

test('a changed signature rebuilds that row in place and nothing else', () => {
  const { model, document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c']));
  const [a, b, c] = tbody.children;
  model.resetStats();
  const result = reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c'], { b: 'b2' }));
  assert.deepEqual(texts(tbody), ['a', 'b2', 'c']);
  assert.ok(tbody.children[0] === a && tbody.children[2] === c, 'unchanged rows keep their elements');
  assert.ok(tbody.children[1] !== b, 'the changed row is a fresh element');
  assert.deepEqual(model.statsFor(tbody), { removed: 1, moved: 0, inserted: 1 });
  assert.equal(result.removed, 1);
});

test('new keys are inserted before their successor and stale keys removed', () => {
  const { model, document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c']));
  model.resetStats();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'x', 'c']));
  assert.deepEqual(texts(tbody), ['a', 'x', 'c']);
  assert.deepEqual(model.statsFor(tbody), { removed: 1, moved: 0, inserted: 1 });
  reconciler.reconcile(tbody, 'not a list');
  assert.deepEqual(texts(tbody), [], 'a missing spec list removes every keyed row');
});

test('a row sorting to the top is the only row that moves (moveBefore keeps focus)', () => {
  const { model, document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c', 'd']));
  const d = tbody.children[3];
  const button = document.createElement('button');
  d.appendChild(button);
  button.focus();
  model.resetStats();
  const result = reconciler.reconcile(tbody, rowSpecs(document, ['d', 'a', 'b', 'c']));
  assert.deepEqual(texts(tbody), ['d', 'a', 'b', 'c']);
  assert.equal(result.moved, 1);
  assert.deepEqual(model.statsFor(tbody), { removed: 0, moved: 1, inserted: 0 });
  assert.ok(model.activeElement === button, 'a state-preserving move keeps focus');
});

test('without moveBefore a move is a plain insert (the focus fix-up is the caller\'s job)', () => {
  const { model, document, tbody } = liveTbody({ withMoveBefore: false });
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b', 'c']));
  model.resetStats();
  reconciler.reconcile(tbody, rowSpecs(document, ['b', 'c', 'a']));
  assert.deepEqual(texts(tbody), ['b', 'c', 'a']);
  assert.deepEqual(model.statsFor(tbody), { removed: 1, moved: 0, inserted: 1 }, 'one row detached and reinserted');
});

test('a disconnected parent falls back from moveBefore to insertBefore', () => {
  const { document } = liveTbody();
  const detached = document.createElement('tbody');
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(detached, rowSpecs(document, ['a', 'b']));
  reconciler.reconcile(detached, rowSpecs(document, ['b', 'a']));
  assert.deepEqual(texts(detached), ['b', 'a']);
});

test('children the reconciler did not create are left alone', () => {
  const { model, document, tbody } = liveTbody();
  const waiting = document.createElement('tr');
  waiting.className = 'nodes-empty-row';
  tbody.appendChild(waiting);
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b']));
  assert.ok(tbody.children[0] === waiting, 'new rows are placed after the foreign row');
  model.resetStats();
  reconciler.reconcile(tbody, rowSpecs(document, ['b']));
  assert.ok(tbody.children[0] === waiting);
  assert.equal(reconciler.keyOf(waiting), null);
  assert.equal(reconciler.keyOf(null), null);
  assert.deepEqual(model.statsFor(tbody), { removed: 1, moved: 0, inserted: 0 }, 'only the stale keyed row left');
});

test('a key repeated within one render gets an occurrence suffix', () => {
  const { document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  const result = reconciler.reconcile(tbody, rowSpecs(document, ['a', 'a', 'a']));
  assert.deepEqual([...result.elements.keys()], ['a', 'a#1', 'a#2']);
  assert.equal(reconciler.keyOf(tbody.children[2]), 'a#2');
});

test('an element without remove() is taken out through its parent', () => {
  const { document, tbody } = liveTbody();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(tbody, rowSpecs(document, ['a', 'b']));
  tbody.children[0].remove = undefined;
  reconciler.reconcile(tbody, rowSpecs(document, ['b']));
  assert.deepEqual(texts(tbody), ['b']);
});

test('a parent without insertBefore gets the final order in one replaceChildren call', () => {
  const calls = [];
  const parent = {
    children: [],
    /**
     * Record the swap and keep the rows as the new children.
     *
     * @param {...Object} rows New children.
     * @returns {void}
     */
    replaceChildren(...rows) {
      calls.push(rows.length);
      this.children = rows;
    },
  };
  const { document } = createLiveDocument();
  const reconciler = createKeyedRowReconciler();
  reconciler.reconcile(parent, rowSpecs(document, ['a', 'b']));
  const [a] = parent.children;
  const result = reconciler.reconcile(parent, rowSpecs(document, ['b', 'a', 'c']));
  assert.ok(parent.children[1] === a, 'kept rows keep their identity there too');
  assert.deepEqual(calls, [2, 3]);
  assert.equal(result.removed, 0);

  const bare = { replaceChildren(...rows) { this.rows = rows; } };
  reconciler.reconcile(bare, rowSpecs(document, ['z']));
  assert.equal(bare.rows.length, 1, 'a parent exposing no children starts empty');
});
