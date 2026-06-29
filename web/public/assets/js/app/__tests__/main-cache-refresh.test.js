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
 * FC-A2 — seed-from-cache + fetch-only-the-delta. Drives the full caching stack
 * (IndexedDB adapter + cache + main.js wiring) over an in-memory IndexedDB fake.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { createIndexedDbBackend } from '../main/data-cache-idb.js';
import { CACHE_SCHEMA_VERSION } from '../main/data-cache.js';
import { initializeApp } from '../main.js';

const DAY = 24 * 60 * 60;

const NOW = Math.floor(Date.now() / 1000);

/** App config with a stable instance identity so the cache persists across runs. */
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

const NODES = [
  { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' },
];
const MESSAGES = [
  { id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'hello', rx_time: NOW, protocol: 'meshtastic' },
];

/**
 * Build a recording stub fetch answering from a URL-substring map.
 *
 * @param {Object<string, *>} responses URL-substring → JSON body.
 * @returns {{ fetch: Function, calls: Array<{ url: string }> }}
 */
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

/**
 * Run one app instance with a shared fake IndexedDB, returning its recorded
 * fetch calls and test utils. The DOM is torn down afterward but the fake
 * IndexedDB (passed in) persists so a later run can read what this one wrote.
 *
 * @param {object} fakeFactory Shared fake `indexedDB` factory.
 * @param {Object<string, *>} responses Stub fetch responses.
 * @param {(ctx: { calls: Array, testUtils: object }) => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
async function runApp(fakeFactory, responses, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const { fetch: stubFetch, calls } = buildStubFetch(responses);
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

test('cold start fetches the full window; warm start seeds and fetches only the delta', async () => {
  const fake = createFakeIndexedDb();
  const responses = { '/api/nodes': NODES, '/api/messages': MESSAGES };

  // --- Cold start: empty cache → full fetch (no `since`), then write-back. ---
  await runApp(fake.factory, responses, async ({ calls, testUtils }) => {
    const nodeCalls = calls.filter(c => c.url.startsWith('/api/nodes?'));
    assert.ok(nodeCalls.length > 0, 'cold start should fetch nodes');
    assert.ok(
      nodeCalls.every(c => !c.url.includes('since=')),
      `cold start must not pass since: ${nodeCalls.map(c => c.url).join(', ')}`,
    );
    assert.ok(testUtils.getLoadedMessageCount() > 0, 'cold start loaded messages');
  });

  // --- Warm start: same fake IndexedDB + same instance → seed + delta fetch. ---
  await runApp(fake.factory, responses, async ({ calls, testUtils }) => {
    assert.equal(testUtils.dataCache.isDisabled(), false, 'cache is enabled with a backend');
    assert.ok(testUtils.getLoadedMessageCount() > 0, 'warm start seeded messages from cache');
    const nodeCalls = calls.filter(c => c.url.startsWith('/api/nodes?'));
    assert.ok(nodeCalls.length > 0, 'warm start still refreshes');
    assert.ok(
      nodeCalls.some(c => c.url.includes('since=')),
      `warm start must fetch only the delta (since=): ${nodeCalls.map(c => c.url).join(', ')}`,
    );
  });
});

test('eviction on seed: rows past their window are dropped and deleted (FC-A3)', async () => {
  const fake = createFakeIndexedDb();
  // Pre-seed the store directly: a matching marker (so the app does not wipe),
  // one fresh node and one node whose last_heard is 8 days old (past the 7-day
  // node eviction window).
  const seed = createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' });
  await seed.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: CONFIG.instanceDomain });
  await seed.write('nodes', '!fresh', { value: { node_id: '!fresh', last_heard: NOW }, cachedAt: NOW });
  await seed.write('nodes', '!old', { value: { node_id: '!old', last_heard: NOW - 8 * DAY }, cachedAt: NOW });

  await runApp(fake.factory, { '/api/nodes': [{ node_id: '!fresh', last_heard: NOW }] }, async () => {});

  const stored = await createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' }).readAll('nodes');
  const keys = stored.map(entry => entry.key);
  assert.ok(!keys.includes('!old'), 'the 8-day-old node is evicted from the cache');
  assert.ok(keys.includes('!fresh'), 'the fresh node is retained');
});

test('a stale node cache (>24h) triggers a full node refresh, not a delta (FC3)', async () => {
  const fake = createFakeIndexedDb();
  // Pre-seed a node that is still within the 7-day window (not evicted) but whose
  // cached copy is 25h old (past the 24h node staleness window).
  const seed = createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' });
  await seed.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: CONFIG.instanceDomain });
  await seed.write('nodes', '!n', { value: { node_id: '!n', last_heard: NOW }, cachedAt: NOW - DAY - 3600 });

  await runApp(fake.factory, { '/api/nodes': [{ node_id: '!n', last_heard: NOW }] }, async ({ calls }) => {
    const nodeCalls = calls.filter(c => c.url.startsWith('/api/nodes?'));
    assert.ok(nodeCalls.length > 0, 'still refreshes nodes');
    assert.ok(
      nodeCalls.every(c => !c.url.includes('since=')),
      `a stale node cache should full-refresh (no since): ${nodeCalls.map(c => c.url).join(', ')}`,
    );
  });
});

test('a disabled cache (no IndexedDB) leaves the app on the cold network path', async () => {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalIdb = globalThis.indexedDB;
  const { fetch: stubFetch, calls } = buildStubFetch({ '/api/nodes': NODES, '/api/messages': MESSAGES });
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = undefined; // no storage → cache disabled
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushBackfill();
    assert.equal(_testUtils.dataCache.isDisabled(), true);
    const nodeCalls = calls.filter(c => c.url.startsWith('/api/nodes?'));
    assert.ok(nodeCalls.every(c => !c.url.includes('since=')), 'disabled cache → cold fetch, no since');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
});

test('warm cache + capped since-page bridges the orphaned middle gap', async () => {
  // Regression (production: #ping Jun27 08:00 → Jun28 00:00 missing on revisit).
  // A returning visitor's cache holds an older contiguous block; the delta
  // `since`-fetch is capped at MESSAGE_LIMIT and returns only the NEWEST page
  // (DESC+LIMIT), which need not reach the cache — leaving an orphaned middle
  // gap [cache_newest .. livepage_oldest]. The background backfill must bridge
  // that gap (anchor at the live frontier), not page below the global-oldest
  // cached row.
  const fake = createFakeIndexedDb();
  const seed = createIndexedDbBackend({ indexedDB: fake.factory, databaseName: 'potato-mesh-cache' });
  await seed.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: CONFIG.instanceDomain });
  const msg = (id, t, text) => ({ id, channel: 0, from_id: '!a', to_id: '^all', text, rx_time: t, protocol: 'meshcore' });
  // Cached: an older contiguous pair, within the 7-day retention so it seeds.
  await seed.write('messages', 'c1', { value: msg('c1', NOW - 2 * DAY - 60, 'old1'), cachedAt: NOW });
  await seed.write('messages', 'c2', { value: msg('c2', NOW - 2 * DAY, 'old2'), cachedAt: NOW });

  // Server: the newest page (since-fetch) is [L1@NOW-1h, L2@NOW] and does NOT
  // reach the cache; the gap row G@NOW-1d is reachable only via `before=` paging.
  const L1 = msg('L1', NOW - 3600, 'live1');
  const L2 = msg('L2', NOW, 'live2');
  const G = msg('G', NOW - DAY, 'gap');
  const history = [L2, L1, G, msg('c2', NOW - 2 * DAY, 'old2'), msg('c1', NOW - 2 * DAY - 60, 'old1')];
  const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const stubFetch = url => {
    if (url.includes('/api/messages')) {
      const q = url.split('?')[1] || '';
      if (/encrypted=true/.test(q)) return ok([]);
      const before = Number((q.match(/before=(\d+)/) || [])[1] || 0);
      if (before > 0) {
        return ok(history.filter(m => m.rx_time <= before).sort((a, b) => b.rx_time - a.rx_time).slice(0, 1000));
      }
      return ok([L2, L1]); // since/default: newest page only (cap doesn't reach the cache)
    }
    return ok([]);
  };

  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const of = globalThis.fetch;
  const oi = globalThis.indexedDB;
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = fake.factory;
  try {
    const { _testUtils } = initializeApp(CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushBackfill();
    await _testUtils.flushCacheWrites();
    // After bridging, every distinct message is loaded: cache c1,c2 + live L1,L2
    // + the gap row G = 5. Pre-fix the backfill pages below the cached oldest and
    // never fetches G, so only 4 load.
    assert.equal(
      _testUtils.getLoadedMessageCount(), 5,
      `the orphaned middle gap (G@NOW-1d) must be backfilled; loaded=${_testUtils.getLoadedMessageCount()}`,
    );
  } finally {
    globalThis.fetch = of;
    globalThis.indexedDB = oi;
    env.cleanup();
  }
});
