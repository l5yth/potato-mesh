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
 * The `+` disclosure as remembered state (SPEC UX9; #881, SPEC DR1).
 *
 * @module main/__tests__/node-extra-disclosure
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveDocument } from '../../__tests__/live-dom-model.js';
import {
  NODE_EXTRA_CLOSED_GLYPH,
  NODE_EXTRA_OPEN_GLYPH,
  NODE_EXTRA_ROW_CLASS,
  NODE_EXTRA_TOGGLE_CLASS,
  applyNodeExtraRowState,
  applyNodeExtraToggleState,
  findNodeExtraRow,
  toggleNodeExtra,
} from '../node-extra-disclosure.js';

/**
 * A tbody from markup.
 *
 * @param {string} html Rows.
 * @returns {{model: Object, tbody: Object}} Handles.
 */
function rows(html) {
  const live = createLiveDocument();
  const tbody = live.document.createElement('tbody');
  live.body.appendChild(tbody);
  tbody.innerHTML = html;
  return { model: live.model, tbody };
}

/**
 * Markup of one node row with its `+` toggle.
 *
 * @param {string} id Node id.
 * @returns {string} Row markup.
 */
const NODE_ROW = id => `<tr data-node-row="${id}"><td><button class="${NODE_EXTRA_TOGGLE_CLASS}" aria-expanded="false">+</button></td></tr>`;
/** Markup of one identity sub-row. */
const SUB_ROW = '<tr class="nodes-subrow"><td></td></tr>';
/** Markup of one closed disclosure row. */
const EXTRA_ROW = `<tr class="${NODE_EXTRA_ROW_CLASS}" hidden><td></td></tr>`;

test('the glyphs match the shipped toggle', () => {
  assert.equal(NODE_EXTRA_OPEN_GLYPH, '−');
  assert.equal(NODE_EXTRA_CLOSED_GLYPH, '+');
});

test('a node row finds its disclosure row past its own sub-rows, never past another node', () => {
  const { tbody } = rows(NODE_ROW('!a') + SUB_ROW + SUB_ROW + EXTRA_ROW + NODE_ROW('!b') + NODE_ROW('!c') + EXTRA_ROW + NODE_ROW('!d'));
  const [a, , , extraA, b, c, extraC, d] = tbody.children;
  assert.ok(findNodeExtraRow(a) === extraA);
  assert.equal(findNodeExtraRow(b), null, 'the next row is another node');
  assert.ok(findNodeExtraRow(c) === extraC);
  assert.equal(findNodeExtraRow(d), null, 'the last row has nothing after it');
  assert.equal(findNodeExtraRow(null), null);
});

test('toggle and row state are written only where they differ', () => {
  const { tbody } = rows(NODE_ROW('!a') + EXTRA_ROW);
  const [row, extra] = tbody.children;
  const toggle = row.querySelector(`.${NODE_EXTRA_TOGGLE_CLASS}`);
  const writes = [];
  const setAttribute = toggle.setAttribute.bind(toggle);
  toggle.setAttribute = (name, value) => {
    writes.push(name);
    setAttribute(name, value);
  };

  applyNodeExtraToggleState(toggle, false);
  assert.deepEqual(writes, [], 'already closed');
  applyNodeExtraToggleState(toggle, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, NODE_EXTRA_OPEN_GLYPH);
  applyNodeExtraToggleState(toggle, true);
  assert.deepEqual(writes, ['aria-expanded'], 'one write for one change');
  applyNodeExtraToggleState(null, true);

  applyNodeExtraRowState(extra, false);
  assert.equal(extra.hidden, true);
  applyNodeExtraRowState(extra, true);
  assert.equal(extra.hidden, false);
  applyNodeExtraRowState(null, true);
});

test('a click flips the disclosure and remembers it by node id', () => {
  const { tbody } = rows(NODE_ROW('!a') + SUB_ROW + EXTRA_ROW);
  const [row, , extra] = tbody.children;
  const toggle = row.querySelector(`.${NODE_EXTRA_TOGGLE_CLASS}`);
  const open = new Set();

  assert.equal(toggleNodeExtra(open, toggle), true);
  assert.deepEqual([...open], ['!a']);
  assert.equal(extra.hidden, false, 'an expanded identity\'s + reaches past its sub-rows');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  assert.equal(toggleNodeExtra(open, toggle), true);
  assert.deepEqual([...open], []);
  assert.equal(extra.hidden, true);
  assert.equal(toggle.textContent, NODE_EXTRA_CLOSED_GLYPH);
});

test('a row without a node id toggles but is not remembered; no disclosure row is a no-op', () => {
  const { tbody } = rows(`<tr><td><button class="${NODE_EXTRA_TOGGLE_CLASS}">+</button></td></tr>` + EXTRA_ROW + NODE_ROW('!z'));
  const open = new Set();
  assert.equal(toggleNodeExtra(open, tbody.children[0].querySelector('button')), true);
  assert.equal(tbody.children[1].hidden, false);
  assert.deepEqual([...open], []);
  assert.equal(toggleNodeExtra(open, tbody.children[2].querySelector('button')), false);
});
