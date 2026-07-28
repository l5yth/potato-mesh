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
 * Unit coverage for the node-table render cap helpers (frontend perf: render
 * scale).
 *
 * @module main/__tests__/nodes-table-cap
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capNodesForRender,
  buildShowAllRow,
  SHOW_ALL_ROW_CLASS,
  SHOW_ALL_BUTTON_CLASS,
} from '../nodes-table-cap.js';

/** Build a list of ``count`` distinct node-like objects. */
const nodes = count => Array.from({ length: count }, (_, i) => ({ node_id: `!${i}` }));

test('capNodesForRender renders the whole list when it is within the cap', () => {
  const { renderNodes, capped } = capNodesForRender(nodes(10), 250, false);
  assert.equal(renderNodes.length, 10);
  assert.equal(capped, false);
});

test('capNodesForRender truncates to the cap and flags capped when over it', () => {
  const list = nodes(300);
  const { renderNodes, capped } = capNodesForRender(list, 250, false);
  assert.equal(renderNodes.length, 250);
  assert.equal(capped, true);
  assert.strictEqual(renderNodes[0], list[0], 'keeps the caller sort order (top N)');
});

test('capNodesForRender renders everything when expanded, ignoring the cap', () => {
  const { renderNodes, capped } = capNodesForRender(nodes(300), 250, true);
  assert.equal(renderNodes.length, 300);
  assert.equal(capped, false);
});

test('capNodesForRender disables capping for a non-positive or non-finite cap', () => {
  assert.equal(capNodesForRender(nodes(300), 0, false).capped, false);
  assert.equal(capNodesForRender(nodes(300), 0, false).renderNodes.length, 300);
  assert.equal(capNodesForRender(nodes(300), Infinity, false).capped, false);
  assert.equal(capNodesForRender(nodes(300), Number.NaN, false).capped, false);
});

test('capNodesForRender tolerates a non-array input', () => {
  const { renderNodes, capped } = capNodesForRender(undefined, 250, false);
  assert.deepEqual(renderNodes, []);
  assert.equal(capped, false);
});

test('buildShowAllRow builds a spanning row hosting the labelled button', () => {
  const created = [];
  const documentRef = {
    createElement(tag) {
      const el = {
        tag,
        className: '',
        type: '',
        textContent: '',
        children: [],
        attrs: {},
        setAttribute(key, value) {
          this.attrs[key] = value;
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
      created.push(el);
      return el;
    },
  };

  const row = buildShowAllRow(documentRef, 1500, 12);

  assert.equal(row.tag, 'tr');
  assert.equal(row.className, SHOW_ALL_ROW_CLASS);
  const cell = row.children[0];
  assert.equal(cell.tag, 'td');
  assert.equal(cell.attrs.colspan, '12');
  const button = cell.children[0];
  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.className, SHOW_ALL_BUTTON_CLASS);
  assert.match(button.textContent, /^Show all .+ nodes$/);
  assert.match(button.textContent, /1.?500/, 'includes the (locale-grouped) total count');
});
