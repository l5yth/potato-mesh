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
 * Shared harness for driving `initializeApp` over a fake `EventSource` + stub
 * `fetch` (cache disabled), used by the SSE live-update and flash test suites.
 *
 * @module __tests__/sse-app-harness
 */

import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

const NOW = Math.floor(Date.now() / 1000);

/** App config with live updates enabled and a slow safety poll. */
export const SSE_BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 60_000,
  refreshIntervalSeconds: 60,
  safetyPollMs: 300_000,
  liveUpdatesEnabled: true,
  liveUpdatesPath: '/api/events',
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** Default stub-fetch payloads keyed by URL substring. */
export const DEFAULT_RESPONSES = Object.freeze({
  '/api/nodes': [
    { node_id: '!a', short_name: 'A', long_name: 'Node A', last_heard: NOW, protocol: 'meshtastic' },
  ],
  '/api/messages': [
    { id: 1, channel: 0, from_id: '!a', to_id: '^all', text: 'hello', rx_time: NOW, protocol: 'meshtastic' },
  ],
});

/**
 * Build a recording stub fetch answering from a URL-substring map.
 *
 * @param {Object<string, *>} responses URL-substring → JSON body.
 * @returns {{ fetch: Function, calls: Array<{ url: string }> }}
 */
export function buildStubFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch(url) {
      calls.push({ url });
      for (const [prefix, body] of Object.entries(responses)) {
        if (url.includes(prefix)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        }
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    },
  };
}

/**
 * Create a fresh fake EventSource class recording listeners + instances so a
 * test can dispatch `open` / `change` / `error` events.
 *
 * @returns {Function} the FakeEventSource constructor (with `.instances`).
 */
export function makeFakeEventSource() {
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }

    close() {
      this.closed = true;
    }

    dispatch(type, event) {
      (this.listeners[type] || []).forEach((fn) => fn(event));
    }
  }
  FakeEventSource.instances = [];
  return FakeEventSource;
}

/**
 * Boot one app instance with a fake EventSource + stub fetch (cache disabled),
 * await the initial load, run the body, then tear the timer/stream down so the
 * Node test runner can exit cleanly.
 *
 * @param {{ configOverrides?: Object, withEventSource?: boolean, responses?: Object }} [opts]
 * @param {(ctx: { calls: Array, testUtils: Object, FakeEventSource: Function }) => Promise<void>} fn Body.
 * @returns {Promise<void>}
 */
export async function runLiveApp({ configOverrides = {}, withEventSource = true, responses } = {}, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  const originalIdb = globalThis.indexedDB;
  const { fetch: stubFetch, calls } = buildStubFetch(responses || { ...DEFAULT_RESPONSES });
  globalThis.fetch = stubFetch;
  globalThis.indexedDB = undefined; // disable the persistent cache for a clean cold path
  const FakeEventSource = makeFakeEventSource();
  if (withEventSource) globalThis.EventSource = FakeEventSource;
  else delete globalThis.EventSource;
  let testUtils = null;
  try {
    ({ _testUtils: testUtils } = initializeApp({ ...SSE_BASE_CONFIG, ...configOverrides }));
    await testUtils.initialLoad;
    await testUtils.flushBackfill();
    await fn({ calls, testUtils, FakeEventSource });
  } finally {
    // Let fire-and-forget refresh tails (the stats footer update, cache write)
    // settle against the live DOM before teardown.
    if (testUtils) await testUtils.flushCacheWrites();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    if (testUtils) testUtils.stopAutoRefresh();
    globalThis.fetch = originalFetch;
    if (originalES === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalES;
    globalThis.indexedDB = originalIdb;
    env.cleanup();
  }
}
