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
 * SPEC CC4, CC5 (security and performance review, M20): the cache write-back
 * persists only the rows that changed since the last write, and the seed
 * evicts expired entries in one transaction. Drives `initializeApp` over a
 * fake mesh API and a fake IndexedDB that counts its transactions and
 * requests; the clock moves past the 30 s write-back throttle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDb } from './fake-indexeddb.js';
import { createFakeMeshApi, makeRows, DAY } from './fake-mesh-api.js';
import {
  CONFIG, visit, seedCache, backendOf, shiftableClock, shownCounts, storedCounts,
} from './cache-visit-harness.js';
import { createDataCache, CACHE_SCHEMA_VERSION } from '../main/data-cache.js';

const NOW = Math.floor(Date.now() / 1000);

/**
 * A fake mesh API whose collections all fit one page, so no backfill runs.
 *
 * @returns {Object} The fake API.
 */
function smallMesh() {
  const api = createFakeMeshApi();
  api.upsert('nodes', makeRows('nodes', { count: 300, newest: NOW - 100, step: 900 }));
  api.upsert('messages', makeRows('messages', { count: 600, newest: NOW - 100, step: 600 }));
  api.upsert('positions', makeRows('positions', { count: 500, newest: NOW - 100, step: 700 }));
  api.upsert('telemetry', makeRows('telemetry', { count: 400, newest: NOW - 100, step: 900 }));
  api.upsert('neighbors', makeRows('neighbors', { count: 300, newest: NOW - 100, step: 3000 }));
  api.upsert('traces', makeRows('traces', { count: 100, newest: NOW - 100, step: 9000 }));
  return api;
}

test('CC4: a write-back persists only the rows changed since the last write', async () => {
  const api = smallMesh();
  const idb = createFakeIndexedDb();
  const clock = shiftableClock();
  try {
    await visit({ fetch: api.fetch, idb }, async u => {
      assert.equal(idb.ioStats().putsByStore.nodes, 300, 'the first write-back stores every row');
      // One node is heard again; a refresh past the 30 s throttle writes back.
      idb.resetIoStats();
      clock.advance(31_000);
      const heard = { ...api.rows.nodes[5], last_heard: NOW + 20 };
      api.upsert('nodes', [heard]);
      await u.refresh();
      await u.flushCacheWrites();
      const changed = idb.ioStats();
      const dataPuts = Object.fromEntries(Object.entries(changed.putsByStore).filter(([store]) => store !== 'meta'));
      assert.deepEqual(dataPuts, { nodes: 1 }, `one changed node, one put: ${JSON.stringify(changed.putsByStore)}`);
      const stored = await backendOf(idb).read('nodes', heard.node_id);
      assert.equal(stored.value.last_heard, NOW + 20, 'the changed node is stored');
      // A refresh that changes nothing writes nothing.
      idb.resetIoStats();
      clock.advance(31_000);
      await u.refresh();
      await u.flushCacheWrites();
      const idle = idb.ioStats();
      assert.equal(idle.puts, 0, `an unchanged refresh puts nothing: ${JSON.stringify(idle.putsByStore)}`);
      assert.equal(idle.transactions.readwrite, 0, 'and opens no write transaction');
    });
  } finally {
    clock.restore();
  }
});

test('CC4: a warm load writes back only the rows its delta changed, not the seeded ones', async () => {
  const api = smallMesh();
  const idb = createFakeIndexedDb();
  await visit({ fetch: api.fetch, idb });
  const heard = { ...api.rows.nodes[7], last_heard: NOW };
  api.upsert('nodes', [heard]);
  idb.resetIoStats();
  await visit({ fetch: api.fetch, idb });
  const dataPuts = Object.fromEntries(Object.entries(idb.ioStats().putsByStore).filter(([store]) => store !== 'meta'));
  assert.deepEqual(dataPuts, { nodes: 1 }, `the warm load's write-backs: ${JSON.stringify(idb.ioStats().putsByStore)}`);
  assert.equal((await backendOf(idb).read('nodes', heard.node_id)).value.last_heard, NOW);
});

/** Every row of {@link smallMesh}, per collection. */
const SMALL_MESH = Object.freeze({ nodes: 300, messages: 600, positions: 500, telemetry: 400, neighbors: 300, traces: 100, waypoints: 0 });

/**
 * Keep one visit open while another tab changes the cache under it, then
 * let one node be heard again and the open tab write back.
 *
 * @param {(idb: Object) => Promise<void>} otherTab What the other tab does.
 * @returns {Promise<{ api: Object, idb: Object }>} The mesh and the cache.
 */
async function writeBackAfterOtherTab(otherTab) {
  const api = smallMesh();
  const idb = createFakeIndexedDb();
  const clock = shiftableClock();
  try {
    await visit({ fetch: api.fetch, idb }, async u => {
      await otherTab(idb);
      clock.advance(31_000);
      api.upsert('nodes', [{ ...api.rows.nodes[3], last_heard: NOW + 20 }]);
      await u.refresh();
      await u.flushCacheWrites();
    });
  } finally {
    clock.restore();
  }
  return { api, idb };
}

test('CC4: after another tab clears the cache, the next write-back stores every row again', async () => {
  // Tab B's clear control (FC4 iv), then tab B closes.
  const { api, idb } = await writeBackAfterOtherTab(async other => {
    await createDataCache({ backend: backendOf(other), instanceId: CONFIG.instanceDomain }).clear();
  });
  assert.deepEqual(await storedCounts(idb), SMALL_MESH, 'the write-back stored every row, not only the changed one');
  for (let load = 1; load <= 2; load += 1) {
    assert.deepEqual(await visit({ fetch: api.fetch, idb }, shownCounts), SMALL_MESH, `warm load ${load} shows every row`);
  }
});

test('CC4: after a newer tab wipes the cache (FC6), the next write-back stores every row again', async () => {
  const newer = [
    { schemaVersion: CACHE_SCHEMA_VERSION + 1, instanceId: CONFIG.instanceDomain },
    { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: 'other.example' },
  ];
  for (const marker of newer) {
    const { idb } = await writeBackAfterOtherTab(async other => {
      await createDataCache({ backend: backendOf(other), ...marker }).ready();
    });
    assert.deepEqual(await storedCounts(idb), SMALL_MESH, `after a wipe by ${JSON.stringify(marker)}`);
  }
});

test('CC5: the seed evicts 3,000 expired entries in one transaction', async () => {
  const api = createFakeMeshApi();
  const live = makeRows('positions', { count: 20, newest: NOW - 100, step: 60 });
  api.upsert('positions', live);
  const expired = makeRows('positions', { count: 3000, newest: NOW - 8 * DAY, step: 10, first: 50_000 });
  const idb = createFakeIndexedDb();
  await seedCache(idb, { rows: { positions: [...live, ...expired] } });
  idb.resetIoStats();
  await visit({ fetch: api.fetch, idb });
  const deleting = idb.ioStats().writes.filter(write => write.deletes > 0);
  assert.equal(deleting.length, 1, `write transactions that evict: ${deleting.length}`);
  assert.equal(deleting[0].deletes, 3000, 'it deletes every expired entry');
  const keys = (await backendOf(idb).readAll('positions')).map(entry => entry.key);
  assert.equal(keys.length, 20, 'only the live rows remain');
});
