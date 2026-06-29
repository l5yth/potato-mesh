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
 * Cold-load boot prefetch consumption + warm-marker lifecycle. The early boot
 * module stashes in-flight `Response` promises on `window.__PM_BOOT__`; the app
 * must consume them on its first cold refresh (no duplicate network fetch) and
 * maintain the `localStorage` warm-marker so a revisit skips the prefetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { initializeApp } from '../main.js';
import { BOOT_CACHE_FLAG } from '../main/constants.js';

const NOW = Math.floor(Date.now() / 1000);

const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: 'demo.example',
  snapshotWindowSeconds: 3600,
});

const BOOT_NODES = [{ node_id: '!boot', short_name: 'B', long_name: 'Boot Node', last_heard: NOW, protocol: 'meshtastic' }];
const BOOT_MESSAGES = [{ id: 11, channel: 0, from_id: '!boot', to_id: '^all', text: 'from boot', rx_time: NOW, protocol: 'meshtastic' }];

/** A resolved Response-like promise carrying ``body`` as JSON. */
function bootResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Minimal synchronous localStorage stub. */
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    has: key => map.has(key),
  };
}

/** Recording stub fetch answering [] for everything (records URLs). */
function buildStubFetch() {
  const calls = [];
  return {
    calls,
    fetch(url) {
      calls.push({ url });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    },
  };
}

test('cold load consumes window.__PM_BOOT__ without issuing duplicate fetches', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const storage = fakeLocalStorage();
  globalThis.window.localStorage = storage;
  // Simulate the boot module having prefetched the cold-load responses.
  globalThis.window.__PM_BOOT__ = {
    nodes: bootResponse(BOOT_NODES),
    positions: bootResponse([]),
    telemetry: bootResponse([]),
    neighbors: bootResponse([]),
    traces: bootResponse([]),
    messages: bootResponse(BOOT_MESSAGES),
    encryptedMessages: bootResponse([]),
  };
  const { fetch: stubFetch, calls } = buildStubFetch();
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = createFakeIndexedDb().factory;
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCacheWrites();
    await _testUtils.flushBackfill();
    await new Promise(resolve => setTimeout(resolve, 10)); // drain background stats/render

    // The prefetched responses were consumed: no cold (no-`since`) request was
    // issued for the boot-covered collections.
    const coldNodeFetches = calls.filter(c => c.url.startsWith('/api/nodes?') && !c.url.includes('since='));
    const coldMsgFetches = calls.filter(c => c.url.startsWith('/api/messages?') && !c.url.includes('since=') && !c.url.includes('before='));
    assert.equal(coldNodeFetches.length, 0, `boot nodes must be consumed, not re-fetched: ${coldNodeFetches.map(c => c.url).join(', ')}`);
    assert.equal(coldMsgFetches.length, 0, `boot messages must be consumed, not re-fetched: ${coldMsgFetches.map(c => c.url).join(', ')}`);
    assert.ok(_testUtils.getLoadedMessageCount() > 0, 'the boot message reached the loaded set');
    // One-shot: the global is cleared so reconnect resyncs fetch normally.
    assert.equal(globalThis.window.__PM_BOOT__, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    delete globalThis.window.__PM_BOOT__;
    env.cleanup();
  }
});

test('a successful cold load sets the warm-marker; clearing the cache removes it', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const storage = fakeLocalStorage();
  globalThis.window.localStorage = storage;
  // No __PM_BOOT__: the app fetches normally; we only assert the marker lifecycle.
  const stub = {
    fetch(url) {
      const body = url.startsWith('/api/nodes?') ? BOOT_NODES : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
  };
  globalThis.fetch = stub.fetch;
  globalThis.indexedDB = createFakeIndexedDb().factory;
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCacheWrites();
    await _testUtils.flushBackfill();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(storage.getItem(BOOT_CACHE_FLAG), '1', 'a populated, enabled cache sets the warm-marker');

    await _testUtils.clearDataCache();
    assert.equal(storage.has(BOOT_CACHE_FLAG), false, 'clearing the cache re-enables the cold prefetch');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
});

test('a disabled cache (no IndexedDB) clears any stale warm-marker', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const storage = fakeLocalStorage();
  storage.setItem(BOOT_CACHE_FLAG, '1'); // stale marker from a prior session
  globalThis.window.localStorage = storage;
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  globalThis.indexedDB = undefined; // disables the cache
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCacheWrites();
    await _testUtils.flushBackfill();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(_testUtils.dataCache.isDisabled(), true);
    assert.equal(storage.has(BOOT_CACHE_FLAG), false, 'a disabled cache clears the stale marker so the next load prefetches');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
});
