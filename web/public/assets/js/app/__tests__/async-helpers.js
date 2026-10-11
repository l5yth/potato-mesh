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
 * Shared async test helpers: a promise the test settles by hand, and a
 * `requestIdleCallback` stand-in whose callbacks run only when the test says
 * so, for the backfill suites that decide when a page lands and when idle
 * time comes.
 *
 * @module __tests__/async-helpers
 */

/**
 * A promise plus the functions that settle it.
 *
 * @returns {{ promise: Promise<*>, resolve: function(*): void, reject: function(*): void }}
 *   The promise, its resolver and its rejecter.
 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The idle-callback globals {@link installIdleQueue} replaces. */
const IDLE_GLOBALS = Object.freeze(['requestIdleCallback', 'cancelIdleCallback']);

/**
 * Replace `requestIdleCallback` and `cancelIdleCallback` with a queue that
 * runs only when the test calls `run()`. The app's scheduler takes its idle
 * branch while both are installed. `restore()` puts back exactly what was
 * there: the original functions, or nothing where the runtime has none.
 *
 * @returns {{
 *   requested: Array<number>,
 *   cancelled: Array<number>,
 *   pending: function(): number,
 *   run: function(): number,
 *   restore: function(): void,
 * }} The queue: every id handed out, every id cancelled, how many callbacks
 *   wait, run every waiting callback (returns how many ran; the callbacks get
 *   no deadline, as the app's idle work reads none), and put the globals back.
 */
export function installIdleQueue() {
  const saved = Object.fromEntries(
    IDLE_GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
      .filter(([, descriptor]) => Boolean(descriptor)),
  );
  const queue = new Map();
  const requested = [];
  const cancelled = [];
  globalThis.requestIdleCallback = callback => {
    const id = requested.length + 1;
    requested.push(id);
    queue.set(id, callback);
    return id;
  };
  globalThis.cancelIdleCallback = id => {
    cancelled.push(id);
    queue.delete(id);
  };
  return {
    requested,
    cancelled,
    pending: () => queue.size,
    run() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback();
      return callbacks.length;
    },
    restore() {
      for (const name of IDLE_GLOBALS) delete globalThis[name];
      Object.defineProperties(globalThis, saved);
    },
  };
}
