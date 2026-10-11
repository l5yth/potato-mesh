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
 * Page-open sequencer (SPEC OR1-OR5).
 *
 * A dashboard page open runs one initial load: the cache seed (SPEC FC2),
 * then the first refresh. The live stream and the poll start once that load
 * has settled (OR1). Started earlier, the stream's open ran its PS5 resync
 * while the load was still running: the resync was then a second full load,
 * and a seed that finished last replaced the newer network rows with the
 * cached ones. Started after it, the first resync is a delta.
 *
 * Neither step can hold the page (OR5). The first refresh runs once the seed
 * has settled or after {@link SEED_TIMEOUT_MS}, whichever comes first; the
 * start runs once the first refresh has settled or after
 * {@link START_TIMEOUT_MS}. A seed that finishes after its bound cannot
 * overwrite network rows: once any refresh has loaded them, the seed is
 * skipped (OR2). A stop before the start cancels it and clears the pending
 * bound (OR3).
 *
 * The module touches neither the DOM nor the network: `main.js` passes in its
 * seed, refresh and start functions.
 *
 * @module main/page-open-sequencer
 */

/**
 * Longest wait, in ms, for the cache seed before the first refresh runs
 * anyway (SPEC OR5). The seed reads IndexedDB, which can leave it waiting: a
 * blocked open is handled as "storage unavailable" (`data-cache-idb.js`), but
 * an engine that never answers would hold the page for good. After this long
 * the first refresh loads the page from the network. Seeds measured in
 * headless Chromium finish far below it (see SPEC OR5).
 *
 * @type {number}
 */
export const SEED_TIMEOUT_MS = 3000;

/**
 * Longest wait, in ms, for the first refresh before the stream and the poll
 * start anyway (SPEC OR5). A first refresh that never settles (a request that
 * never answers) would otherwise keep them off for good; after this long they
 * start, and the stream's resync loads the page again. Cold loads measured in
 * headless Chromium at 4x CPU settle well below it (see SPEC OR5), so it does
 * not fire on a normal page open.
 *
 * @type {number}
 */
export const START_TIMEOUT_MS = 20000;

/**
 * The ambient timers, looked up when a bound is armed (tests replace them).
 *
 * @type {{ setTimeout: Function, clearTimeout: Function }}
 */
const AMBIENT_TIMERS = Object.freeze({
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle),
});

/**
 * Create the sequencer for one page open.
 *
 * @param {Object} steps The page-open steps and their bounds.
 * @param {() => *} steps.seed Paint from the persistent cache. It may reject
 *   or throw; the first refresh then runs as a cold load.
 * @param {() => *} steps.load The first refresh. It may reject; the start
 *   still runs, so the stream and the poll retry the load.
 * @param {() => void} steps.start Open the live stream and arm the poll.
 * @param {number} [steps.seedTimeoutMs] Bound on the seed, default
 *   {@link SEED_TIMEOUT_MS}.
 * @param {number} [steps.startTimeoutMs] Bound on the first refresh before the
 *   start, default {@link START_TIMEOUT_MS}.
 * @param {{ setTimeout: Function, clearTimeout: Function }} [steps.timers]
 *   Timer functions, default the ambient ones.
 * @returns {{
 *   run: () => Promise<void>,
 *   cancelStart: () => void,
 *   isPending: () => boolean,
 *   boundsHit: () => { seed: boolean, start: boolean },
 *   markNetworkLoaded: () => void,
 *   hasNetworkData: () => boolean,
 * }} The sequencer handle.
 */
export function createPageOpenSequencer({
  seed,
  load,
  start,
  seedTimeoutMs = SEED_TIMEOUT_MS,
  startTimeoutMs = START_TIMEOUT_MS,
  timers = AMBIENT_TIMERS,
}) {
  /** @type {?Promise<void>} The initial load, once {@link run} has begun it. */
  let initialLoad = null;
  /** Whether the start has run or was skipped by a stop. */
  let settled = false;
  /** Whether a stop cancelled the start that waits on the initial load (OR3). */
  let startCancelled = false;
  /** Whether a refresh has loaded network rows on this page (OR2). */
  let networkLoaded = false;
  /** The armed bound of the step being waited on, or null. */
  let boundTimer = null;
  /** Which bounds fired on this page open (OR5). */
  const hit = { seed: false, start: false };

  /**
   * Call a step; a synchronous throw becomes a rejection.
   *
   * @param {() => *} step The step to call.
   * @returns {Promise<*>} The step's outcome.
   */
  function attempt(step) {
    try {
      return Promise.resolve(step());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Call `next` once, when `step` settles (fulfilled or rejected) or when `ms`
   * elapse, whichever comes first. After a stop no bound is armed: `next` then
   * runs only when the step settles. Plain callbacks, not a promise chain, so
   * the start follows a settled step within two microtasks.
   *
   * @param {Promise<*>} step The running step.
   * @param {number} ms The bound.
   * @param {'seed'|'start'} name The bound's key in {@link hit}.
   * @param {() => void} next What follows the step.
   * @returns {void}
   */
  function after(step, ms, name, next) {
    let handle = null;
    let done = false;
    const proceed = () => {
      if (done) return;
      done = true;
      if (handle !== null && boundTimer === handle) {
        timers.clearTimeout(handle);
        boundTimer = null;
      }
      next();
    };
    if (!startCancelled) {
      handle = timers.setTimeout(() => {
        boundTimer = null;
        hit[name] = true;
        proceed();
      }, ms);
      // A bound never keeps a Node process (the test runner) alive.
      if (handle && typeof handle.unref === 'function') handle.unref();
      boundTimer = handle;
    }
    step.then(proceed, proceed);
  }

  return {
    /**
     * Run the initial load: the seed (called in this task), then the first
     * refresh once the seed has settled or its bound has passed, then the
     * start once the refresh has settled or its bound has passed, unless
     * {@link cancelStart} was called. A failed seed leaves the state empty,
     * so the first refresh is a cold load; a failed first refresh still
     * starts the stream and the poll, whose resync or next tick retries it.
     * Runs once per page open; later calls return the same promise.
     *
     * @returns {Promise<void>} Settles once the start has run or was skipped;
     *   rejects only when the start itself throws.
     */
    run() {
      if (initialLoad) return initialLoad;
      initialLoad = new Promise((resolve, reject) => {
        const finish = () => {
          settled = true;
          try {
            if (!startCancelled) start();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        const firstRefresh = () => after(attempt(load), startTimeoutMs, 'start', finish);
        after(attempt(seed), seedTimeoutMs, 'seed', firstRefresh);
      });
      return initialLoad;
    },

    /**
     * Cancel the start that waits on the initial load (OR3) and clear the
     * pending bound: once called, the pending start is a no-op and no bound
     * fires. A later explicit start is not affected.
     *
     * @returns {void}
     */
    cancelStart() {
      startCancelled = true;
      if (boundTimer !== null) {
        timers.clearTimeout(boundTimer);
        boundTimer = null;
      }
    },

    /**
     * @returns {boolean} true from {@link run} until the start has run or was
     *   skipped, at most the two bounds after {@link run}.
     */
    isPending() {
      return initialLoad !== null && !settled;
    },

    /**
     * @returns {{ seed: boolean, start: boolean }} Which bounds fired on this
     *   page open: `seed` when the first refresh ran before the seed settled,
     *   `start` when the start ran before the first refresh settled (OR5).
     */
    boundsHit() {
      return { ...hit };
    },

    /**
     * Record that a refresh has loaded network rows (OR2). Called once a
     * refresh's fetches have resolved, before it merges them.
     *
     * @returns {void}
     */
    markNetworkLoaded() {
      networkLoaded = true;
    },

    /**
     * @returns {boolean} true once any refresh on this page has loaded network
     *   rows; the seed is then skipped (OR2).
     */
    hasNetworkData() {
      return networkLoaded;
    },
  };
}
