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
 * The node overlay reads roles and names from the dashboard's node registry
 * (SPEC OV1, OV2). A hub with 127 neighbours on a loaded dashboard opens with
 * its eight detail reads only: no ``/api/nodes?limit=1000`` registry fetch and
 * no ``/api/nodes/:id`` lookup per neighbour (136 requests before). The
 * neighbours keep their roles and names, and a node the dashboard refreshed
 * shows its new name on the next open.
 *
 * @module app/__tests__/main-node-overlay-registry
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { MINIMAL_CONFIG } from './main-app-test-helpers.js';
import { clickNodeLongLink, registerNodeDetailOverlay } from './node-overlay-harness.js';
import { initializeApp } from '../main.js';

/** The hub the overlay opens, as in the M21 diagnosis. */
const HUB = '!a000000f';
/** Neighbours of the hub, as in the M21 diagnosis. */
const NEIGHBOUR_COUNT = 127;
/** No auto-refresh timer: the test drives the one refresh it needs. */
const CONFIG = Object.freeze({ ...MINIMAL_CONFIG, refreshIntervalSeconds: 0 });

/**
 * Format an integer as a canonical ``!%08x`` node id.
 *
 * @param {number} n Node number.
 * @returns {string} Canonical node id.
 */
const nid = n => `!${n.toString(16).padStart(8, '0')}`;

/**
 * Build the mesh the stubbed API serves: the hub, its neighbours (every third
 * a repeater) and the hub's neighbour rows, which carry no role.
 *
 * @param {number} now Current unix time in seconds.
 * @returns {{ nodes: Array<Object>, rows: Array<Object> }} Node records and neighbour rows.
 */
function buildMesh(now) {
  const hub = {
    node_id: HUB, short_name: 'HUB0', long_name: 'Hub Zero', role: 'ROUTER',
    last_heard: now - 30, protocol: 'meshtastic',
  };
  const neighbours = Array.from({ length: NEIGHBOUR_COUNT }, (_, i) => ({
    node_id: nid(0xb0000000 + i), short_name: `N${i}`, long_name: `Neighbour ${i}`,
    role: i % 3 === 0 ? 'REPEATER' : 'CLIENT', last_heard: now - 60 - i, protocol: 'meshtastic',
  }));
  const rows = neighbours.map(node => ({ node_id: HUB, neighbor_id: node.node_id, snr: 5.5, rx_time: now - 90 }));
  return { nodes: [hub, ...neighbours], rows };
}

/**
 * A stubbed ``fetch`` serving the dashboard's collections, the per-id node
 * reads and the hub's neighbour rows; every request is logged.
 *
 * @param {{ nodes: Array<Object>, rows: Array<Object> }} mesh Served data.
 * @returns {{ calls: Array<string>, fetchStub: Function, update: Function }}
 *   The request log, the stub, and ``update(record)`` which changes a node
 *   on the server and serves it to the next delta refresh.
 */
function stubApi(mesh) {
  const byId = new Map(mesh.nodes.map(node => [node.node_id, node]));
  let delta = [];
  const calls = [];
  const respond = (body, status = 200) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  const fetchStub = url => {
    const href = String(url);
    calls.push(href);
    const [path, query = ''] = href.split('?');
    if (path.startsWith('/api/nodes/')) {
      const node = byId.get(decodeURIComponent(path.slice('/api/nodes/'.length)));
      return node ? respond({ ...node }) : respond({ error: 'not found' }, 404);
    }
    if (path === '/api/nodes') {
      if (query.includes('before=')) return respond([]);
      if (query.includes('since=')) return respond(delta.map(node => ({ ...node })));
      return respond(mesh.nodes.map(node => ({ ...node })));
    }
    if (path === `/api/neighbors/${HUB}` || (path === '/api/neighbors' && !query.includes('before='))) {
      return respond(mesh.rows.map(row => ({ ...row })));
    }
    return respond([]);
  };
  const update = record => {
    byId.set(record.node_id, record);
    delta = [record];
  };
  return { calls, fetchStub, update };
}

/**
 * Whether a request belongs to an overlay open: a per-node read or the
 * registry page the overlay used to fetch.
 *
 * @param {string} url Requested URL.
 * @returns {boolean} ``true`` for overlay requests.
 */
function isOverlayRequest(url) {
  const [path] = url.split('?');
  return /^\/api\/(nodes|telemetry|positions|neighbors|messages|traces|waypoints)\//.test(path)
    || url.startsWith('/api/destinations?node_id=')
    || url === '/api/nodes?limit=1000';
}

/**
 * Sort an overlay open's requests into the registry fetch, the per-neighbour
 * lookups and the reads of the hub itself.
 *
 * @param {Array<string>} urls Requests issued during the open.
 * @returns {{ total: number, registry: number, lookups: number, hubReads: number }} Counts.
 */
function tallyOverlayRequests(urls) {
  const overlay = urls.filter(isOverlayRequest);
  return {
    total: overlay.length,
    registry: overlay.filter(url => url === '/api/nodes?limit=1000').length,
    lookups: overlay.filter(url => url.startsWith('/api/nodes/') && !url.startsWith(`/api/nodes/${HUB}`)).length,
    hubReads: overlay.filter(url => url.includes(HUB)).length,
  };
}

/**
 * Open the hub's overlay and wait until the manager wrote the rendered node.
 *
 * @param {{ innerHTML: string }} content Overlay content element.
 * @returns {Promise<string>} The rendered overlay HTML.
 */
async function openHubOverlay(content) {
  content.innerHTML = '';
  clickNodeLongLink(HUB, 'Hub Zero');
  const deadline = Date.now() + 5000;
  while (!content.innerHTML.includes('node-detail__header')) {
    if (Date.now() > deadline) throw new Error(`overlay did not render: ${content.innerHTML.slice(0, 200)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return content.innerHTML;
}

/**
 * The role each neighbour badge carries in its ``data-node-info``.
 *
 * @param {string} html Rendered overlay HTML.
 * @param {string} nodeId Neighbour id.
 * @returns {?string} Role named by the badge, or ``null`` without a badge.
 */
function badgeRole(html, nodeId) {
  const match = html.match(new RegExp(`&quot;nodeId&quot;:&quot;${nodeId}&quot;.*?&quot;role&quot;:&quot;([A-Z_]+)&quot;`));
  return match ? match[1] : null;
}

test('a hub overlay on a loaded dashboard makes its eight detail reads only (SPEC OV1, OV2)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  const { content } = registerNodeDetailOverlay(env);
  const mesh = buildMesh(Math.floor(Date.now() / 1000));
  const api = stubApi(mesh);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = api.fetchStub;
  let testUtils = null;
  try {
    testUtils = initializeApp(CONFIG)._testUtils;
    await testUtils.initialLoad;
    await testUtils.flushCollectionBackfills();
    assert.equal(testUtils.getLoadedNodeCount(), NEIGHBOUR_COUNT + 1, 'the dashboard holds the hub and every neighbour');

    const mark = api.calls.length;
    const html = await openHubOverlay(content);
    assert.deepEqual(
      tallyOverlayRequests(api.calls.slice(mark)),
      { total: 8, registry: 0, lookups: 0, hubReads: 8 },
      'the open reads the hub only: no registry page, no lookup per neighbour',
    );
    // Same content as the per-id lookups gave: every neighbour with its name and role.
    const neighbours = mesh.nodes.slice(1);
    assert.deepEqual(neighbours.filter(node => !html.includes(`title="${node.long_name}"`)).map(node => node.node_id), []);
    assert.deepEqual(neighbours.filter(node => badgeRole(html, node.node_id) !== node.role).map(node => node.node_id), []);

    // The node changes on the server; the dashboard's next refresh picks it
    // up, and the next open shows it, still without a lookup.
    const renamed = { ...neighbours[0], long_name: 'Renamed Zero', last_heard: neighbours[0].last_heard + 600 };
    api.update(renamed);
    await testUtils.refresh();
    const reopenMark = api.calls.length;
    const reopened = await openHubOverlay(content);
    assert.equal(reopened.includes('title="Renamed Zero"'), true, 'the reopened overlay shows the refreshed name');
    assert.equal(reopened.includes('title="Neighbour 0"'), false);
    assert.deepEqual(tallyOverlayRequests(api.calls.slice(reopenMark)), { total: 8, registry: 0, lookups: 0, hubReads: 8 });
  } finally {
    testUtils?.stopAutoRefresh();
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
