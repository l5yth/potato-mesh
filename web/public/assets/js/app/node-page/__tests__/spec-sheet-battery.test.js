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

import { renderSingleNodeTable } from '../single-node-table.js';

const NOW = 1_791_288_000;

/**
 * Extract the Battery row's value from rendered spec-sheet markup.
 *
 * @param {string} html Spec-sheet markup.
 * @returns {string|null} Text of the ``<dd>`` that follows ``<dt>Battery</dt>``.
 */
function batteryValue(html) {
  const match = html.match(/<dt>Battery<\/dt>\s*<dd[^>]*>([^<]*)<\/dd>/);
  return match ? match[1].trim() : null;
}

test('the spec sheet renders the powered sentinel as 100% ⚡ (SPEC UX10)', () => {
  // Meshtastic reports battery_level 101 for externally powered nodes;
  // fmtBattery renders it as "100% ⚡" on the node page and the node overlay.
  const node = { node_id: '!f9ae6de0', role: 'CLIENT', last_heard: NOW - 46, battery_level: 101 };
  assert.equal(batteryValue(renderSingleNodeTable(node, () => '', NOW)), '100% ⚡');
});

test('the spec sheet keeps a real battery percentage', () => {
  const node = { node_id: '!f0acbfba', role: 'ROUTER_LATE', last_heard: NOW - 46, battery_level: 95 };
  assert.match(batteryValue(renderSingleNodeTable(node, () => '', NOW)) ?? '', /^95(\.0)?%$/);
});

test('the spec sheet renders a full battery as a plain percentage (SPEC UX10)', () => {
  // Only a level above 100 is the powered sentinel; exactly 100 stays a plain
  // percentage in fmtBattery.
  const node = { node_id: '!f0acbfba', role: 'ROUTER_LATE', last_heard: NOW - 46, battery_level: 100 };
  assert.equal(batteryValue(renderSingleNodeTable(node, () => '', NOW)), '100%');
});

test('the spec sheet leaves out the Battery row without a reading (SPEC RA6)', () => {
  for (const batteryLevel of [null, undefined]) {
    const node = { node_id: '!f0acbfba', role: 'ROUTER_LATE', last_heard: NOW - 46, battery_level: batteryLevel };
    const html = renderSingleNodeTable(node, () => '', NOW);
    assert.equal(batteryValue(html), null, `battery_level ${batteryLevel} renders no Battery row`);
    assert.match(html, /<dt>Role<\/dt>/, 'the rest of the sheet still renders');
  }
});
