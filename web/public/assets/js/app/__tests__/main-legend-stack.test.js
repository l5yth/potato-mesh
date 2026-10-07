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
 * The map legend stacks Reticulum under MeshCore (SPEC LS1).
 *
 * Boots the dashboard through {@link module:app/__tests__/legend-app-harness}
 * with the real legend panel mounted and one node per protocol, each active
 * this week, then reads the panel's element tree while the meta-row protocol
 * toggles and the search box change what is in view. The DOM stub lays
 * nothing out, so the 8 px gap and the top alignment are checked where they
 * are decided: which groups are laid out, and the base.css rules.
 *
 * @module app/__tests__/main-legend-stack
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bootLegendApp } from './legend-app-harness.js';
import { meshcoreRoleColors, reticulumRoleColors, roleColors } from '../role-helpers.js';

/** The dashboard stylesheet. */
const CSS = readFileSync(fileURLToPath(new URL('../../../styles/base.css', import.meta.url)), 'utf8');

/**
 * Locate the base.css rule whose selector is exactly `selector`.
 *
 * @param {string} selector Selector that opens the rule on its own line.
 * @returns {{start: number, body: string}} Offset of the rule and its text.
 */
function cssRule(selector) {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `base.css has a ${selector} rule`);
  return { start, body: CSS.slice(start, CSS.indexOf('}', start) + 1) };
}

/**
 * Read the mounted legend: its columns and, in the first, the two groups.
 *
 * @param {{legendRow: Object}} app Harness from {@link bootLegendApp}.
 * @returns {{columns: Array<Object>, stack: Object, meshtastic: Object, meshcore: Object, reticulum: Object}}
 *   The row's columns, the first column, the second, and the first column's
 *   two children.
 */
function legendParts(app) {
  const columns = app.legendRow.children;
  const [stack, meshtastic] = columns;
  const [meshcore, reticulum] = stack.children;
  return { columns, stack, meshtastic, meshcore, reticulum };
}

/**
 * Header label of a column or group.
 *
 * @param {Object} element Column or group element.
 * @returns {string} The label beside the protocol tile.
 */
const headerLabel = element => element.children[0].children[1].textContent;

/**
 * Compound keys of the role chips in a column or group, in order.
 *
 * @param {Object} element Column or group element.
 * @returns {Array<string>} `protocol:ROLE` per chip.
 */
const roleChips = element =>
  element.children.filter(child => child.dataset.role).map(chip => `${chip.dataset.protocol}:${chip.dataset.role}`);

/**
 * Compound keys a role palette produces for one protocol, in palette order.
 *
 * @param {Record<string, string>} palette Role to colour map.
 * @param {string} protocol Protocol token.
 * @returns {Array<string>} `protocol:ROLE` per palette entry.
 */
const paletteKeys = (palette, protocol) => Object.keys(palette).map(role => `${protocol}:${role}`);

/**
 * Assert which children of an element are laid out, i.e. not hidden with
 * `display: none`, by identity and in order.
 *
 * @param {Object} element Parent element.
 * @param {Array<Object>} expected Children expected in the layout.
 * @param {string} message Assertion message.
 * @returns {void}
 */
function assertLaidOut(element, expected, message) {
  const laidOut = element.children.filter(child => child.style.display !== 'none');
  assert.equal(laidOut.length, expected.length, message);
  expected.forEach((child, index) => assert.equal(laidOut[index], child, message));
}

test('the map legend has two columns: MeshCore over Reticulum, then Meshtastic (LS1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { columns, stack, meshtastic, meshcore, reticulum } = legendParts(app);
    assert.equal(columns.length, 2, 'two columns, not three');
    assert.equal(stack.className, 'legend-column legend-column--stack');
    assert.deepEqual(stack.children.map(headerLabel), ['Meshcore', 'Reticulum'], 'the first column stacks MeshCore above Reticulum');
    assert.equal(meshcore.className, 'legend-group');
    assert.equal(reticulum.className, 'legend-group');
    assert.deepEqual(roleChips(meshcore), paletteKeys(meshcoreRoleColors, 'meshcore'), 'the MeshCore group carries its role filters');
    assert.deepEqual(roleChips(reticulum), paletteKeys(reticulumRoleColors, 'reticulum'), 'the Reticulum group carries its role filters');
    assert.equal(headerLabel(meshtastic), 'Meshtastic', 'the second column is Meshtastic');
  } finally {
    await app.cleanup();
  }
});

test('the Meshtastic column keeps its ten role filters and its line and Waypoints toggles (LS1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { columns } = legendParts(app);
    const meshtastic = columns[columns.length - 1];
    assert.equal(headerLabel(meshtastic), 'Meshtastic', 'Meshtastic is the last column');
    assert.equal(meshtastic.className, 'legend-column');
    assert.deepEqual(roleChips(meshtastic), paletteKeys(roleColors, 'meshtastic'));
    assert.equal(roleChips(meshtastic).length, 10, 'ten role filters');
    const [, ...items] = meshtastic.children;
    assert.deepEqual(
      items.slice(10).map(item => item.className),
      ['legend-item legend-toggle-neighbors', 'legend-item legend-toggle-traces', 'legend-item legend-toggle-waypoints'],
      'the neighbor-line, trace-line and Waypoints toggles follow the role filters in the Meshtastic column',
    );
    assert.equal(items.length, 13, 'nothing else joins the column');
    assert.equal(app.testUtils.getWaypointsToggleButton(), items[12]);
  } finally {
    await app.cleanup();
  }
});

test('a protocol toggled off hides only its own group, and the 8 px sits only between visible groups (LS1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { stack, meshtastic, meshcore, reticulum } = legendParts(app);
    assertLaidOut(stack, [meshcore, reticulum], 'both groups in view: both laid out, the gap between them');

    await app.clickToggle('Meshcore');
    assert.equal(meshcore.style.display, 'none', 'MeshCore out of view: its group hides');
    assert.equal(stack.style.display, '', 'the first column stays for Reticulum');
    assertLaidOut(stack, [reticulum], 'Reticulum alone is laid out first: no gap above it, it top-aligns');
    assert.equal(meshtastic.style.display, '', 'the Meshtastic column behaves as before');

    await app.clickToggle('Meshcore');
    await app.clickToggle('Reticulum');
    assert.equal(reticulum.style.display, 'none', 'Reticulum out of view: its group hides');
    assert.equal(stack.style.display, '');
    assertLaidOut(stack, [meshcore], 'MeshCore alone: no gap below it');
    assert.equal(meshtastic.style.display, '');
  } finally {
    await app.cleanup();
  }
});

test('the first column leaves the row when both of its groups are out of view (LS1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { stack, meshtastic, meshcore, reticulum } = legendParts(app);
    await app.clickToggle('Meshcore');
    await app.clickToggle('Reticulum');
    assert.equal(meshcore.style.display, 'none');
    assert.equal(reticulum.style.display, 'none');
    assert.equal(stack.style.display, 'none', 'an empty first column leaves no stray gap in the row');
    assert.equal(meshtastic.style.display, '', 'Meshtastic keeps its column');

    await app.clickToggle('Reticulum');
    assert.equal(stack.style.display, '', 'a group back in view brings the column back');
    assertLaidOut(stack, [reticulum], 'with only the group that came back');
  } finally {
    await app.cleanup();
  }
});

test('the search text drives the groups and the first column as the toggles do (LS1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { stack, meshtastic, meshcore, reticulum } = legendParts(app);
    await app.typeFilter('alpha');
    assert.equal(stack.style.display, 'none', 'no MeshCore or Reticulum node matches: the first column leaves');
    assert.equal(meshtastic.style.display, '');

    await app.typeFilter('bravo');
    assert.equal(stack.style.display, '');
    assertLaidOut(stack, [meshcore], 'only the MeshCore node matches: its group alone');
    assert.equal(meshtastic.style.display, 'none', 'Meshtastic out of view: its column leaves with its toggles');

    await app.typeFilter('');
    assertLaidOut(stack, [meshcore, reticulum], 'no search text: both groups are back');
    assert.equal(meshtastic.style.display, '');
  } finally {
    await app.cleanup();
  }
});

test('base.css puts the 8 px only between laid-out groups (LS1)', () => {
  const column = cssRule('.legend-column');
  const stack = cssRule('.legend-column--stack');
  const group = cssRule('.legend-group');
  assert.match(cssRule('.legend-items--columns').body, /\bgap: 8px;/, 'the columns sit 8 px apart');
  assert.match(stack.body, /\bgap: 8px;/, 'the groups sit 8 px apart, as the columns do');
  assert.ok(stack.start > column.start, 'the stack gap comes after the column gap it overrides');
  // A flex gap is laid out only between items in the flow, so a group hidden
  // with `display: none` takes its gap with it. A margin would stay behind.
  assert.match(group.body, /display: flex;/);
  assert.match(group.body, /flex-direction: column;/);
  assert.doesNotMatch(group.body, /margin/);
});

test('base.css lets a lone group top-align with the Meshtastic column (LS1, FU12)', () => {
  // Nothing offsets the top of the first column or of a group, so whichever
  // group is laid out first starts at the column top, level with Meshtastic.
  for (const selector of ['.legend-column--stack', '.legend-group']) {
    assert.doesNotMatch(cssRule(selector).body, /padding|margin|justify-content/, `${selector} keeps its items at the top`);
  }
  assert.doesNotMatch(CSS, /legend-column--bottom/, 'no column is bottom-aligned (FU12)');
});
