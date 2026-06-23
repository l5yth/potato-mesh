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
 * A minimal asynchronous in-memory IndexedDB fake — just enough of `open`,
 * transactions, and object-store requests to exercise the cache's IndexedDB
 * adapter and end-to-end caching wiring in Node unit tests. Databases persist
 * per name across `open` calls so reload/revisit behavior can be tested.
 *
 * @module __tests__/fake-indexeddb
 */

/**
 * Create a fake `IDBFactory`-like object plus test controls.
 *
 * @returns {{ factory: { open: Function }, setFailMode: (mode: ?string) => void }}
 *   `factory` is assignable to `globalThis.indexedDB`; `setFailMode('request')`
 *   makes the next write throw (for error-path coverage).
 */
export function createFakeIndexedDb() {
  const databases = new Map();
  let failMode = null;

  /**
   * Build a fake database backed by a map of object stores.
   *
   * @returns {object} Fake `IDBDatabase`.
   */
  function makeDb() {
    const stores = new Map();
    return {
      objectStoreNames: { contains: name => stores.has(name) },
      createObjectStore(name) {
        stores.set(name, new Map());
      },
      transaction(storeName) {
        if (!stores.has(storeName)) {
          throw new Error(`NotFoundError: ${storeName}`);
        }
        const queue = [];
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        const map = stores.get(storeName);
        const push = exec => {
          const request = { onsuccess: null, onerror: null, result: undefined, error: null };
          queue.push({ request, exec });
          return request;
        };
        tx.objectStore = () => ({
          get: key => push(() => map.get(key)),
          getAll: () => push(() => [...map.values()]),
          getAllKeys: () => push(() => [...map.keys()]),
          put: (record, key) =>
            push(() => {
              if (failMode === 'request') {
                failMode = null;
                throw new Error('put failed');
              }
              map.set(key, record);
            }),
          delete: key => push(() => map.delete(key)),
          clear: () => push(() => map.clear()),
        });
        setTimeout(() => {
          for (const { request, exec } of queue) {
            try {
              request.result = exec();
              if (request.onsuccess) request.onsuccess();
            } catch (error) {
              request.error = error;
              if (request.onerror) request.onerror();
              tx.error = error;
              if (tx.onerror) tx.onerror();
              return;
            }
          }
          setTimeout(() => {
            if (tx.oncomplete) tx.oncomplete();
          }, 0);
        }, 0);
        return tx;
      },
    };
  }

  return {
    factory: {
      open(name) {
        const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
        setTimeout(() => {
          const fresh = !databases.has(name);
          if (fresh) databases.set(name, makeDb());
          request.result = databases.get(name);
          if (fresh && request.onupgradeneeded) request.onupgradeneeded();
          if (request.onsuccess) request.onsuccess();
        }, 0);
        return request;
      },
    },
    setFailMode: mode => {
      failMode = mode;
    },
  };
}
