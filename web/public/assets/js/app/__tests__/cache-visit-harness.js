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
 * Shared harness for the cache coverage and write-back suites: one dashboard
 * visit over a fake mesh API and a fake IndexedDB that outlives the visit, so
 * a later visit is a warm load; a cache seeded directly; the rows a visit
 * shows and the rows the cache stores; and a clock the test moves.
 *
 * @module __tests__/cache-visit-harness
 */

import { createDomEnvironment } from './dom-environment.js';
import { createIndexedDbBackend } from '../main/data-cache-idb.js';
import { CACHE_SCHEMA_VERSION } from '../main/data-cache.js';
import { cacheKeyFor } from '../main/cache-keys.js';
import { initializeApp } from '../main.js';

/** The app's IndexedDB database name. */
const DATABASE = 'potato-mesh-cache';

/** Dashboard config with a stable instance identity, no poll and no stream. */
export const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: 'coverage.example',
  snapshotWindowSeconds: 3600,
});

/** The collections a visit counts and the cache stores rows for. */
export const COUNTED = Object.freeze(['nodes', 'messages', 'positions', 'telemetry', 'neighbors', 'traces', 'waypoints']);

/**
 * Wait until a visit's initial load, both backfills and the cache writes
 * have settled.
 *
 * @param {Object} u The app's test utils.
 * @returns {Promise<void>}
 */
export async function settleVisit(u) {
  await u.initialLoad;
  await u.flushBackfill();
  await u.flushCollectionBackfills();
  await u.flushCacheWrites();
}

/**
 * Boot one dashboard over `fetch` and the fake IndexedDB, without waiting
 * for its load.
 *
 * @param {{ fetch: Function, idb?: Object }} page The fetch the page uses and
 *   the fake IndexedDB (`createFakeIndexedDb()`); without one the cache is off.
 * @returns {{ u: Object, teardown: () => void }} The app's test utils and the
 *   teardown, which stops the page and restores the globals; the fake
 *   IndexedDB keeps what the page stored.
 */
export function bootPage({ fetch, idb }) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const saved = { fetch: globalThis.fetch, idb: globalThis.indexedDB };
  globalThis.fetch = fetch;
  globalThis.indexedDB = idb ? idb.factory : undefined;
  const restore = () => {
    globalThis.fetch = saved.fetch;
    globalThis.indexedDB = saved.idb;
    env.cleanup();
  };
  let u;
  try {
    ({ _testUtils: u } = initializeApp(CONFIG));
  } catch (error) {
    restore();
    throw error;
  }
  return {
    u,
    teardown() {
      u.stopAutoRefresh();
      restore();
    },
  };
}

/**
 * Boot one dashboard ({@link bootPage}), settle it, run `body` and tear the
 * page down.
 *
 * @param {{ fetch: Function, idb?: Object }} page See {@link bootPage}.
 * @param {(u: Object) => *} [body] Runs with the settled page's test utils.
 * @returns {Promise<*>} What `body` returns.
 */
export async function visit(page, body = () => undefined) {
  const { u, teardown } = bootPage(page);
  try {
    await settleVisit(u);
    return await body(u);
  } finally {
    teardown();
  }
}

/**
 * The rows a visit shows, per counted collection.
 *
 * @param {Object} u The app's test utils.
 * @returns {Object<string, number>} Loaded row counts.
 */
export function shownCounts(u) {
  return {
    nodes: u.getLoadedNodeCount(),
    messages: u.getLoadedMessageCount(),
    positions: u.getLoadedPositionCount(),
    telemetry: u.getLoadedTelemetryCount(),
    neighbors: u.getLoadedNeighborCount(),
    traces: u.getLoadedTraceCount(),
    waypoints: u.getLoadedWaypoints().length,
  };
}

/**
 * A backend over the fake IndexedDB the app uses.
 *
 * @param {Object} idb Fake IndexedDB.
 * @returns {Object} IndexedDB cache backend.
 */
export const backendOf = idb => createIndexedDbBackend({ indexedDB: idb.factory, databaseName: DATABASE });

/**
 * The rows the cache stores, per counted collection.
 *
 * @param {Object} idb Fake IndexedDB.
 * @returns {Promise<Object<string, number>>} Stored row counts.
 */
export async function storedCounts(idb) {
  const backend = backendOf(idb);
  const counts = {};
  for (const name of COUNTED) counts[name] = (await backend.readAll(name)).length;
  return counts;
}

/** The store generation {@link seedCache} writes unless told otherwise. */
export const SEEDED_GENERATION = 'seeded-generation';

/**
 * Write a cache straight into the fake IndexedDB, as an earlier visit would
 * have left it: the schema marker of {@link CONFIG}'s instance, the store
 * generation (SPEC CC4), `rows` per collection under their cache keys, and,
 * when given, the coverage marker (SPEC CC2), stamped with `markerGeneration`.
 *
 * @param {Object} idb Fake IndexedDB.
 * @param {{ rows?: Object<string, Array<Object>>, coverage?: Object, cachedAt?: number,
 *   generation?: string, markerGeneration?: string }} contents
 *   Rows per collection, the coverage per collection, the write time (unix
 *   seconds, default now), the store's generation and the generation the
 *   marker was written under (both default {@link SEEDED_GENERATION}).
 * @returns {Promise<void>}
 */
export async function seedCache(idb, {
  rows = {}, coverage = null, cachedAt = Math.floor(Date.now() / 1000),
  generation = SEEDED_GENERATION, markerGeneration = generation,
}) {
  const backend = backendOf(idb);
  await backend.write('meta', 'meta', { schemaVersion: CACHE_SCHEMA_VERSION, instanceId: CONFIG.instanceDomain });
  await backend.write('meta', 'generation', { value: generation, cachedAt });
  for (const [name, list] of Object.entries(rows)) {
    await backend.writeMany(name, list.map(value => ({ key: cacheKeyFor(name, value), record: { value, cachedAt } })));
  }
  if (coverage) await backend.write('meta', 'coverage', { value: { ...coverage, generation: markerGeneration }, cachedAt });
}

/**
 * Move `Date.now()` forward, so a refresh's write-back is past its 30 s
 * throttle without waiting.
 *
 * @returns {{ advance: (ms: number) => void, restore: () => void }} The clock controls.
 */
export function shiftableClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow.call(Date) + offset;
  return {
    advance(ms) {
      offset += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

/**
 * The `before=` cursors of one collection's GETs, in request order.
 *
 * @param {Array<{ name: string, before: number }>} calls The fake API's calls.
 * @param {string} name Collection name.
 * @returns {Array<number>} Backward-page cursors.
 */
export const backwardCursors = (calls, name) => calls.filter(c => c.name === name && c.before > 0).map(c => c.before);
