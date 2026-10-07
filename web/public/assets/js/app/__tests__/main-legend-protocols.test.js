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
 * The map legend follows the search text and Clear filters (SPEC LP1).
 *
 * Boots the dashboard through {@link module:app/__tests__/legend-app-harness}
 * with one node per protocol, each active this week, then drives the real
 * search input and its clear button. By default the legend's per-protocol
 * elements are stubs; with `leaflet: true` they are the ones the mounted
 * legend panel built.
 *
 * @module app/__tests__/main-legend-protocols
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LEGEND_ORDER, NODES, bootLegendApp } from './legend-app-harness.js';

test('a protocol whose nodes all fail the text filter leaves the map legend (LP1)', async () => {
  const app = await bootLegendApp();
  try {
    // Only the Meshtastic node matches. MeshCore and Reticulum keep their
    // 7-day activity and stay toggled on: the filter alone takes them out.
    await app.typeFilter('alpha');
    assert.deepEqual(app.shown(), ['meshtastic'], 'only the protocol with a matching node keeps its column');
    assert.equal(app.testUtils.hiddenProtocols.size, 0, 'the text filter toggles no protocol off');

    // Same normalisation as the table: trimmed and case-insensitive, across
    // the node id, short name and long name.
    await app.typeFilter('  BRAVO ');
    assert.deepEqual(app.shown(), ['meshcore'], 'the column set follows the filter text as it changes');
    await app.typeFilter('!cc0000');
    assert.deepEqual(app.shown(), ['reticulum'], 'a node id match keeps its protocol listed');
  } finally {
    await app.cleanup();
  }
});

test('clearing the text filter brings the legend columns back (LP1)', async () => {
  const app = await bootLegendApp();
  try {
    await app.typeFilter('zz-no-such-node-zz');
    assert.deepEqual(app.shown(), [], 'a filter that matches no node leaves no protocol column');

    await app.typeFilter('');
    assert.deepEqual(app.shown(), LEGEND_ORDER, 'deleting the text returns every column');

    await app.typeFilter('charlie');
    assert.deepEqual(app.shown(), ['reticulum']);
    await app.clickClear();
    assert.deepEqual(app.shown(), LEGEND_ORDER, 'the clear button returns every column');
  } finally {
    await app.cleanup();
  }
});

test('role filters never take a protocol column out of the map legend (LP1)', async () => {
  const app = await bootLegendApp();
  try {
    const { testUtils } = app;
    // Switch off the role of the only MeshCore node: it leaves the table and
    // the map, but its column must stay so its role chips can bring it back.
    testUtils.activeRoleFilters.add(testUtils.makeRoleFilterKey('REPEATER', 'meshcore'));
    assert.equal(testUtils.matchesRoleFilter(NODES[1]), false, 'the MeshCore node is filtered out by role');

    await app.typeFilter('');
    assert.deepEqual(app.shown(), LEGEND_ORDER, 'role filters alone hide no column');

    // The text matches only that role-filtered node: MeshCore keeps its
    // column, Meshtastic and Reticulum (no matching node) leave.
    await app.typeFilter('bravo');
    assert.deepEqual(app.shown(), ['meshcore'], 'the text filter decides, the role filter does not');
  } finally {
    await app.cleanup();
  }
});

test('Clear filters also empties the search box and brings the legend columns back (LP1)', async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { testUtils } = app;
    assert.deepEqual(app.shown(), LEGEND_ORDER, 'the mounted legend lists all three protocols');
    assert.equal(app.markersOnMap(), 2, 'the Meshtastic and MeshCore nodes are on the map');

    // A role chip, a protocol toggle and a search that matches nothing.
    await app.clickRoleChip('meshcore', 'REPEATER');
    await app.clickToggle('Reticulum');
    await app.typeFilter('zz-no-such-node-zz');
    assert.equal(testUtils.activeRoleFilters.size, 1);
    assert.ok(testUtils.hiddenProtocols.has('reticulum'));
    assert.deepEqual(app.shown(), [], 'a search that matches nothing leaves no column');
    assert.equal(app.markersOnMap(), 0);

    const repaints = testUtils.getRenderCount();
    await app.clickClearFilters();
    assert.equal(app.input.value, '', 'Clear filters empties the search box');
    assert.equal(app.clearButton.hidden, true, "the search box's clear button hides with the text");
    assert.equal(testUtils.activeRoleFilters.size, 0, 'the role filters are reset');
    assert.equal(testUtils.hiddenProtocols.size, 0, 'the protocol toggles are reset');
    assert.deepEqual(app.shown(), LEGEND_ORDER, 'every active column is back');
    assert.ok(testUtils.getRenderCount() > repaints, 'the table, map and chat refilter');
    assert.equal(app.markersOnMap(), 2, 'both nodes are back on the map');
  } finally {
    await app.cleanup();
  }
});

test("the search box's clear button still clears only the search text (LP1)", async () => {
  const app = await bootLegendApp({ leaflet: true });
  try {
    const { testUtils } = app;
    await app.clickRoleChip('meshcore', 'REPEATER');
    await app.clickToggle('Reticulum');
    await app.typeFilter('zz-no-such-node-zz');
    assert.deepEqual(app.shown(), []);

    await app.clickClear();
    assert.equal(app.input.value, '', 'the search box is empty');
    assert.equal(testUtils.activeRoleFilters.size, 1, 'the role filter stays');
    assert.ok(testUtils.hiddenProtocols.has('reticulum'), 'Reticulum stays toggled off');
    assert.deepEqual(app.shown(), ['meshcore', 'meshtastic'], 'the columns the search removed are back');
    assert.equal(app.markersOnMap(), 1, 'the MeshCore node stays role-filtered off the map');
  } finally {
    await app.cleanup();
  }
});

test('Clear filters still resets the role filters and toggles on a view without a search box (LP1)', async () => {
  const app = await bootLegendApp({ leaflet: true, searchBox: false });
  try {
    const { testUtils } = app;
    assert.equal(app.input, null, 'this view has no search box');
    await app.clickRoleChip('meshcore', 'REPEATER');
    await app.clickToggle('Reticulum');
    assert.deepEqual(app.shown(), ['meshcore', 'meshtastic']);

    await app.clickClearFilters();
    assert.equal(testUtils.activeRoleFilters.size, 0);
    assert.equal(testUtils.hiddenProtocols.size, 0);
    assert.deepEqual(app.shown(), LEGEND_ORDER);
  } finally {
    await app.cleanup();
  }
});
