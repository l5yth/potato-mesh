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
 * Empty I/O counters for {@link createFakeIndexedDb}.
 *
 * @returns {{ transactions: { readonly: number, readwrite: number }, puts: number,
 *   deletes: number, putsByStore: Object<string, number>, writes: Array<Object> }}
 */
function emptyIoStats() {
  return { transactions: { readonly: 0, readwrite: 0 }, puts: 0, deletes: 0, putsByStore: {}, writes: [] };
}

/**
 * Create a fake `IDBFactory`-like object plus test controls.
 *
 * @returns {{
 *   factory: { open: Function },
 *   setFailMode: (mode: ?string) => void,
 *   setOpenMode: (mode: ?string) => void,
 *   unblock: () => void,
 *   closedCount: () => number,
 *   ioStats: () => Object,
 *   resetIoStats: () => void,
 * }} `factory` is assignable to `globalThis.indexedDB`; `setFailMode('request')`
 *   makes the next write throw (for error-path coverage). `setOpenMode` sets
 *   how later opens answer: `'blocked'` fires `onblocked` and waits until
 *   `unblock()` (another tab holding an older version closes), `'never'` never
 *   answers, `'error'` fires `onerror`, `null` (the default) opens at once.
 *   `closedCount()` counts `close()` calls on the fake databases. `ioStats()`
 *   counts the transactions by mode, the `put` and `delete` requests (puts
 *   also per store) and, per `readwrite` transaction, its stores and requests
 *   (`writes`), since the start or the last `resetIoStats()`.
 */
export function createFakeIndexedDb() {
  const databases = new Map();
  let failMode = null;
  let openMode = null;
  const blockedOpens = [];
  let closed = 0;
  let io = emptyIoStats();

  /**
   * Build a fake database backed by a map of object stores.
   *
   * @returns {object} Fake `IDBDatabase`.
   */
  function makeDb() {
    const stores = new Map();
    return {
      objectStoreNames: { contains: name => stores.has(name) },
      close() {
        closed += 1;
      },
      createObjectStore(name) {
        stores.set(name, new Map());
      },
      transaction(storeNames, mode = 'readonly') {
        // One store name or a list of them, like IDBDatabase#transaction.
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const name of names) {
          if (!stores.has(name)) {
            throw new Error(`NotFoundError: ${name}`);
          }
        }
        io.transactions[mode] = (io.transactions[mode] || 0) + 1;
        const ops = { stores: names, puts: 0, deletes: 0 };
        if (mode === 'readwrite') io.writes.push(ops);
        const queue = [];
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        const push = exec => {
          const request = { onsuccess: null, onerror: null, result: undefined, error: null };
          queue.push({ request, exec });
          return request;
        };
        tx.objectStore = (name = names[0]) => {
          if (!names.includes(name)) {
            throw new Error(`NotFoundError: ${name} is not in the transaction`);
          }
          const map = stores.get(name);
          return {
            get: key => push(() => map.get(key)),
            getAll: () => push(() => [...map.values()]),
            getAllKeys: () => push(() => [...map.keys()]),
            put: (record, key) => {
              ops.puts += 1;
              io.puts += 1;
              io.putsByStore[name] = (io.putsByStore[name] || 0) + 1;
              return push(() => {
                if (failMode === 'request') {
                  failMode = null;
                  throw new Error('put failed');
                }
                map.set(key, record);
              });
            },
            delete: key => {
              ops.deletes += 1;
              io.deletes += 1;
              return push(() => map.delete(key));
            },
            clear: () => push(() => map.clear()),
          };
        };
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
        const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
        const finish = () => {
          const fresh = !databases.has(name);
          if (fresh) databases.set(name, makeDb());
          request.result = databases.get(name);
          if (fresh && request.onupgradeneeded) request.onupgradeneeded();
          if (request.onsuccess) request.onsuccess();
        };
        if (openMode === 'never') return request;
        if (openMode === 'error') {
          setTimeout(() => {
            request.error = new Error('UnknownError: open failed');
            if (request.onerror) request.onerror();
          }, 0);
          return request;
        }
        if (openMode === 'blocked') {
          setTimeout(() => {
            if (request.onblocked) request.onblocked();
          }, 0);
          blockedOpens.push(finish);
          return request;
        }
        setTimeout(finish, 0);
        return request;
      },
    },
    setFailMode: mode => {
      failMode = mode;
    },
    setOpenMode: mode => {
      openMode = mode;
    },
    unblock: () => {
      for (const finish of blockedOpens.splice(0)) setTimeout(finish, 0);
    },
    closedCount: () => closed,
    ioStats: () => JSON.parse(JSON.stringify(io)),
    resetIoStats: () => {
      io = emptyIoStats();
    },
  };
}
