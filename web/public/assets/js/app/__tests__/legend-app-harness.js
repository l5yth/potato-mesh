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
 * Dashboard harness for the map legend tests (SPEC LP1, LS1).
 *
 * Boots the dashboard over a stub fetch that serves one node per protocol,
 * each active this week. By default the legend's per-protocol elements are
 * swapped for stubs after boot, since the legend panel needs Leaflet. With
 * `leaflet: true` a stub Leaflet mounts the real panel, so its columns,
 * groups, role chips and Clear filters button are the ones the app built.
 * Everything between a user event and an element's `display` runs as in the
 * browser (listener, `applyFilter`, the `/api/stats` callback,
 * `applyProtocolVisibility`).
 *
 * @module app/__tests__/legend-app-harness
 */

import assert from 'node:assert/strict';

import { createDomEnvironment } from './dom-environment.js';
import { makeLeafletStub } from './main-app-leaflet-stub.js';
import { MINIMAL_CONFIG, setupAppWithOptions } from './main-app-test-helpers.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);

/** The three protocols, in the order {@link bootLegendApp}'s `shown()` lists them. */
export const LEGEND_ORDER = Object.freeze(['meshcore', 'meshtastic', 'reticulum']);

/**
 * One loaded node per protocol, all heard within the past 7 days. The
 * Meshtastic and MeshCore nodes have a position, so they render a marker;
 * a Reticulum announce carries none.
 */
export const NODES = Object.freeze([
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
 * Initialise the app over the mounting Leaflet stub, with a `#map` container
 * in a `#mapPanel` holding the map toolbar, the three meta-row protocol
 * toggles and, unless `searchBox` is false, the search input and its clear
 * button.
 *
 * @param {{searchBox: boolean}} options Whether the view has a search box.
 * @returns {{testUtils: Object, env: Object, leaflet: Object, created: Array<Object>, cleanup: Function}}
 *   App handles; `cleanup` restores the globals.
 */
function setupAppWithLegendPanel({ searchBox }) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('map', env.createElement('div', 'map'));
  // The map panel and its toolbar (`shared/_map_panel.erb`): the legend's cap
  // reads the toolbar's bottom edge, 44 px below the map's top (SPEC ML3).
  const mapPanel = env.createElement('div', 'mapPanel');
  const toolbar = env.createElement('div');
  toolbar.classList.add('map-toolbar');
  toolbar.getBoundingClientRect = () => ({ top: 12, bottom: 44, height: 32 });
  mapPanel.appendChild(toolbar);
  env.registerElement('mapPanel', mapPanel);
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
 * Swap the legend's per-protocol elements for stubs (the panel is not mounted
 * without Leaflet).
 *
 * @param {Object} testUtils App test utilities.
 * @returns {Object<string, {style: {display: string}}>} Element stubs by protocol.
 */
function injectLegendStubs(testUtils) {
  const elements = {
    meshcore: { style: { display: '' } },
    meshtastic: { style: { display: '' } },
    reticulum: { style: { display: '' } },
  };
  testUtils._setProtocolColElements(elements.meshcore, elements.meshtastic, elements.reticulum);
  return elements;
}

/**
 * Find the legend element each protocol's visibility drives (SPEC LP1): the
 * column or group that opens with the protocol's header. The lookup goes by
 * the header label, not by position, so it holds for any column layout.
 *
 * @param {Object} row The mounted `.legend-items--columns` element.
 * @returns {Object<string, Object>} Legend elements by protocol.
 */
function legendElementsByProtocol(row) {
  const found = {};
  /**
   * Record `element` under its protocol when a header opens it, else search
   * its children.
   *
   * @param {Object} element Mock element.
   * @returns {void}
   */
  const visit = element => {
    const [header] = element.children;
    if (header && header.className === 'legend-column-header') {
      // A header holds the protocol tile, the label and the count.
      found[header.children[1].textContent.toLowerCase()] = element;
    } else {
      element.children.forEach(visit);
    }
  };
  visit(row);
  return found;
}

/**
 * Boot the app with {@link NODES} loaded.
 *
 * @param {{leaflet?: boolean, searchBox?: boolean}} [options] `leaflet` mounts
 *   the real legend panel; `searchBox: false` (with `leaflet`) boots a view
 *   without the search input.
 * @returns {Promise<{
 *   testUtils: Object,
 *   legend: ?Object,
 *   legendRow: ?Object,
 *   map: ?Object,
 *   protocolElements: Object<string, Object>,
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
 * }>} Harness for one test. `legend` is the mounted `#mapLegend` panel and
 *   `legendRow` its `.legend-items--columns` element, `map` the stub Leaflet
 *   map (see `_setSize` and `_fire`), all null without `leaflet`;
 *   `protocolElements` maps each protocol to the legend element its
 *   visibility drives. The click helpers past `clickClear` and
 *   `markersOnMap` need `leaflet`.
 */
export async function bootLegendApp({ leaflet = false, searchBox = true } = {}) {
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
  const legendRow = leaflet ? harness.created.find(element => element.classList.contains('legend-items--columns')) : null;
  const protocolElements = legendRow ? legendElementsByProtocol(legendRow) : injectLegendStubs(testUtils);
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
    legend: leaflet ? harness.created.find(element => element.id === 'mapLegend') : null,
    legendRow,
    map: leaflet ? harness.leaflet._map : null,
    protocolElements,
    input,
    clearButton,
    async typeFilter(text) {
      input.value = text;
      input._listeners.get('input').forEach(handler => handler());
      // Enter applies the text at once, instead of once typing pauses (SPEC DE2).
      (input._listeners.get('keydown') || []).forEach(handler => handler({ key: 'Enter' }));
      await settle();
    },
    clickClear: () => click(clearButton),
    clickClearFilters: () => click(harness.created.find(element => element.classList.contains('legend-reset')), CLICK),
    clickToggle: name => click(env.document.getElementById(`protocolToggle${name}`)),
    clickRoleChip: (protocol, role) =>
      click(protocolElements[protocol].childNodes.find(node => node.dataset?.role === role), CLICK),
    markersOnMap() {
      const { circleMarkers, markers, layerGroups } = harness.leaflet._recorded;
      const nodeMarkers = new Set([...circleMarkers, ...markers]);
      return layerGroups.reduce((count, group) => count + group._layers.filter(layer => nodeMarkers.has(layer)).length, 0);
    },
    shown: () => LEGEND_ORDER.filter(protocol => protocolElements[protocol].style.display !== 'none'),
    async cleanup() {
      await settle();
      testUtils.stopAutoRefresh();
      globalThis.fetch = originalFetch;
      harness.cleanup();
    },
  };
}
