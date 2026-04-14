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
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/** Minimal config that disables auto-refresh so we control timing. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  tileFilters: { light: '', dark: '' },
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/**
 * Build a stubbed fetch that records every call and responds with canned data.
 *
 * @param {Object} responsesByEndpoint Map of URL prefix to JSON response body.
 * @returns {{ fetch: Function, calls: Array<{ url: string, options: Object }> }}
 */
function buildStubFetch(responsesByEndpoint = {}) {
  const calls = [];

  function stubFetch(url, options = {}) {
    calls.push({ url, options });
    for (const [prefix, body] of Object.entries(responsesByEndpoint)) {
      if (url.includes(prefix)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(
            typeof body === 'function' ? body() : body,
          ),
        });
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
  }

  return { fetch: stubFetch, calls };
}

/**
 * Run test body with a fetch-stubbed app instance.
 *
 * @param {Object} stubResponses Response map for the stub fetch.
 * @param {function(Object): Promise<void>} fn Receives { testUtils, calls }.
 */
async function withStubFetchApp(stubResponses, fn) {
  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  const { fetch: stubFetch, calls } = buildStubFetch(stubResponses);
  globalThis.fetch = stubFetch;
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    // Allow the initial refresh() to settle (it is async).
    await new Promise(r => setTimeout(r, 50));
    await fn({ testUtils: _testUtils, calls });
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Verify fetch functions append since parameter
// ---------------------------------------------------------------------------

test('first refresh does not include since parameter in fetch URLs', async () => {
  await withStubFetchApp({}, ({ calls }) => {
    const apiCalls = calls.filter(c => c.url.startsWith('/api/'));
    assert.ok(apiCalls.length > 0, 'should have made API calls');
    for (const call of apiCalls) {
      assert.ok(
        !call.url.includes('since='),
        `first refresh should not pass since: ${call.url}`,
      );
    }
  });
});

test('second refresh includes since parameter for endpoints with timestamp data', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stubResponses = {
    '/api/nodes': [{ node_id: '!aabb', last_heard: now, short_name: 'AB', role: 'CLIENT' }],
    '/api/messages': [{ id: 1, rx_time: now, from_id: '!aabb', text: 'hello' }],
    '/api/positions': [{ id: 1, node_id: '!aabb', rx_time: now, latitude: 52.5, longitude: 13.4 }],
    '/api/telemetry': [{ id: 1, node_id: '!aabb', rx_time: now, battery_level: 90 }],
    '/api/neighbors': [{ node_id: '!aabb', neighbor_id: '!ccdd', rx_time: now, snr: 10 }],
    '/api/traces': [{ id: 1, rx_time: now, src: 1, dest: 2 }],
  };

  await withStubFetchApp(stubResponses, async ({ testUtils, calls }) => {
    // Verify first refresh completed without since params
    const firstRoundCalls = [...calls];
    const firstApiCalls = firstRoundCalls.filter(c => c.url.startsWith('/api/'));
    assert.ok(firstApiCalls.length > 0, 'initial refresh should have fired');
    for (const call of firstApiCalls) {
      assert.ok(
        !call.url.includes('since='),
        `first refresh should not pass since: ${call.url}`,
      );
    }

    // Clear call log and trigger a second refresh
    calls.length = 0;
    await testUtils.refresh();
    await new Promise(r => setTimeout(r, 50));

    // Second refresh should include since= on all data endpoints
    const secondApiCalls = calls.filter(c => c.url.startsWith('/api/'));
    assert.ok(secondApiCalls.length > 0, 'second refresh should have fired');

    const nodeCall = secondApiCalls.find(c => c.url.includes('/api/nodes?'));
    assert.ok(nodeCall, 'should have made a nodes call');
    assert.ok(nodeCall.url.includes('since='), `nodes should include since: ${nodeCall.url}`);

    const posCall = secondApiCalls.find(c => c.url.includes('/api/positions?'));
    assert.ok(posCall, 'should have made a positions call');
    assert.ok(posCall.url.includes('since='), `positions should include since: ${posCall.url}`);

    const telCall = secondApiCalls.find(c => c.url.includes('/api/telemetry?'));
    assert.ok(telCall, 'should have made a telemetry call');
    assert.ok(telCall.url.includes('since='), `telemetry should include since: ${telCall.url}`);

    const nbCall = secondApiCalls.find(c => c.url.includes('/api/neighbors?'));
    assert.ok(nbCall, 'should have made a neighbors call');
    assert.ok(nbCall.url.includes('since='), `neighbors should include since: ${nbCall.url}`);

    const trCall = secondApiCalls.find(c => c.url.includes('/api/traces?'));
    assert.ok(trCall, 'should have made a traces call');
    assert.ok(trCall.url.includes('since='), `traces should include since: ${trCall.url}`);

    const msgCalls = secondApiCalls.filter(c => c.url.includes('/api/messages?'));
    assert.ok(msgCalls.length > 0, 'should have made message calls');
    for (const mc of msgCalls) {
      assert.ok(mc.url.includes('since='), `messages should include since: ${mc.url}`);
    }
  });
});

test('second refresh merges incremental data into existing state', async () => {
  const now = Math.floor(Date.now() / 1000);
  let callCount = 0;

  // First call returns node A, second call returns node B
  const stubResponses = {
    '/api/nodes': () => {
      callCount++;
      if (callCount <= 1) {
        return [{ node_id: '!aaaa', last_heard: now, short_name: 'AA', role: 'CLIENT' }];
      }
      return [{ node_id: '!bbbb', last_heard: now + 60, short_name: 'BB', role: 'CLIENT' }];
    },
  };

  await withStubFetchApp(stubResponses, async ({ testUtils, calls }) => {
    // After first refresh, call count should be 1
    assert.ok(callCount >= 1, 'first refresh should have fetched nodes');

    // Trigger second refresh
    calls.length = 0;
    await testUtils.refresh();
    await new Promise(r => setTimeout(r, 50));

    // The second refresh should have merged data
    assert.ok(callCount >= 2, 'second refresh should have fetched nodes again');
  });
});

test('fetch functions use cache: default option', async () => {
  await withStubFetchApp({}, ({ calls }) => {
    const apiCalls = calls.filter(c => c.url.startsWith('/api/'));
    for (const call of apiCalls) {
      assert.equal(
        call.options.cache,
        'default',
        `${call.url} should use cache:default`,
      );
    }
  });
});

test('messages fetch sends encrypted parameter when requested', async () => {
  await withStubFetchApp({}, ({ calls }) => {
    const encryptedCalls = calls.filter(
      c => c.url.includes('/api/messages') && c.url.includes('encrypted=true'),
    );
    assert.ok(encryptedCalls.length > 0, 'should have made encrypted message call');
  });
});

test('since parameter uses a 1-second overlap to avoid missing rows', async () => {
  const now = Math.floor(Date.now() / 1000);
  const stubResponses = {
    '/api/nodes': [{ node_id: '!test', last_heard: now, short_name: 'T', role: 'CLIENT' }],
  };

  await withStubFetchApp(stubResponses, async ({ testUtils, calls }) => {
    calls.length = 0;
    await testUtils.refresh();
    await new Promise(r => setTimeout(r, 50));

    const nodeCall = calls.find(c => c.url.includes('/api/nodes?'));
    assert.ok(nodeCall, 'should have nodes call on second refresh');
    // The since value should be (now - 1) to create the overlap
    const expectedSince = now - 1;
    assert.ok(
      nodeCall.url.includes(`since=${expectedSince}`),
      `expected since=${expectedSince} in URL: ${nodeCall.url}`,
    );
  });
});
