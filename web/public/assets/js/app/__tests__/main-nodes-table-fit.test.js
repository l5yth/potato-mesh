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
 * The dashboard's render hook for the adaptive nodes-table fit (SPEC PO1):
 * every `renderTable` decides `#nodes`'s squeezed class against the table's
 * column, a re-render with the same data keeps it without measuring, and a
 * column with room for the unbroken table drops it on the next render.
 *
 * @module app/__tests__/main-nodes-table-fit
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveTableDom } from './live-dom-model.js';
import { runLiveApp } from './sse-app-harness.js';
import { SQUEEZED_CLASS } from '../main/nodes-table-fit.js';

const NOW = Math.floor(Date.now() / 1000);

/** One node with a long name that cannot break, as on the rc4 staging instance. */
const NODES = [{
  node_id: '!da6556d4', short_name: 'SIXM', long_name: 'mf.mt.turm.ak.ber.sixtopia.net',
  hw_model: 'HELTEC_MESH_NODE_T114', last_heard: NOW - 60, protocol: 'meshtastic', role: 'CLIENT',
}];

test('renderTable squeezes the table while it overflows its column and keeps the class across re-renders (PO1)', async () => {
  const dom = createLiveTableDom();
  const widths = { natural: 423.2, column: 343 };
  const writes = [];
  const classList = dom.table.classList;
  dom.table.classList = {
    ...classList,
    add: name => { writes.push(`add ${name}`); classList.add(name); },
    remove: name => { writes.push(`remove ${name}`); classList.remove(name); },
  };
  // The live model lays nothing out: the table is `natural` wide unbroken and
  // fills its column when squeezed; its parent is the column.
  dom.table.getBoundingClientRect = () => ({ width: classList.contains(SQUEEZED_CLASS) ? widths.column : widths.natural });
  dom.table.parentNode.getBoundingClientRect = () => ({ width: widths.column });
  await runLiveApp({ env: dom.env }, async ({ testUtils: t }) => {
    t.renderTable(NODES, NOW);
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'a table wider than its column is squeezed');
    writes.length = 0;
    t.renderTable(NODES, NOW);
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'the same data keeps the class');
    assert.deepEqual(writes, [], 'a same-data re-render keeps the decision without measuring');
    widths.column = 480;
    t.renderTable(NODES, NOW);
    assert.equal(classList.contains(SQUEEZED_CLASS), false, 'room for the unbroken table drops it');
    writes.length = 0;
    t.renderTable(NODES, NOW);
    assert.deepEqual(writes, [], 'a fitting table is re-rendered without a class write');
  });
});

/**
 * Give the live table the header row of the sort scan: Last Seen and HW Model,
 * each with its sort button and arrow, as `_nodes_table.erb` renders them.
 *
 * @param {Object} dom Handles from {@link createLiveTableDom}.
 * @returns {Object<string, Object>} Each sort button by its sort key.
 */
function addSortHeaders(dom) {
  const thead = dom.model.createElement('thead');
  const row = dom.model.createElement('tr');
  const buttons = {};
  for (const [key, column] of [['last_heard', 'last-seen'], ['hw_model', 'hw-model']]) {
    const th = dom.model.createElement('th');
    th.setAttribute('class', `nodes-col nodes-col--${column}`);
    const button = dom.model.createElement('button');
    button.setAttribute('class', 'sort-button');
    button.setAttribute('data-sort-key', key);
    const arrow = dom.model.createElement('span');
    arrow.setAttribute('class', 'sort-indicator');
    button.appendChild(arrow);
    th.appendChild(button);
    row.appendChild(th);
    buttons[key] = button;
  }
  thead.appendChild(row);
  dom.table.insertBefore(thead, dom.tbody);
  return buttons;
}

/**
 * Boot the dashboard over a live table whose unbroken width follows the sort
 * arrow, as the scan found: 400 px while HW Model carries the arrow, 340 px
 * otherwise, in a 343 px column; squeezed, the table fills its column.
 *
 * @param {Array<Object>} nodes Nodes `/api/nodes` serves.
 * @param {function(Object): Promise<void>} fn Body, given the test utils, the sort buttons and the table's class list.
 * @returns {Promise<void>}
 */
async function withSortableTable(nodes, fn) {
  const dom = createLiveTableDom();
  const buttons = addSortHeaders(dom);
  const classList = dom.table.classList;
  const hwArrow = () => buttons.hw_model.querySelector('.sort-indicator').textContent !== '';
  dom.table.getBoundingClientRect = () => ({ width: classList.contains(SQUEEZED_CLASS) ? 343 : (hwArrow() ? 400 : 340) });
  dom.table.parentNode.getBoundingClientRect = () => ({ width: 343 });
  const responses = { 'encrypted=true': [], '/api/nodes/': [], '/api/nodes': nodes, '/api/messages': [] };
  await runLiveApp({ env: dom.env, responses }, ({ testUtils }) => fn({ t: testUtils, buttons, classList, dom }));
}

test('a sort that moves rows is measured with its own arrow, and a same-data repaint keeps the class (PO1)', async () => {
  const nodes = [
    { ...NODES[0], node_id: '!a0000001', hw_model: 'HELTEC_V3', last_heard: NOW - 10 },
    { ...NODES[0], node_id: '!a0000002', hw_model: 'HELTEC_MESH_NODE_T114', last_heard: NOW - 20 },
  ];
  await withSortableTable(nodes, async ({ buttons, classList, dom }) => {
    assert.equal(classList.contains(SQUEEZED_CLASS), false, 'sorted by Last Seen the unbroken table fits');
    buttons.hw_model.click();
    assert.equal(dom.tbody.children[0].getAttribute('data-node-row'), '!a0000002', 'setup: the sort moved the rows');
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'the HW Model arrow widened the table: squeezed');
    dom.filterInput.dispatchEvent({ type: 'input' });
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'a same-data repaint keeps the right class');
    buttons.last_heard.click();
    assert.equal(classList.contains(SQUEEZED_CLASS), false, 'back on Last Seen the table fits unbroken');
  });
});

test('a sort that moves no row is measured too, since its arrow changed the header (PO1)', async () => {
  await withSortableTable([NODES[0]], async ({ buttons, classList, dom }) => {
    assert.equal(classList.contains(SQUEEZED_CLASS), false);
    buttons.hw_model.click();
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'one row, nothing moved, but the header did');
    dom.filterInput.dispatchEvent({ type: 'input' });
    assert.equal(classList.contains(SQUEEZED_CLASS), true, 'a same-data repaint keeps it');
  });
});
