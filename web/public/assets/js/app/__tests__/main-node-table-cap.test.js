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
 * Regression guard for the node-table render cap (frontend perf: render scale).
 *
 * A busy instance has thousands of nodes, and the table renders a main row plus
 * a hidden UX9 disclosure row for each, so rendering the whole set balloons the
 * DOM. This test pins that the table renders only the top {@link
 * NODE_TABLE_RENDER_CAP} rows and expands to the full set when the "show all"
 * control is clicked.
 *
 * @module app/__tests__/main-node-table-cap
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { NODE_TABLE_RENDER_CAP } from '../main/constants.js';

/** Minimal config that disables the auto-refresh timer so timing is ours. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** Resolve a fetch-style JSON response. */
function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Yield so the initial render settles. */
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** Format an integer as a canonical `!%08x` node id. */
const nid = n => `!${n.toString(16).padStart(8, '0')}`;

test('the node table renders capped, then expands to the full set on "show all" (frontend perf)', async () => {
  const env = createDomEnvironment({ includeBody: true });
  // renderTable early-returns without a `#nodes tbody`; provide one so the cap
  // path actually runs. Every other selector stays null (the app tolerates it).
  const tbody = env.document.createElement('tbody');
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);

  const now = Math.floor(Date.now() / 1000);
  const nodeCount = NODE_TABLE_RENDER_CAP + 50;
  const nodesPayload = Array.from({ length: nodeCount }, (_, i) => ({
    node_id: nid(0x20000 + i), last_heard: now - i, short_name: `N${i}`, role: 'CLIENT',
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodesPayload);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();

    // All nodes are loaded into state, but the table renders only the cap.
    assert.equal(_testUtils.getLoadedNodeCount(), nodeCount, 'every node is loaded into module state');
    assert.equal(
      _testUtils.getRenderedNodeCount(), NODE_TABLE_RENDER_CAP,
      'the table renders only the top-N cap, not the whole set',
    );
    assert.equal(_testUtils.isNodeTableExpanded(), false);

    // Clicking the "show all" control lifts the cap and renders every node.
    globalThis.document.dispatchEvent({
      type: 'click',
      target: { closest: selector => (selector === '.nodes-show-all' ? {} : null) },
      preventDefault() {},
      stopPropagation() {},
    });
    await settle();

    assert.equal(_testUtils.isNodeTableExpanded(), true, 'the cap is lifted after show-all');
    assert.equal(
      _testUtils.getRenderedNodeCount(), nodeCount,
      'every node renders once the cap is lifted',
    );

    // A second show-all click is a harmless no-op (already expanded).
    globalThis.document.dispatchEvent({
      type: 'click',
      target: { closest: selector => (selector === '.nodes-show-all' ? {} : null) },
      preventDefault() {},
      stopPropagation() {},
    });
    await settle();
    assert.equal(_testUtils.isNodeTableExpanded(), true);
    assert.equal(_testUtils.getRenderedNodeCount(), nodeCount);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a node set within the cap renders in full with no show-all control', async () => {
  const env = createDomEnvironment({ includeBody: true });
  const tbody = env.document.createElement('tbody');
  env.document.querySelector = selector => (selector === '#nodes tbody' ? tbody : null);

  const now = Math.floor(Date.now() / 1000);
  const nodesPayload = Array.from({ length: 10 }, (_, i) => ({
    node_id: nid(0x30000 + i), last_heard: now - i, short_name: `S${i}`, role: 'CLIENT',
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodesPayload);
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();
    assert.equal(_testUtils.getRenderedNodeCount(), 10, 'a small set renders in full (no cap)');
    assert.equal(_testUtils.isNodeTableExpanded(), false, 'no expansion needed');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
