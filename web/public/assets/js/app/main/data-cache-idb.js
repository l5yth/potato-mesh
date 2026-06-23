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
 * IndexedDB backend adapter for {@link module:main/data-cache} (SPEC FC1).
 *
 * Maps the cache's small async key/value backend interface
 * (`read`/`readAll`/`write`/`writeMany`/`remove`/`clearStore`) onto IndexedDB
 * object stores — one per cached collection plus a `meta` marker store. The
 * database is opened lazily and the handle is memoised. When IndexedDB is
 * unavailable (e.g. the Node test runner, or a privacy-hardened browser) the
 * factory returns `null` so {@link module:main/data-cache} runs disabled and the
 * app falls back to network-only behavior (FC7).
 *
 * @module main/data-cache-idb
 */

import { CACHE_COLLECTIONS } from './data-cache.js';

/** Marker store name (kept in sync with `data-cache.js`). */
const META_STORE = 'meta';
/** Every object store the database holds. */
const ALL_STORES = Object.freeze([...CACHE_COLLECTIONS, META_STORE]);
/** Default IndexedDB database name. */
const DEFAULT_DB_NAME = 'potato-mesh-cache';
/** Structural IndexedDB version (data invalidation is handled by the cache's marker). */
const DB_VERSION = 1;

/**
 * Wrap an IndexedDB request in a promise.
 *
 * @param {IDBRequest} request IndexedDB request.
 * @returns {Promise<*>} Resolves with the request result or rejects on error.
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Create an IndexedDB-backed cache backend, or `null` when IndexedDB is
 * unavailable.
 *
 * @param {{ indexedDB?: IDBFactory, databaseName?: string }} [options] Optional
 *   `indexedDB` factory (defaults to the ambient global; injectable for tests)
 *   and database name.
 * @returns {object|null} Backend implementing the cache backend interface, or
 *   `null` when IndexedDB is not available.
 */
export function createIndexedDbBackend({
  indexedDB = typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined,
  databaseName = DEFAULT_DB_NAME,
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    return null;
  }

  /** @type {Promise<IDBDatabase>|null} */
  let dbPromise = null;

  /**
   * Open (and memoise) the database, creating object stores on first use.
   *
   * @returns {Promise<IDBDatabase>} The open database handle.
   */
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of ALL_STORES) {
            if (!db.objectStoreNames.contains(store)) {
              db.createObjectStore(store);
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      });
    }
    return dbPromise;
  }

  /**
   * Run a transaction against one store and resolve with the callback's result
   * once the transaction commits.
   *
   * @param {string} store Object store name.
   * @param {IDBTransactionMode} mode Transaction mode.
   * @param {(store: IDBObjectStore) => Promise<*>} run Issues requests against the store.
   * @returns {Promise<*>} The callback's resolved value after commit.
   */
  async function withStore(store, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      const transaction = db.transaction(store, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      Promise.resolve(run(transaction.objectStore(store)))
        .then(value => {
          result = value;
        })
        .catch(reject);
    });
  }

  return {
    async read(store, key) {
      return withStore(store, 'readonly', objectStore => promisifyRequest(objectStore.get(key)));
    },
    async readAll(store) {
      return withStore(store, 'readonly', objectStore => {
        // Issue both requests synchronously (before awaiting) so the read-only
        // transaction stays active until they resolve.
        const valuesRequest = objectStore.getAll();
        const keysRequest = objectStore.getAllKeys();
        return Promise.all([promisifyRequest(valuesRequest), promisifyRequest(keysRequest)]).then(
          ([values, keys]) => keys.map((key, index) => ({ key, record: values[index] })),
        );
      });
    },
    async write(store, key, record) {
      return withStore(store, 'readwrite', objectStore => promisifyRequest(objectStore.put(record, key)));
    },
    async writeMany(store, items) {
      return withStore(store, 'readwrite', objectStore =>
        Promise.all(items.map(item => promisifyRequest(objectStore.put(item.record, item.key)))),
      );
    },
    async remove(store, key) {
      return withStore(store, 'readwrite', objectStore => promisifyRequest(objectStore.delete(key)));
    },
    async clearStore(store) {
      return withStore(store, 'readwrite', objectStore => promisifyRequest(objectStore.clear()));
    },
  };
}
