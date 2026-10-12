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
 * The cache write-back: persist the rows that changed since the last write,
 * then the coverage marker (SPEC CC4, CC2).
 *
 * The dashboard holds every collection in memory and used to rewrite all of
 * it on each write-back: on a busy instance 16,160 rows, each one cloned on
 * the main thread and appended to IndexedDB's log, for a handful of changed
 * rows (review item M20). The writer remembers, per collection, the row it
 * last wrote under each key and puts only the rows that are new or differ.
 * A row kept by the merges is the same object and costs one identity check,
 * as in the repaint planner (SPEC DR4); a row that arrived again is compared
 * field by field with `recordsEqual`. The coverage marker is stored after the
 * rows, and only when every row write succeeded, so it never vouches for rows
 * the cache does not hold. Another tab can empty the store meanwhile (its
 * clear control, or a schema or instance wipe, FC4, FC6): every wipe gives the
 * store a new generation, and a run that finds a generation other than the
 * one it wrote under forgets what it wrote and stores every row again, as a
 * full write-back did (SPEC CC4). The marker carries the generation it was
 * written under, so the seed ignores a marker that predates a wipe. Runs are
 * serialised: each one compares against the state the previous one left.
 *
 * @module main/cache-write-back
 */

import { recordsEqual } from './repaint-planner.js';

/**
 * Create the writer.
 *
 * @param {{
 *   cache: { ready: () => Promise<void>, isDisabled: () => boolean,
 *     putAll: (collection: string, entries: Array<{ key: string, value: * }>) => Promise<boolean>,
 *     putCoverage: (marker: Object) => Promise<boolean>,
 *     getGeneration: () => Promise<?string> },
 *   collections: () => Object<string, Array<Object>>,
 *   keyOf: (collection: string, row: Object) => ?string,
 *   storedValue?: (collection: string, row: Object) => *,
 *   coverage?: () => ?Object,
 * }} deps `cache` is the data cache (`main/data-cache.js`); `collections`
 *   returns the rows to persist, per collection; `keyOf` gives a row's cache
 *   key (`main/cache-keys.js`); `storedValue` gives the value stored for a row
 *   (default the row itself); `coverage` returns the coverage marker to store
 *   with the rows (`main/cache-coverage.js`), or null for none; it is stored
 *   with a `generation` field, the store generation it was written under.
 * @returns {{
 *   write: () => Promise<Object>,
 *   seeded: (rowsByCollection: Object<string, Array<Object>>, marker: *, generation: ?string) => void,
 *   clear: (wipe: () => Promise<void>) => Promise<void>,
 * }}
 *   `write` queues one write-back and resolves with what it stored:
 *   `{ puts: Object<string, number>, coverage: boolean }`, puts per
 *   collection (empty when the cache is disabled or the run threw: the cache
 *   is best-effort, FC7, and a write-back never rejects). `seeded` takes the
 *   rows, the marker and the store generation the cache seed read as
 *   written, so a warm load's first write-back stores only what changed
 *   since; after a write-back was queued it does nothing. `clear` queues `wipe`
 *   (emptying the cache) and forgets what was written, so the next write
 *   stores every row again.
 */
export function createCacheWriteBack({ cache, collections, keyOf, storedValue = (collection, row) => row, coverage = () => null }) {
  /** @type {Map<string, Map<string, Object>>} Per collection, the row last written under each key. */
  let written = new Map();
  /** The coverage marker last stored. */
  let writtenCoverage = null;
  /** The store generation `written` was stored under; undefined until known. */
  let knownGeneration;
  /** The queue that serialises the runs. */
  let queue = Promise.resolve();
  /** Whether a write-back has been queued; the seed's baseline applies only before. */
  let queuedAny = false;

  /**
   * The rows of one collection that differ from the last write, and the rows
   * to remember once they are stored.
   *
   * @param {string} name Collection name.
   * @param {Array<Object>} rows Current rows.
   * @returns {{ next: Map<string, Object>, changed: Array<{ key: string, value: * }> }}
   */
  function diff(name, rows) {
    const previous = written.get(name) || new Map();
    const next = new Map();
    const changed = [];
    for (const row of rows) {
      const key = keyOf(name, row);
      if (key == null) continue;
      next.set(key, row);
      const old = previous.get(key);
      if (old === row) continue;
      const value = storedValue(name, row);
      if (old !== undefined && recordsEqual(storedValue(name, old), value)) continue;
      changed.push({ key, value });
    }
    return { next, changed };
  }

  /**
   * One write-back: check the store generation, diff every collection, put
   * the changed rows, then store the coverage marker when it changed and
   * every put succeeded.
   *
   * @returns {Promise<{ puts: Object<string, number>, coverage: boolean }>} What it stored.
   */
  async function run() {
    const result = { puts: {}, coverage: false };
    await cache.ready();
    if (cache.isDisabled()) return result;
    // SPEC CC4: a new generation means the store was emptied under this tab;
    // nothing written before is there any more, so every row is written.
    const generation = await cache.getGeneration();
    if (generation !== knownGeneration) {
      written = new Map();
      writtenCoverage = null;
      knownGeneration = generation;
    }
    // Rows and coverage are taken in one task, so the marker describes
    // exactly the rows this run stores.
    const entries = coverage();
    const marker = entries ? { ...entries, generation } : null;
    const plans = Object.entries(collections()).map(([name, rows]) => ({
      name,
      ...diff(name, Array.isArray(rows) ? rows : []),
    }));
    const stored = await Promise.all(
      plans.map(plan => (plan.changed.length > 0 ? cache.putAll(plan.name, plan.changed) : true)),
    );
    let allStored = true;
    plans.forEach((plan, index) => {
      if (stored[index]) {
        // Remember the rows held now; rows gone from memory are forgotten.
        written.set(plan.name, plan.next);
        if (plan.changed.length > 0) result.puts[plan.name] = plan.changed.length;
      } else {
        // Keep the old baseline: the failed rows count as changed next time.
        allStored = false;
      }
    });
    if (allStored && marker && !recordsEqual(marker, writtenCoverage) && (await cache.putCoverage(marker))) {
      writtenCoverage = marker;
      result.coverage = true;
    }
    return result;
  }

  return {
    /**
     * Queue one write-back ({@link run}).
     *
     * @returns {Promise<{ puts: Object<string, number>, coverage: boolean }>}
     *   What it stored; never rejects.
     */
    write() {
      queuedAny = true;
      queue = queue.then(run).catch(() => ({ puts: {}, coverage: false }));
      return queue;
    },
    /**
     * Take the rows and the marker the cache seed read as written, under the
     * store generation it read, unless a write-back was queued already.
     *
     * @param {Object<string, Array<Object>>} rowsByCollection The seeded rows.
     * @param {*} marker The stored coverage marker, or undefined.
     * @param {?string} [generation] The store generation the seed read; a
     *   run that finds another one writes every row.
     * @returns {void}
     */
    seeded(rowsByCollection, marker, generation) {
      // Once a write-back is queued, what it stores is the baseline; rows a
      // late seed sees may not be stored yet.
      if (queuedAny) return;
      for (const [name, rows] of Object.entries(rowsByCollection)) {
        const held = new Map();
        for (const row of rows) {
          const key = keyOf(name, row);
          if (key != null) held.set(key, row);
        }
        written.set(name, held);
      }
      writtenCoverage = marker ?? null;
      knownGeneration = generation;
    },
    /**
     * Queue `wipe` behind the pending write-backs, then forget what was
     * written.
     *
     * @param {() => Promise<void>} wipe Empties the cache.
     * @returns {Promise<void>} Settles once wiped; rejects with the wipe's error.
     */
    clear(wipe) {
      const cleared = queue.then(async () => {
        await wipe();
        written = new Map();
        writtenCoverage = null;
        knownGeneration = undefined;
      });
      // A failed wipe must not stop later writes; the caller sees its error.
      queue = cleared.catch(() => undefined);
      return cleared;
    },
  };
}
