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

// Regression guard for audit findings D-001/D-020 (SPEC UX4 / ACCEPTANCE
// UX-A2): the nodes table keeps a server-rendered waiting row while empty and
// renders null telemetry as a muted dash, distinct from an unloaded ''.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NODES_EMPTY_ROW_CLASS,
  NODES_EMPTY_MESSAGE,
  syncNodesEmptyRow,
} from '../table-empty-state.js';
import { EMPTY_CELL_HTML, formatTableCell } from '../table-cell-format.js';

/**
 * Build a stub `<tbody>` recording appended/removed rows.
 *
 * @param {?Object} existingRow Pre-existing empty row, when simulating the
 *   server-rendered state.
 * @returns {Object} tbody stub.
 */
function tbodyStub(existingRow = null) {
  const rows = existingRow ? [existingRow] : [];
  return {
    rows,
    querySelector: selector =>
      selector.includes(NODES_EMPTY_ROW_CLASS)
        ? rows.find(row => row.className.includes(NODES_EMPTY_ROW_CLASS)) || null
        : null,
    appendChild(row) {
      rows.push(row);
      return row;
    },
    removeChild(row) {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
      return row;
    },
  };
}

/**
 * Minimal document stub producing row elements for the sync helper.
 *
 * @returns {Object} document stub.
 */
function documentStubForRows() {
  return {
    createElement: tag => ({
      tagName: tag,
      className: '',
      innerHTML: '',
      setAttribute() {},
    }),
  };
}

test('an empty node set keeps (or recreates) the waiting row', () => {
  const tbody = tbodyStub();
  const present = syncNodesEmptyRow(tbody, 0, documentStubForRows(), 21);
  assert.equal(present, true);
  const row = tbody.rows[0];
  assert.ok(row, 'a waiting row is materialised');
  assert.ok(row.className.includes(NODES_EMPTY_ROW_CLASS));
  assert.ok(row.innerHTML.includes(NODES_EMPTY_MESSAGE));
  assert.ok(row.innerHTML.includes('colspan="21"'));
});

test('a non-empty node set removes the waiting row', () => {
  const existing = { className: NODES_EMPTY_ROW_CLASS, innerHTML: NODES_EMPTY_MESSAGE };
  const tbody = tbodyStub(existing);
  const present = syncNodesEmptyRow(tbody, 3, documentStubForRows(), 21);
  assert.equal(present, false);
  assert.equal(tbody.rows.length, 0);
});

test('sync is idempotent while empty', () => {
  const tbody = tbodyStub();
  syncNodesEmptyRow(tbody, 0, documentStubForRows(), 21);
  syncNodesEmptyRow(tbody, 0, documentStubForRows(), 21);
  assert.equal(tbody.rows.length, 1, 'no duplicate waiting rows');
});

test('sync tolerates a missing tbody', () => {
  assert.doesNotThrow(() => syncNodesEmptyRow(null, 0, documentStubForRows(), 21));
});

test('a populated table with no waiting row stays untouched', () => {
  const tbody = tbodyStub();
  assert.equal(syncNodesEmptyRow(tbody, 5, documentStubForRows(), 21), false);
  assert.equal(tbody.rows.length, 0);
});

test('an empty table without a document cannot materialise the row', () => {
  const tbody = tbodyStub();
  assert.equal(syncNodesEmptyRow(tbody, 0, null, 21), false);
  assert.equal(syncNodesEmptyRow(tbody, 0, {}, 21), false);
});

test('a tbody without removeChild leaves the stale row in place', () => {
  const existing = { className: NODES_EMPTY_ROW_CLASS, innerHTML: NODES_EMPTY_MESSAGE };
  const rows = [existing];
  const tbody = {
    rows,
    querySelector: () => existing,
    appendChild(row) {
      rows.push(row);
    },
  };
  assert.equal(syncNodesEmptyRow(tbody, 3, documentStubForRows(), 21), false);
  assert.equal(rows.length, 1, 'row cannot be removed without removeChild');
});

test('formatTableCell renders values verbatim and nulls as the muted dash', () => {
  assert.equal(formatTableCell('83%'), '83%');
  assert.equal(formatTableCell('0'), '0');
  assert.equal(formatTableCell(''), EMPTY_CELL_HTML);
  assert.equal(formatTableCell(null), EMPTY_CELL_HTML);
  assert.equal(formatTableCell(undefined), EMPTY_CELL_HTML);
  assert.ok(EMPTY_CELL_HTML.includes('—'), 'the dash matches the overlay convention');
  assert.ok(EMPTY_CELL_HTML.includes('cell-empty'), 'the dash is styleable as muted');
});
