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
 * PS-A5 — SSE live updates replace the 60s primary poll. Drives main.js over a
 * fake EventSource + stub fetch and asserts: a per-collection ping triggers a
 * targeted delta fetch; a (re)connect triggers a full resync; the cadence is the
 * slow safety poll while live, and the legacy poll when SSE is unavailable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);

const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 60_000,
  refreshIntervalSeconds: 60,
  safetyPollMs: 300_000,
  liveUpdatesEnabled: true,
  liveUpdatesPath: '/api/events',
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  tileFilters: { light: '', dark: '' },
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

const NODES = [
  { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' },
];
const MESSAGES = [
  { id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'hello', rx_time: NOW, protocol: 'meshtastic' },
];

/** Build a recording stub fetch answering from a URL-substring map. */
function buildStubFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch(url) {
      calls.push({ url });
      for (const [prefix, body] of Object.entries(responses)) {
        if (url.includes(prefix)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        }
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    },
  };
}

/** A fresh fake EventSource class recording listeners + instances. */
function makeFakeEventSource() {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    close() {
      this.closed = true;
    }

    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    }
  }
  FakeEventSource.instances = [];
  return FakeEventSource;
}

/**
 * Boot one app instance with a fake EventSource + stub fetch (cache disabled),
 * await the initial load, run the body, then tear the timer/stream down.
 */
async function runLiveApp({ configOverrides = {}, withEventSource = true, responses } = {}, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  const originalIdb = globalThis.indexedDB;
  const { fetch: stubFetch, calls } = buildStubFetch(
    responses || { '/api/nodes': NODES, '/api/messages': MESSAGES },
  );
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = undefined; // disable the persistent cache for a clean cold path
  const FakeEventSource = makeFakeEventSource();
  if (withEventSource) globalThis.EventSource = FakeEventSource;
  else delete globalThis.EventSource;
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp({ ...BASE_CONFIG, ...configOverrides }));
    await testUtils.initialLoad;
    await testUtils.flushBackfill();
    await fn({ calls, testUtils, FakeEventSource });
  } finally {
    // Let fire-and-forget refresh tails (the stats footer update at main.js
    // `void fetchActiveNodeStats(...).then(...)`, cache write-back) settle
    // against the live DOM before teardown, so no async work touches a
    // torn-down document.
    if (testUtils) await testUtils.flushCacheWrites();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    if (testUtils) testUtils.stopAutoRefresh(); // clear the armed interval so node can exit
    globalThis.fetch = originalFetch;
    if (originalES === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalES;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
}

test('live updates active: SSE stream opens and the cadence is the slow safety poll', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    assert.equal(testUtils.isLiveActive(), true);
    assert.equal(testUtils.getAutoRefreshIntervalMs(), 300_000); // safety poll, not 60s
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(FakeEventSource.instances[0].url, '/api/events');
  });
});

test('a messages ping triggers a targeted delta fetch, not a full refresh', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const before = calls.length;
    FakeEventSource.instances[0].dispatch('change', {
      data: JSON.stringify({ collection: 'messages' }),
    });
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(
      after.some((c) => c.url.startsWith('/api/messages?') && c.url.includes('since=')),
      `messages delta should be fetched: ${after.map((c) => c.url).join(', ')}`,
    );
    assert.ok(
      !after.some((c) => c.url.startsWith('/api/nodes?')),
      `nodes must NOT be refetched on a messages-only ping: ${after.map((c) => c.url).join(', ')}`,
    );
  });
});

test('a burst of pings coalesces into one refresh of just the dirty collections', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const es = FakeEventSource.instances[0];
    const before = calls.length;
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    es.dispatch('change', { data: JSON.stringify({ collection: 'positions' }) });
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(after.some((c) => c.url.startsWith('/api/messages?')), 'messages fetched');
    assert.ok(after.some((c) => c.url.startsWith('/api/positions?')), 'positions fetched');
    assert.ok(!after.some((c) => c.url.startsWith('/api/nodes?')), 'nodes not fetched (clean)');
  });
});

test('a (re)connect triggers a full resync, clearing any pending targeted fetch', async () => {
  await runLiveApp({}, async ({ calls, testUtils, FakeEventSource }) => {
    const es = FakeEventSource.instances[0];
    const before = calls.length;
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) }); // arms a pending fetch
    es.dispatch('open', {}); // resync supersedes it with a full refresh
    await testUtils.flushLiveRefresh();
    const after = calls.slice(before);
    assert.ok(after.some((c) => c.url.startsWith('/api/nodes?')), 'nodes refetched on resync');
    assert.ok(after.some((c) => c.url.startsWith('/api/messages?')), 'messages refetched on resync');
  });
});

test('a stream error is swallowed (never load-bearing)', async () => {
  const originalDebug = console.debug;
  let reported = false;
  console.debug = () => {
    reported = true;
  };
  try {
    await runLiveApp({}, async ({ FakeEventSource }) => {
      assert.doesNotThrow(() => FakeEventSource.instances[0].dispatch('error', {}));
    });
  } finally {
    console.debug = originalDebug;
  }
  assert.equal(reported, true);
});

test('restartAutoRefresh reuses the existing stream rather than opening a second', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    testUtils.restartAutoRefresh();
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(testUtils.isLiveActive(), true);
  });
});

test('no EventSource support falls back to the legacy poll cadence', async () => {
  await runLiveApp({ withEventSource: false }, async ({ testUtils }) => {
    assert.equal(testUtils.isLiveActive(), false);
    assert.equal(testUtils.getAutoRefreshIntervalMs(), 60_000); // REFRESH_MS fallback
  });
});

test('EVENTS disabled by config opens no stream and uses the legacy poll', async () => {
  await runLiveApp(
    { configOverrides: { liveUpdatesEnabled: false } },
    async ({ testUtils, FakeEventSource }) => {
      assert.equal(testUtils.isLiveActive(), false);
      assert.equal(testUtils.getAutoRefreshIntervalMs(), 60_000);
      assert.equal(FakeEventSource.instances.length, 0); // stream never created
    },
  );
});
