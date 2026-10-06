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
 * Boots the dashboard over a stub fetch that serves one node per protocol,
 * each active this week, then drives the real search input and its clear
 * button. By default the three legend columns are swapped for stubs after
 * boot, since the legend panel needs Leaflet. With `leaflet: true` a stub
 * Leaflet mounts the real panel, so its columns, role chips and Clear filters
 * button are the ones the app built. Everything between the user event and a
 * column's `display` runs as in the browser (listener, `applyFilter`, the
 * `/api/stats` callback, `applyProtocolVisibility`).
 *
 * @module app/__tests__/main-legend-protocols
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDomEnvironment } from './dom-environment.js';
import { makeLeafletStub } from './main-app-leaflet-stub.js';
import { MINIMAL_CONFIG, setupAppWithOptions } from './main-app-test-helpers.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);

/** Column order of the map legend, left to right. */
const LEGEND_ORDER = Object.freeze(['meshcore', 'meshtastic', 'reticulum']);

/**
 * One loaded node per protocol, all heard within the past 7 days. The
 * Meshtastic and MeshCore nodes have a position, so they render a marker;
 * a Reticulum announce carries none.
 */
const NODES = Object.freeze([
  {
    node_id: '!aa000001', short_name: 'ALFA', long_name: 'Alpha Tower',
    role: 'ROUTER', protocol: 'meshtastic', last_heard: NOW - 60,
    latitude: 52.52, longitude: 13.4,
  },
  {
    node_id: '!bb000002', short_name: 'BRAV', long_name: 'Bravo Repeater',
    role: 'REPEATER', protocol: 'meshcore', last_heard: NOW - 120,
    latitude: 52.53, longitude: 13.42,
  },
  {
    node_id: '!cc000003', short_name: 'CHRL', long_name: 'Charlie Peer',
    role: 'PEER', protocol: 'reticulum', last_heard: NOW - 180,
  },
]);

/**
 * Build one `/api/stats` window bucket.
 *
 * @param {number} week Active nodes in the past 7 days.
 * @returns {{hour: number, day: number, week: number, month: number}} Bucket.
 */
const bucket = week => ({ hour: week, day: week, week, month: week });

/** `/api/stats` payload: every protocol has one node active this week. */
const STATS_PAYLOAD = Object.freeze({
  total: { nodes: bucket(3), packets: { hour: 12 } },
  meshtastic: { nodes: bucket(1) },
  meshcore: { nodes: bucket(1) },
  reticulum: { nodes: bucket(1) },
});

/** Click event stub for the handlers `legendClickHandler` wraps. */
const CLICK = Object.freeze({ preventDefault() {}, stopPropagation() {} });

/**
 * Let a user event's `applyFilter` and its `/api/stats` callback settle.
 *
 * @returns {Promise<void>} Resolves after a short timer.
 */
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/**
 * Answer the dashboard's GETs: the node list, the stats snapshot, nothing else.
 *
 * @param {string} url Requested URL.
 * @returns {Promise<{ok: boolean, status: number, json: Function}>} Response stub.
 */
function stubFetch(url) {
  const path = String(url);
  let body = [];
  if (path.startsWith('/api/stats/')) body = [];
  else if (path.startsWith('/api/stats')) body = STATS_PAYLOAD;
  else if (path.startsWith('/api/nodes/')) body = null;
  else if (path.startsWith('/api/nodes')) body = NODES;
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/**
 * Stub Leaflet whose controls mount: `addTo` runs the control's `onAdd`, and
 * `L.DomUtil.create` builds mock elements, so the real legend panel exists.
 *
 * @returns {{leaflet: Object, created: Array<Object>}} The stub and every
 *   element `L.DomUtil.create` built, in creation order.
 */
function makeMountingLeafletStub() {
  const leaflet = makeLeafletStub();
  const created = [];
  leaflet.control = () => ({
    addTo(map) {
      this.container = typeof this.onAdd === 'function' ? this.onAdd(map) : null;
      return this;
    },
  });
  leaflet.DomUtil = {
    create(tagName, className, parent) {
      const element = document.createElement(tagName);
      element.className = className;
      className.split(' ').forEach(name => element.classList.add(name));
      if (parent) parent.appendChild(element);
      created.push(element);
      return element;
    },
  };
  leaflet.DomEvent = { ...leaflet.DomEvent, disableClickPropagation() {}, disableScrollPropagation() {} };
  return { leaflet, created };
}

/**
 * Initialise the app over the mounting Leaflet stub, with a `#map` container,
 * the three meta-row protocol toggles and, unless `searchBox` is false, the
 * search input and its clear button.
 *
 * @param {{searchBox: boolean}} options Whether the view has a search box.
 * @returns {{testUtils: Object, env: Object, leaflet: Object, created: Array<Object>, cleanup: Function}}
 *   App handles; `cleanup` restores the globals.
 */
function setupAppWithLegendPanel({ searchBox }) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('map', env.createElement('div', 'map'));
  const ids = ['protocolToggleMeshcore', 'protocolToggleMeshtastic', 'protocolToggleReticulum'];
  if (searchBox) ids.push('filterInput', 'filterClear');
  for (const id of ids) env.registerElement(id, env.createElement(id === 'filterInput' ? 'input' : 'button', id));
  // initializeApp watches a media query to collapse the legend; the DOM stub has none.
  env.window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} });
  const { leaflet, created } = makeMountingLeafletStub();
  const previousL = globalThis.L;
  globalThis.window.L = leaflet;
  globalThis.L = leaflet;
  const cleanup = () => {
    globalThis.L = previousL;
    env.cleanup();
  };
  try {
    const { _testUtils } = initializeApp(MINIMAL_CONFIG);
    return { testUtils: _testUtils, env, leaflet, created, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Swap the legend columns for stubs (the panel is not mounted without Leaflet).
 *
 * @param {Object} testUtils App test utilities.
 * @returns {Object<string, {style: {display: string}}>} Column stubs by protocol.
 */
function injectColumnStubs(testUtils) {
  const columns = {
    meshcore: { style: { display: '' } },
    meshtastic: { style: { display: '' } },
    reticulum: { style: { display: '' } },
  };
  testUtils._setProtocolColElements(columns.meshcore, columns.meshtastic, columns.reticulum);
  return columns;
}

/**
 * Map the mounted legend columns to their protocols; the panel builds them
 * left to right.
 *
 * @param {Array<Object>} created Elements `L.DomUtil.create` built.
 * @returns {Object<string, Object>} Column elements by protocol.
 */
function mountedColumns(created) {
  const [meshcore, meshtastic, reticulum] = created.filter(element => element.classList.contains('legend-column'));
  return { meshcore, meshtastic, reticulum };
}

/**
 * Boot the app with {@link NODES} loaded.
 *
 * @param {{leaflet?: boolean, searchBox?: boolean}} [options] `leaflet` mounts
 *   the real legend panel; `searchBox: false` (with `leaflet`) boots a view
 *   without the search input.
 * @returns {Promise<{
 *   testUtils: Object,
 *   columns: Object<string, Object>,
 *   input: ?Object,
 *   clearButton: ?Object,
 *   typeFilter: function(string): Promise<void>,
 *   clickClear: function(): Promise<void>,
 *   clickClearFilters: function(): Promise<void>,
 *   clickToggle: function(string): Promise<void>,
 *   clickRoleChip: function(string, string): Promise<void>,
 *   markersOnMap: function(): number,
 *   shown: function(): Array<string>,
 *   cleanup: function(): Promise<void>
 * }>} Harness for one test. The click helpers past `clickClear` and
 *   `markersOnMap` need `leaflet`.
 */
async function bootLegendApp({ leaflet = false, searchBox = true } = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  let harness;
  try {
    harness = leaflet
      ? setupAppWithLegendPanel({ searchBox })
      : setupAppWithOptions({ extraElements: ['filterInput', 'filterClear'] });
    await harness.testUtils.initialLoad;
    await harness.testUtils.flushCollectionBackfills();
    await settle();
    assert.equal(harness.testUtils.getLoadedNodeCount(), NODES.length, 'every stub node is loaded');
  } catch (error) {
    if (harness) harness.testUtils.stopAutoRefresh();
    globalThis.fetch = originalFetch;
    if (harness) harness.cleanup();
    throw error;
  }
  const { testUtils, env } = harness;
  const columns = leaflet ? mountedColumns(harness.created) : injectColumnStubs(testUtils);
  const input = env.document.getElementById('filterInput');
  // The clear button refocuses the input; the DOM stub has no focus().
  if (input) input.focus = () => {};
  const clearButton = env.document.getElementById('filterClear');

  /**
   * Run an element's click listeners, then let the refilter settle.
   *
   * @param {Object} element Mock element.
   * @param {Object} [event] Event passed to the listeners.
   * @returns {Promise<void>} Resolves once settled.
   */
  const click = async (element, event) => {
    element._listeners.get('click').forEach(handler => handler(event));
    await settle();
  };

  return {
    testUtils,
    columns,
    input,
    clearButton,
    async typeFilter(text) {
      input.value = text;
      input._listeners.get('input').forEach(handler => handler());
      await settle();
    },
    clickClear: () => click(clearButton),
    clickClearFilters: () => click(harness.created.find(element => element.classList.contains('legend-reset')), CLICK),
    clickToggle: name => click(env.document.getElementById(`protocolToggle${name}`)),
    clickRoleChip: (protocol, role) => click(columns[protocol].childNodes.find(node => node.dataset?.role === role), CLICK),
    markersOnMap() {
      const { circleMarkers, markers, layerGroups } = harness.leaflet._recorded;
      const nodeMarkers = new Set([...circleMarkers, ...markers]);
      return layerGroups.reduce((count, group) => count + group._layers.filter(layer => nodeMarkers.has(layer)).length, 0);
    },
    shown: () => LEGEND_ORDER.filter(protocol => columns[protocol].style.display !== 'none'),
    async cleanup() {
      await settle();
      testUtils.stopAutoRefresh();
      globalThis.fetch = originalFetch;
      harness.cleanup();
    },
  };
}

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
