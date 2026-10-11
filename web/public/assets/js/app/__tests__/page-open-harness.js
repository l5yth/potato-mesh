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
 * Shared harness for the page-open tests (SPEC OR1-OR5): a stub `fetch` whose
 * collection GETs are held until the test releases them, a gated IndexedDB
 * factory, the page-open bound timers captured for the test to fire, and one
 * booted dashboard over a fake `EventSource`.
 *
 * @module __tests__/page-open-harness
 */

import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { makeFakeEventSource, SSE_BASE_CONFIG } from './sse-app-harness.js';
import * as sequencer from '../main/page-open-sequencer.js';
import { initializeApp } from '../main.js';

export const NOW = Math.floor(Date.now() / 1000);

/**
 * Plaintext channel rows, newest first, 20 s apart.
 *
 * @param {number} from First message id.
 * @param {number} n Row count.
 * @returns {Array<Object>} Message rows.
 */
export const page = (from, n) => Array.from({ length: n }, (_, i) => ({
  id: from + i, channel: 0, from_id: '!a', to_id: '^all', text: `m${from + i}`,
  rx_time: NOW - 10 - (from + i) * 20, protocol: 'meshtastic',
}));
/** A full newest page (MESSAGE_LIMIT rows), so the chat backfill pages on. */
export const NEWEST = page(0, 1000);
/** The page the chat backfill fetches below {@link NEWEST}. */
export const OLDER = page(1000, 1000);
/** The node rows the network serves. */
export const NETWORK_NODES = [
  { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' },
  { node_id: '!b', short_name: 'B', long_name: 'Node B', last_heard: NOW - 5, protocol: 'meshtastic' },
];
/** Collection GETs the stub holds until the test releases them. */
export const HELD = /\/api\/(nodes|messages|positions|telemetry|neighbors|traces|waypoints)\?/;
/** A cold (first-load) `/api/nodes` request: no `since`, no `before`. */
export const COLD_NODES = /\/api\/nodes\?limit=1000$/;

/**
 * Build a stub `fetch` that holds every collection GET until released;
 * backward pages (`before=`) and every other route answer at once.
 *
 * @returns {{ fetch: Function, calls: Array<{ url: string, released: boolean, release: Function }> }}
 */
export function heldFetch() {
  const calls = [];
  const body = (url) => {
    if (url.includes('/api/messages') && url.includes('encrypted=true')) return [];
    if (url.includes('/api/messages') && url.includes('before=')) {
      const before = Number(new URL(url, 'http://x').searchParams.get('before'));
      return before > OLDER[OLDER.length - 1].rx_time ? OLDER : [];
    }
    if (url.includes('/api/messages')) return NEWEST;
    if (url.includes('/api/nodes')) return NETWORK_NODES;
    return [];
  };
  const fetch = (url) => new Promise((resolve) => {
    const respond = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(body(url)) });
    const call = {
      url,
      released: false,
      release() {
        if (!this.released) {
          this.released = true;
          respond();
        }
      },
    };
    calls.push(call);
    if (!HELD.test(url) || url.includes('before=')) call.release();
  });
  return { fetch, calls };
}

/**
 * Wrap a fake IndexedDB factory so every `open` waits until the test opens a
 * gate: the app's cache, and so its seed, stays unopened until then.
 *
 * @param {{ open: Function }} inner Fake factory from `createFakeIndexedDb`.
 * @returns {{ factory: { open: Function }, release: () => void }} Gated factory and its gate.
 */
export function gatedFactory(inner) {
  const pending = [];
  let open = false;
  const factory = {
    open(name, version) {
      const outer = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null, error: null };
      const go = () => {
        const request = inner.open(name, version);
        request.onupgradeneeded = () => {
          outer.result = request.result;
          if (outer.onupgradeneeded) outer.onupgradeneeded();
        };
        request.onsuccess = () => {
          outer.result = request.result;
          if (outer.onsuccess) outer.onsuccess();
        };
      };
      if (open) go();
      else pending.push(go);
      return outer;
    },
  };
  return {
    factory,
    release() {
      open = true;
      pending.splice(0).forEach((go) => go());
    },
  };
}

/**
 * Let `n` macrotask turns pass so promise chains and fake IndexedDB requests settle.
 *
 * @param {number} [n=30] Turns.
 * @returns {Promise<void>}
 */
export const settle = async (n = 30) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Wait (in macrotask turns) until `predicate` holds.
 *
 * @param {() => boolean} predicate Condition to wait for.
 * @returns {Promise<void>}
 */
export async function waitFor(predicate) {
  for (let i = 0; i < 500 && !predicate(); i += 1) await settle(1);
  assert.ok(predicate(), 'condition never held');
}

/**
 * Release held GETs, including ones issued later, until the initial load
 * (seed, first refresh, start) has settled.
 *
 * @param {Object} u The app's test utils.
 * @param {Array<{ release: Function }>} calls Recorded fetch calls.
 * @param {string} [message] Assertion message when the load never settles.
 * @returns {Promise<void>}
 */
export async function finishInitialLoad(u, calls, message = 'the initial load settled') {
  let done = false;
  u.initialLoad.then(() => {
    done = true;
  });
  for (let i = 0; i < 500 && !done; i += 1) {
    for (const c of calls) c.release();
    await settle(1);
  }
  assert.ok(done, message);
}

/**
 * Boot one dashboard over the held fetch and a fake EventSource. The cache is
 * off unless `indexedDB` is given.
 *
 * @param {{ indexedDB?: Object, withToggle?: boolean, captureBounds?: boolean, flushCache?: boolean }} [options]
 *   Optional IndexedDB factory, whether to render `#autorefreshToggle`,
 *   whether to capture the page-open bound timers ({@link captureBoundTimers}),
 *   and whether the teardown waits for the cache write-back (not when the
 *   cache open never answers: the write-back then waits forever).
 * @returns {Promise<Object>} The test utils, the fetch calls, the stream accessor,
 *   the toggle's click, the captured bounds (or null), and the teardown.
 */
export async function boot({ indexedDB, withToggle = false, captureBounds = false, flushCache = true } = {}) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const clickHandlers = [];
  if (withToggle) {
    const toggle = env.createElement('button', 'autorefreshToggle');
    toggle.ownerDocument = env.document; // the control state builds its action span here
    toggle.addEventListener = (type, handler) => {
      if (type === 'click') clickHandlers.push(handler);
    };
    env.registerElement('autorefreshToggle', toggle);
  }
  const stub = heldFetch();
  const saved = { fetch: globalThis.fetch, es: globalThis.EventSource, idb: globalThis.indexedDB };
  globalThis.fetch = stub.fetch;
  globalThis.indexedDB = indexedDB;
  const FakeEventSource = makeFakeEventSource();
  globalThis.EventSource = FakeEventSource;
  const bounds = captureBounds ? captureBoundTimers() : null;
  const { _testUtils: u } = initializeApp({ ...SSE_BASE_CONFIG });
  const teardown = async () => {
    for (const c of stub.calls) c.release();
    await settle();
    if (flushCache) await u.flushCacheWrites();
    u.stopAutoRefresh();
    globalThis.fetch = saved.fetch;
    globalThis.EventSource = saved.es;
    globalThis.indexedDB = saved.idb;
    if (bounds) bounds.restore();
    env.cleanup();
  };
  return {
    u,
    calls: stub.calls,
    FakeEventSource,
    // The stream, once the app has opened one (null while it has not).
    es: () => FakeEventSource.instances[0] || null,
    click: () => clickHandlers.forEach((handler) => handler({ type: 'click' })),
    bounds,
    teardown,
  };
}

/**
 * Release every held call except `kept`, which stays unanswered.
 *
 * @param {Array<{ release: Function }>} calls Recorded fetch calls.
 * @param {Object} kept The call to leave hanging.
 * @returns {void}
 */
export function releaseExcept(calls, kept) {
  for (const c of calls) if (c !== kept) c.release();
}

/**
 * Capture the page-open bound timers (SPEC OR5): every `setTimeout` whose delay
 * is `SEED_TIMEOUT_MS` or `START_TIMEOUT_MS` is recorded instead of armed, so a
 * test fires it at will; every other timer runs as usual. Without the bounds
 * (before SPEC OR5) nothing is captured and nothing fires.
 *
 * @returns {{ armed: Array<Object>, fire: (ms: number) => number, restore: () => void }}
 *   The captured handles, a firing function returning how many handles of
 *   `ms` fired, and the restore of the real timers.
 */
export function captureBoundTimers() {
  const delays = [sequencer.SEED_TIMEOUT_MS, sequencer.START_TIMEOUT_MS].filter(Number.isFinite);
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const armed = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (!delays.includes(ms)) return realSet(callback, ms, ...args);
    const handle = {
      ms, callback, args, cleared: false, fired: false,
      unref() {
        return this;
      },
    };
    armed.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (armed.includes(handle)) {
      handle.cleared = true;
      return;
    }
    realClear(handle);
  };
  return {
    armed,
    fire(ms) {
      const due = armed.filter((h) => h.ms === ms && !h.cleared && !h.fired);
      for (const h of due) {
        h.fired = true;
        h.callback(...h.args);
      }
      return due.length;
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
