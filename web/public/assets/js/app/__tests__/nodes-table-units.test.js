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
 * The nodes table prints bare numbers and leaves the unit to the column header
 * (SPEC DV1, design review rc3 T1). The dashboard renders over the live DOM
 * model, so the cells read here are the ones `renderTable` produced. The `+`
 * disclosure row is unchanged: its values stand alone, so they keep their
 * units. With the cells bare, each unit column's accessible name must carry
 * the unit, so the header check boots over the server-rendered `<thead>`.
 *
 * @module app/__tests__/nodes-table-units
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLiveTableDom } from './live-dom-model.js';
import { runLiveApp } from './sse-app-harness.js';

const NOW = Math.floor(Date.now() / 1000);

/** The nodes-table header rows `_nodes_table.erb` serves, without its ERB comments. */
const NODES_THEAD = readFileSync(fileURLToPath(new URL('../../../../../views/shared/_nodes_table.erb', import.meta.url)), 'utf8')
  .match(/<thead>([\s\S]*?)<\/thead>/)[1]
  .replace(/<%#[\s\S]*?%>/g, '');

/** The unit each unit-bearing column header shows, by `nodes-col--` suffix. */
const COLUMN_UNITS = {
  frequency: 'MHz', battery: '%', voltage: 'V', 'channel-util': '%', 'air-util-tx': '%',
  temperature: '°C', humidity: '%', pressure: 'hPa', altitude: 'm',
};

/** A node reporting every numeric column, with decimals that need fixing. */
const GATE = {
  node_id: '!aaaa0001', short_name: 'GATE', long_name: 'Gate', last_heard: NOW - 60, protocol: 'meshtastic', role: 'ROUTER',
  lora_freq: 869, battery_level: 74, voltage: 3.907, uptime_seconds: 90_061, channel_utilization: 6.25, air_util_tx: 1.5,
  temperature: 14.2, relative_humidity: 54.3, barometric_pressure: 1017.8, latitude: 52.52, longitude: 13.405, altitude: 312.4,
};

/** An externally powered node: the battery sentinel and a below-noise voltage. */
const POWERED = {
  node_id: '!aaaa0002', short_name: 'PWR', long_name: 'Powered', last_heard: NOW - 120, protocol: 'meshtastic', role: 'CLIENT',
  battery_level: 101, voltage: 0.004, temperature: -3.5, altitude: 0,
};

/** Numeric columns of the table, by `nodes-col--` suffix. */
const NUMERIC_COLUMNS = [
  'frequency', 'battery', 'voltage', 'uptime', 'channel-util', 'air-util-tx',
  'temperature', 'humidity', 'pressure', 'latitude', 'longitude', 'altitude',
];

/**
 * Render the dashboard table for `GATE` and `POWERED` and hand it to `fn`.
 *
 * @param {(dom: Object) => void} fn Reads the rendered table.
 * @param {{header?: boolean}} [options] `header`: boot over the served
 *   `<thead>`, so `main.js` wires and names its sort buttons.
 * @returns {Promise<void>} Resolves after the app is torn down.
 */
async function withTable(fn, { header = false } = {}) {
  const dom = createLiveTableDom();
  if (header) {
    const thead = dom.document.createElement('thead');
    thead.innerHTML = NODES_THEAD;
    dom.table.insertBefore(thead, dom.tbody);
  }
  const responses = {
    'encrypted=true': [],
    '/api/nodes/': [],
    '/api/nodes': [GATE, POWERED],
    '/api/messages': [],
    '/api/destinations': [],
  };
  await runLiveApp({ responses, env: dom.env }, async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    fn(dom);
  });
}

/**
 * The text of every numeric cell of one node's row.
 *
 * @param {Object} dom Live table handles.
 * @param {string} nodeId Node id.
 * @returns {Object<string, string>} Column suffix to cell text.
 */
function numericCells(dom, nodeId) {
  const row = dom.tbody.children.find(tr => tr.dataset.nodeRow === nodeId);
  return Object.fromEntries(NUMERIC_COLUMNS.map(col => [col, row.querySelector(`.nodes-col--${col}`).textContent.trim()]));
}

/**
 * The `+` disclosure row of one node, as label to value.
 *
 * @param {Object} dom Live table handles.
 * @param {string} nodeId Node id.
 * @returns {Object<string, string>} Field label to displayed value.
 */
function disclosureFields(dom, nodeId) {
  const extra = dom.tbody.children.find(tr => tr.dataset.nodeRow === nodeId).nextElementSibling;
  assert.ok(extra.classList.contains('node-extra'), 'the disclosure row follows the node row');
  return Object.fromEntries(Array.from(extra.querySelectorAll('dt'), dt => [dt.textContent.trim(), dt.nextElementSibling.textContent.trim()]));
}

test('numeric cells are bare numbers with fixed decimals; uptime and coordinates keep their format', async () => {
  await withTable(dom => {
    assert.deepEqual(numericCells(dom, GATE.node_id), {
      frequency: '869',
      battery: '74',
      voltage: '3.91',
      uptime: '1d 1h',
      'channel-util': '6.3',
      'air-util-tx': '1.5',
      temperature: '14.2',
      humidity: '54.3',
      pressure: '1017.8',
      latitude: '52.52000',
      longitude: '13.40500',
      altitude: '312',
    });
  });
});

test('a powered battery reads 100 ⚡, a below-noise voltage the dash, honest zeros stay', async () => {
  await withTable(dom => {
    const cells = numericCells(dom, POWERED.node_id);
    assert.equal(cells.battery, '100 ⚡');
    assert.equal(cells.voltage, '—', '|V| < 0.01 is no reading (UX10)');
    assert.equal(cells.temperature, '-3.5');
    assert.equal(cells.altitude, '0');
    assert.equal(cells.frequency, '—', 'no frequency reported');
  });
});

test('every unit column names its unit in its sort button\'s accessible name (DV1)', async () => {
  // main.js sets each sort button's aria-label from its data-sort-label, and an
  // aria-label replaces the visible label and unit as the header's accessible
  // name: without the unit there, a screen reader hears a bare cell number.
  assert.doesNotMatch(NODES_THEAD, /<%/, 'the header is static markup');
  await withTable(dom => {
    const unitColumns = Array.from(dom.table.querySelectorAll('thead th'))
      .filter(th => th.querySelector('.nodes-col__unit'))
      .map(th => /nodes-col--([\w-]+)/.exec(th.getAttribute('class'))[1]);
    assert.deepEqual(unitColumns, Object.keys(COLUMN_UNITS), 'the nine unit columns');
    for (const [column, unit] of Object.entries(COLUMN_UNITS)) {
      const th = dom.table.querySelector(`thead th.nodes-col--${column}`);
      assert.equal(th.querySelector('.nodes-col__unit').textContent, unit, `${column} shows ${unit}`);
      const name = th.querySelector('.sort-button').getAttribute('aria-label');
      assert.ok(name.startsWith('Sort by ') && name.includes(`(${unit})`), `${column}: "${name}" names (${unit})`);
    }
    // The sorted state rebuilds the name from the same label.
    const battery = dom.table.querySelector('thead th.nodes-col--battery .sort-button');
    battery.click();
    assert.match(battery.getAttribute('aria-label'), /^Battery Level \(%\), sorted (ascending|descending)\. /);
  }, { header: true });
});

test('the + disclosure row keeps its units', async () => {
  await withTable(dom => {
    const fields = disclosureFields(dom, GATE.node_id);
    assert.equal(fields.Frequency, '869MHz');
    assert.equal(fields.Voltage, '3.907V');
    assert.equal(fields.Temperature, '14.2°C');
    assert.equal(fields.Pressure, '1017.8 hPa');
    assert.equal(fields.Altitude, '312.4m');
  });
});
