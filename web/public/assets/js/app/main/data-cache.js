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
 * Persistent, id-keyed read-side data cache for the dashboard (SPEC FC1, FC4,
 * FC6, FC7).
 *
 * The cache stores each dashboard GET collection (nodes, messages, positions,
 * telemetry, neighbors, traces) keyed by the canonical record id so a reload or
 * revisit can paint from cache and only misses hit the API. It is intentionally
 * **backend-agnostic**: the durable store (IndexedDB in the browser) is injected
 * as a `backend`, so the cache logic — schema/identity invalidation, the PRIVATE
 * gate, graceful degradation — is fully unit-testable headlessly with an
 * in-memory backend, and a `null` backend simply yields a disabled no-op cache.
 *
 * Per-entry timestamps are recorded here (`cachedAt`); the staleness-vs-eviction
 * lifetime policy (FC3) lives in a separate helper and is applied by the refresh
 * wiring, keeping this module a dumb, durable key/value layer. Beside the schema
 * marker the `meta` store holds the coverage marker (SPEC CC2), which a wipe of
 * the collections removes with them, and the store's generation (SPEC CC4),
 * which every wipe replaces, so another tab can tell the store was emptied
 * under it.
 *
 * @module main/data-cache
 */

/**
 * Cache schema version. Bumping it (or changing the instance identity) discards
 * the persisted cache on open so a data-shape change can never serve mis-shaped
 * entries (FC6).
 *
 * @type {number}
 */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * The dashboard GET collections that are cached, each keyed by canonical id
 * (neighbors by their composite `(node_id, neighbor_id)` key — the caller
 * supplies the composite string).
 *
 * @type {ReadonlyArray<string>}
 */
export const CACHE_COLLECTIONS = Object.freeze([
  'nodes',
  'messages',
  'encrypted',
  'positions',
  'telemetry',
  'neighbors',
  'traces',
  'waypoints',
]);

/** Backend store name holding the schema/identity marker. */
const META_STORE = 'meta';
/** Key under which the marker record is written in {@link META_STORE}. */
const META_KEY = 'meta';
/**
 * Key of the coverage marker in {@link META_STORE}: per collection, the window
 * its cached rows hold without a gap (SPEC CC2, `main/cache-coverage.js`).
 */
const COVERAGE_KEY = 'coverage';
/**
 * Key of the store's generation in {@link META_STORE}: a token every wipe of
 * the collections replaces (SPEC CC4).
 */
const GENERATION_KEY = 'generation';

/**
 * A new store generation: unique enough to tell two wipes apart; not a secret.
 *
 * @returns {string} The token.
 */
function newStoreGeneration() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create an in-memory cache backend implementing the backend interface used by
 * {@link createDataCache}. Used by unit tests and as an explicit non-durable
 * option; production injects an IndexedDB-backed adapter instead.
 *
 * The backend interface is a small async keyed store, namespaced by `store`:
 * `read(store, key)`, `readAll(store)`, `write(store, key, record)`,
 * `writeMany(store, items)`, `remove(store, key)`, `removeMany(items)` (keys
 * of several stores at once; one transaction in IndexedDB, SPEC CC5),
 * `clearStore(store)`.
 *
 * @returns {{
 *   read: (store: string, key: string) => Promise<*>,
 *   readAll: (store: string) => Promise<Array<{ key: string, record: * }>>,
 *   write: (store: string, key: string, record: *) => Promise<void>,
 *   writeMany: (store: string, items: Array<{ key: string, record: * }>) => Promise<void>,
 *   remove: (store: string, key: string) => Promise<void>,
 *   removeMany: (items: Array<{ store: string, key: string }>) => Promise<void>,
 *   clearStore: (store: string) => Promise<void>
 * }} In-memory backend.
 */
export function createMemoryBackend() {
  /** @type {Map<string, Map<string, *>>} */
  const stores = new Map();

  /**
   * Resolve (creating if needed) the map for a backend store.
   *
   * @param {string} store Store name.
   * @returns {Map<string, *>} Store map.
   */
  function storeMap(store) {
    let map = stores.get(store);
    if (!map) {
      map = new Map();
      stores.set(store, map);
    }
    return map;
  }

  return {
    async read(store, key) {
      return storeMap(store).get(key);
    },
    async readAll(store) {
      return [...storeMap(store).entries()].map(([key, record]) => ({ key, record }));
    },
    async write(store, key, record) {
      storeMap(store).set(key, record);
    },
    async writeMany(store, items) {
      const map = storeMap(store);
      for (const item of items) {
        map.set(item.key, item.record);
      }
    },
    async remove(store, key) {
      storeMap(store).delete(key);
    },
    async removeMany(items) {
      for (const item of items) storeMap(item.store).delete(item.key);
    },
    async clearStore(store) {
      storeMap(store).clear();
    },
  };
}

/**
 * Create the data cache over an injected backend.
 *
 * On first use the cache opens the backend and validates the persisted
 * schema/identity marker: a mismatch (or PRIVATE mode) discards all cached data.
 * In PRIVATE mode the cache also disables itself so no read or write touches
 * storage (FC4). Every operation is wrapped so a missing/throwing backend
 * degrades silently to a no-op and the caller falls back to network-only
 * behavior (FC7) — the cache is never load-bearing.
 *
 * @param {{
 *   backend?: object|null,
 *   schemaVersion?: number,
 *   instanceId?: string,
 *   isPrivate?: boolean,
 *   now?: () => number,
 *   newGeneration?: () => string
 * }} [options] Configuration. `backend` is the durable store (omit/`null` for a
 *   disabled cache); `instanceId` scopes the cache to one instance (e.g. the
 *   instance domain); `isPrivate` disables+wipes the cache; `now` supplies the
 *   write clock in **unix seconds** (matching the API's record timestamps so the
 *   lifetime helper can compare them; injectable for tests); `newGeneration`
 *   mints a store generation (injectable for tests).
 * @returns {{
 *   ready: () => Promise<void>,
 *   isDisabled: () => boolean,
 *   get: (collection: string, key: string) => Promise<{ value: *, cachedAt: number }|undefined>,
 *   getAll: (collection: string) => Promise<Array<{ key: string, value: *, cachedAt: number }>>,
 *   put: (collection: string, key: string, value: *) => Promise<void>,
 *   putAll: (collection: string, entries: Array<{ key: string, value: * }>) => Promise<boolean>,
 *   delete: (collection: string, key: string) => Promise<void>,
 *   deleteMany: (entries: Array<{ collection: string, key: string }>) => Promise<void>,
 *   getCoverage: () => Promise<*>,
 *   putCoverage: (marker: Object) => Promise<boolean>,
 *   getGeneration: () => Promise<?string>,
 *   clearCollection: (collection: string) => Promise<void>,
 *   clear: () => Promise<void>
 * }} Cache API. `putAll` and `putCoverage` resolve `true` once stored and
 *   `false` when the cache is disabled or the write failed (FC7).
 *   `getGeneration` resolves the store's generation, minting one when the
 *   store has none, or `null` when the cache is disabled or the store fails.
 */
export function createDataCache({
  backend = null,
  schemaVersion = CACHE_SCHEMA_VERSION,
  instanceId = '',
  isPrivate = false,
  now = () => Math.floor(Date.now() / 1000),
  newGeneration = newStoreGeneration,
} = {}) {
  let disabled = false;
  /** @type {Promise<void>|null} */
  let readyPromise = null;

  /**
   * Remove every cached data collection and the coverage marker that
   * describes them (SPEC CC2), then give the store a new generation (SPEC
   * CC4): a tab that wrote rows before can tell they are gone. The schema
   * marker is managed separately so a post-clear cache can still write
   * without re-invalidating.
   *
   * @returns {Promise<void>} Resolves once all collections are cleared.
   */
  async function clearCollections() {
    for (const collection of CACHE_COLLECTIONS) {
      await backend.clearStore(collection);
    }
    await backend.remove(META_STORE, COVERAGE_KEY);
    await backend.write(META_STORE, GENERATION_KEY, { value: newGeneration(), cachedAt: now() });
  }

  /**
   * Open the backend and reconcile the schema/identity marker, disabling the
   * cache on PRIVATE mode, a missing backend, or any backend error.
   *
   * @returns {Promise<void>} Resolves once the cache is ready (or disabled).
   */
  async function init() {
    if (!backend) {
      disabled = true;
      return;
    }
    try {
      if (isPrivate) {
        // Privacy gate (FC4): never persist in private mode, and wipe anything a
        // prior public session left behind.
        await clearCollections();
        await backend.clearStore(META_STORE);
        disabled = true;
        return;
      }
      const marker = await backend.read(META_STORE, META_KEY);
      if (!marker || marker.schemaVersion !== schemaVersion || marker.instanceId !== instanceId) {
        // Stale schema or a different instance — discard rather than serve
        // mis-shaped or cross-instance data (FC6).
        await clearCollections();
        await backend.write(META_STORE, META_KEY, { schemaVersion, instanceId });
      }
    } catch (error) {
      disabled = true;
    }
  }

  /**
   * Lazily run (and memoise) initialisation.
   *
   * @returns {Promise<void>} Resolves once initialised.
   */
  function ready() {
    if (!readyPromise) {
      readyPromise = init();
    }
    return readyPromise;
  }

  return {
    ready,
    isDisabled: () => disabled,

    async get(collection, key) {
      await ready();
      if (disabled) return undefined;
      try {
        const record = await backend.read(collection, key);
        return record ? { value: record.value, cachedAt: record.cachedAt } : undefined;
      } catch (error) {
        return undefined;
      }
    },

    async getAll(collection) {
      await ready();
      if (disabled) return [];
      try {
        const rows = await backend.readAll(collection);
        return rows.map(({ key, record }) => ({
          key,
          value: record.value,
          cachedAt: record.cachedAt,
        }));
      } catch (error) {
        return [];
      }
    },

    async put(collection, key, value) {
      await ready();
      if (disabled) return;
      try {
        await backend.write(collection, key, { value, cachedAt: now() });
      } catch (error) {
        /* best-effort cache: a failed write is a silent no-op (FC7). */
      }
    },

    async putAll(collection, entries) {
      await ready();
      if (disabled) return false;
      if (!Array.isArray(entries) || entries.length === 0) return true;
      try {
        const cachedAt = now();
        await backend.writeMany(
          collection,
          entries.map(({ key, value }) => ({ key, record: { value, cachedAt } })),
        );
        return true;
      } catch (error) {
        /* silent no-op (FC7); the caller keeps the rows as unwritten. */
        return false;
      }
    },

    async delete(collection, key) {
      await ready();
      if (disabled) return;
      try {
        await backend.remove(collection, key);
      } catch (error) {
        /* silent no-op (FC7). */
      }
    },

    async deleteMany(entries) {
      await ready();
      if (disabled || !Array.isArray(entries) || entries.length === 0) return;
      try {
        // One backend call, so the seed's eviction is one transaction (SPEC CC5).
        await backend.removeMany(entries.map(({ collection, key }) => ({ store: collection, key })));
      } catch (error) {
        /* silent no-op (FC7): the entries stay expired and the next seed retries. */
      }
    },

    async getCoverage() {
      await ready();
      if (disabled) return null;
      try {
        const record = await backend.read(META_STORE, COVERAGE_KEY);
        return record && typeof record === 'object' && 'value' in record ? record.value : null;
      } catch (error) {
        return null;
      }
    },

    async putCoverage(marker) {
      await ready();
      if (disabled) return false;
      try {
        await backend.write(META_STORE, COVERAGE_KEY, { value: marker, cachedAt: now() });
        return true;
      } catch (error) {
        /* silent no-op (FC7). */
        return false;
      }
    },

    async getGeneration() {
      await ready();
      if (disabled) return null;
      try {
        const record = await backend.read(META_STORE, GENERATION_KEY);
        if (record && typeof record === 'object' && typeof record.value === 'string') return record.value;
        // A store written before generations existed gets one now.
        const value = newGeneration();
        await backend.write(META_STORE, GENERATION_KEY, { value, cachedAt: now() });
        return value;
      } catch (error) {
        return null;
      }
    },

    async clearCollection(collection) {
      await ready();
      if (disabled) return;
      try {
        await backend.clearStore(collection);
      } catch (error) {
        /* silent no-op (FC7). */
      }
    },

    async clear() {
      await ready();
      if (disabled) return;
      try {
        await clearCollections();
      } catch (error) {
        /* silent no-op (FC7). */
      }
    },
  };
}
