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

import { initializeNodeDetailMapPanel, __testUtils } from '../node-detail-map.js';

const { extractPositionEntries, resolveReferenceId, colorForDay, ROLE_BY_DAY } = __testUtils;

function createClassList() {
  const values = new Set();
  return {
    add(name) {
      if (name) values.add(name);
    },
    remove(name) {
      values.delete(name);
    },
    contains(name) {
      return values.has(name);
    }
  };
}

function createContainer() {
  return {
    childNodes: [],
    insertBefore(node, before) {
      const idx = before ? this.childNodes.indexOf(before) : -1;
      if (idx >= 0) {
        this.childNodes.splice(idx, 0, node);
      } else {
        this.childNodes.push(node);
      }
      node.parentNode = this;
    },
    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
    }
  };
}

function createElement() {
  return {
    hidden: false,
    textContent: '',
    classList: createClassList(),
    parentNode: null,
    nextSibling: null,
  };
}

function createRootHarness() {
  const section = createElement();
  const slot = createContainer();
  const status = createElement();
  const root = {
    querySelector(selector) {
      if (selector === '[data-node-map-panel]') return section;
      if (selector === '[data-node-map-slot]') return slot;
      if (selector === '[data-node-map-status]') return status;
      return null;
    }
  };
  return { root, section, slot, status };
}

test('extractPositionEntries filters invalid position entries', () => {
  const nowSec = 2_000_000;
  const entries = extractPositionEntries([
    { latitude: 10.5, longitude: 20.25, rx_time: nowSec },
    { lat: '42.1', lon: '-71.2', position_time: nowSec - 100 },
    { latitude: 12, longitude: 24, position_time: nowSec - (86_400 * 11) },
    { latitude: null, longitude: 10, rx_time: nowSec },
    { latitude: 'bad', longitude: 10, rx_time: nowSec },
  ], nowSec);
  assert.deepEqual(entries.map(entry => [entry.lat, entry.lon]), [
    [10.5, 20.25],
    [42.1, -71.2],
  ]);
});

test('resolveReferenceId prefers node identifiers when present', () => {
  assert.equal(resolveReferenceId({ nodeId: '!alpha', nodeNum: 10 }), '!alpha');
  assert.equal(resolveReferenceId({ node_num: 12 }), '12');
  assert.equal(resolveReferenceId(null), null);
});

test('colorForDay interpolates from red to blue', () => {
  const getRoleColor = role => `color:${role}`;
  assert.equal(colorForDay(0, getRoleColor), `color:${ROLE_BY_DAY[0]}`);
  assert.equal(colorForDay(9, getRoleColor), `color:${ROLE_BY_DAY[9]}`);
});

test('initializeNodeDetailMapPanel hides the panel without shared map data', async () => {
  const { root, section, status } = createRootHarness();
  status.hidden = false;
  section.hidden = false;
  const result = await initializeNodeDetailMapPanel(root, { nodeId: '!alpha' }, { fetchImpl: async () => ({ ok: true }) });
  assert.equal(result, null);
  assert.equal(status.hidden, true);
  assert.equal(section.hidden, true);
});

test('initializeNodeDetailMapPanel reuses the shared map and restores it', async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000 * 1000;
  try {
    const { root, slot, status } = createRootHarness();
    const mapPanel = createElement();
    const originalParent = createContainer();
    originalParent.appendChild(mapPanel);
    mapPanel.nextSibling = null;

    const calls = { polyline: null, markers: 0, fitBounds: 0 };
    const map = {
      getCenter() {
        return { lat: 1, lng: 2 };
      },
      getZoom() {
        return 6;
      },
      setView() {},
      fitBounds() {
        calls.fitBounds += 1;
      },
      invalidateSize() {}
    };
    const leaflet = {
      layerGroup() {
        return {
          addTo() {
            return this;
          },
          remove() {}
        };
      },
      polyline(latlngs, options) {
        return {
          addTo() {
            calls.polyline = { latlngs, options };
          }
        };
      },
      circleMarker() {
        return {
          addTo() {
            calls.markers += 1;
          }
        };
      }
    };
    const fitBoundsEl = { checked: true };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          { latitude: 10, longitude: 20, position_time: 1_000_000 },
          { latitude: 11, longitude: 22, position_time: 1_000_000 - 86_400 },
        ];
      }
    });

    const cleanup = await initializeNodeDetailMapPanel(root, { nodeId: '!map' }, {
      fetchImpl,
      mapPanel,
      document: {
        getElementById(id) {
          return id === 'fitBounds' ? fitBoundsEl : null;
        }
      },
      getMapContext: () => ({ map, leaflet }),
      getRoleColor: role => `color:${role}`,
    });

    assert.ok(cleanup);
    assert.equal(status.textContent, '2 positions');
    assert.equal(mapPanel.parentNode, slot);
    assert.equal(mapPanel.classList.contains('map-panel--embedded'), true);
    assert.equal(calls.polyline.options.color, 'color:LOST_AND_FOUND');
    assert.equal(calls.markers, 2);
    assert.equal(fitBoundsEl.checked, false);
    assert.deepEqual(calls.polyline.latlngs, [[10, 20], [11, 22]]);

    cleanup();
    assert.equal(mapPanel.parentNode, originalParent);
    assert.equal(fitBoundsEl.checked, true);
  } finally {
    Date.now = originalNow;
  }
});
