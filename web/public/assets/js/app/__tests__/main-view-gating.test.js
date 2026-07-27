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
 * Regression guard for the frontend perf fix that stops the shared dashboard app
 * from running its data pipeline on pages that render via their own module. The
 * layout loads `index.js` (→ initializeApp) on every page for the shared header
 * (mobile menu, instance selector, node overlay); on `/charts`, `/federation`,
 * and a node-detail page — which have no dashboard data surface and fetch their
 * own data — the fetch + backfill + auto-refresh/SSE pipeline is pure waste (it
 * even fired the whole bulk-collection backfill on every node-detail view). This
 * test pins that the pipeline is skipped there but still runs on data views.
 *
 * @module app/__tests__/main-view-gating
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

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

/** Yield so any (unwanted) async pipeline work would have started. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

for (const view of ['view-charts', 'view-federation', 'view-node_detail']) {
  test(`skips the dashboard data pipeline on ${view} (renders via its own module)`, async () => {
    const env = createDomEnvironment({ includeBody: true });
    env.document.body.classList.add(view);
    const apiCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = url => {
      if (String(url).includes('/api/')) apiCalls.push(String(url));
      return jsonResponse([]);
    };
    try {
      const { _testUtils } = initializeApp(BASE_CONFIG);
      await _testUtils.initialLoad;
      await settle();
      assert.deepEqual(
        apiCalls, [],
        `no /api/* fetch, backfill, or SSE should run on ${view} (fired: ${apiCalls.join(', ')})`,
      );
      assert.equal(_testUtils.getLoadedNodeCount(), 0, 'no nodes are fetched into the shared app on a self-rendering page');
    } finally {
      globalThis.fetch = originalFetch;
      env.cleanup();
    }
  });
}

test('still runs the data pipeline on the dashboard view', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.document.body.classList.add('view-dashboard');
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => {
    if (String(url).includes('/api/')) apiCalls.push(String(url));
    if (String(url).includes('/api/nodes')) {
      return jsonResponse([{ node_id: '!abcd0001', last_heard: Math.floor(Date.now() / 1000), short_name: 'A', role: 'CLIENT' }]);
    }
    return jsonResponse([]);
  };
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await settle();
    assert.ok(apiCalls.some(u => u.includes('/api/nodes')), 'the dashboard still fetches its data');
    assert.equal(_testUtils.getLoadedNodeCount(), 1, 'the fetched node is loaded on the dashboard');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
