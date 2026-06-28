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
 * FC-A4 — privacy. PRIVATE mode disables and wipes the persistent cache, and the
 * "clear cached data" control empties it on demand. Drives the full caching
 * stack over an in-memory IndexedDB fake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { createIndexedDbBackend } from '../main/data-cache-idb.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);
const DB_NAME = 'potato-mesh-cache';

const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,  instancesFeatureEnabled: false,
  instanceDomain: 'demo.example',
  snapshotWindowSeconds: 3600,
});

const NODES = [{ node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' }];
const MESSAGES = [{ id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'secret', rx_time: NOW, protocol: 'meshtastic' }];
const RESPONSES = { '/api/nodes': NODES, '/api/messages': MESSAGES };

/**
 * Stub fetch recording calls.
 *
 * @returns {{ fetch: Function, calls: Array<{ url: string }> }}
 */
function buildStubFetch() {
  const calls = [];
  return {
    calls,
    fetch(url) {
      calls.push({ url });
      for (const [prefix, body] of Object.entries(RESPONSES)) {
        if (url.includes(prefix)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        }
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    },
  };
}

/**
 * Run an app instance against a shared fake IndexedDB.
 *
 * @param {object} fakeFactory Shared fake `indexedDB`.
 * @param {{ privateMode?: boolean }} opts Options.
 * @param {(ctx: { calls: Array, testUtils: object }) => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
async function runApp(fakeFactory, { privateMode = false } = {}, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  if (privateMode) {
    globalThis.document.body.dataset.privateMode = 'true';
  }
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const { fetch: stubFetch, calls } = buildStubFetch();
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = fakeFactory;
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCacheWrites();
    await _testUtils.flushBackfill();
    await fn({ calls, testUtils: _testUtils });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
}

/**
 * Read a cache collection straight from the fake, via the real adapter.
 *
 * @param {object} fakeFactory Shared fake `indexedDB`.
 * @param {string} collection Collection name.
 * @returns {Promise<Array>} Stored rows.
 */
function inspect(fakeFactory, collection) {
  const backend = createIndexedDbBackend({ indexedDB: fakeFactory, databaseName: DB_NAME });
  return backend.readAll(collection);
}

test('PRIVATE mode disables the cache and wipes prior data', async () => {
  const fake = createFakeIndexedDb();

  // A public session populates the cache.
  await runApp(fake.factory, {}, async ({ testUtils }) => {
    assert.equal(testUtils.dataCache.isDisabled(), false);
  });
  assert.ok((await inspect(fake.factory, 'nodes')).length > 0, 'public session cached nodes');
  assert.ok((await inspect(fake.factory, 'messages')).length > 0, 'public session cached messages');

  // A subsequent PRIVATE session disables the cache and wipes it.
  await runApp(fake.factory, { privateMode: true }, async ({ calls, testUtils }) => {
    assert.equal(testUtils.dataCache.isDisabled(), true, 'cache disabled in private mode');
    const nodeCalls = calls.filter(c => c.url.startsWith('/api/nodes?'));
    assert.ok(
      nodeCalls.every(c => !c.url.includes('since=')),
      'private mode does not seed → cold fetch (no since)',
    );
  });
  assert.deepEqual(await inspect(fake.factory, 'nodes'), [], 'nodes wiped in private mode');
  assert.deepEqual(await inspect(fake.factory, 'messages'), [], 'messages wiped in private mode');
});

test('the clear-cached-data control empties the cache', async () => {
  const fake = createFakeIndexedDb();
  await runApp(fake.factory, {}, async ({ testUtils }) => {
    // Populated by the initial refresh; now clear on demand.
    await testUtils.clearDataCache();
    assert.deepEqual(await testUtils.dataCache.getAll('nodes'), [], 'nodes cleared');
    assert.deepEqual(await testUtils.dataCache.getAll('messages'), [], 'messages cleared');
  });
  assert.deepEqual(await inspect(fake.factory, 'nodes'), [], 'nodes cleared in storage');
});
