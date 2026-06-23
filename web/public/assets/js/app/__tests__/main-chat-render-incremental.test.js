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
 * Regression guards for the chat-log render + node-hydration fixes.
 *
 *   FIX 1 — incremental chat render: an idle re-render (no new/changed
 *           messages) must not rebuild every entry from an HTML string.
 *   FIX 2 — node hydration: the chat hydrator must resolve senders from the
 *           already-loaded bulk node map and never issue per-node
 *           ``GET /api/nodes/:id`` requests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

/** Config that disables auto-refresh so the test controls render timing. */
const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  tileFilters: { light: '', dark: '' },
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/**
 * Build a fetch double that records every call and answers from a prefix map.
 *
 * @param {Object<string, *>} responsesByEndpoint URL-substring → JSON body (or
 *   a thunk returning one).
 * @returns {{ fetch: Function, calls: Array<{ url: string, options: Object }> }}
 */
function buildStubFetch(responsesByEndpoint = {}) {
  const calls = [];
  function stubFetch(url, options = {}) {
    calls.push({ url, options });
    for (const [prefix, body] of Object.entries(responsesByEndpoint)) {
      if (url.includes(prefix)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(typeof body === 'function' ? body() : body),
        });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  }
  return { fetch: stubFetch, calls };
}

/**
 * Spin up the dashboard with a registered ``#chat`` container and a stubbed
 * fetch, let the initial refresh settle, then run the test body.
 *
 * @param {Object<string, *>} stubResponses Response map for the stub fetch.
 * @param {function({ testUtils: Object, calls: Array, env: Object }): Promise<void>} fn Test body.
 * @returns {Promise<void>}
 */
async function withChatApp(stubResponses, fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  const { fetch: stubFetch, calls } = buildStubFetch(stubResponses);
  globalThis.fetch = stubFetch;
  try {
    const { _testUtils } = initializeApp(CONFIG);
    // The initial refresh() is async (fetch + hydrate + render); let it settle.
    await new Promise(r => setTimeout(r, 60));
    await fn({ testUtils: _testUtils, calls, env });
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
}

const NOW = Math.floor(Date.now() / 1000);

/**
 * Build N plaintext messages on the primary channel from a known sender.
 *
 * @param {number} count Number of messages.
 * @returns {Array<Object>} Message payloads.
 */
function makeMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    channel: 0,
    from_id: '!00000001',
    to_id: '^all',
    text: `hello ${i + 1}`,
    rx_time: NOW - i,
    protocol: 'meshtastic',
  }));
}

const KNOWN_NODES = [
  {
    node_id: '!00000001',
    short_name: 'S1',
    long_name: 'Sender One',
    role: 'CLIENT',
    last_heard: NOW,
    // ``first_heard`` within the window produces a "New node" announcement in the
    // Log tab, exercising the announcement (parts) render path too.
    first_heard: NOW,
    protocol: 'meshtastic',
  },
];

test('FIX 1: an idle chat re-render materialises no entries', async () => {
  await withChatApp({ '/api/messages': makeMessages(5), '/api/nodes': KNOWN_NODES }, async ({ testUtils }) => {
    const initial = testUtils.getChatRenderStats().materialized;
    assert.ok(initial > 0, `initial render should materialise entries (saw ${initial})`);

    // Re-render with the exact same state — nothing new arrived.
    testUtils.resetChatRenderStats();
    testUtils.rerenderChatLog();
    const afterIdle = testUtils.getChatRenderStats().materialized;

    assert.equal(
      afterIdle,
      0,
      `an idle re-render must reuse already-built entries, but materialised ${afterIdle}`,
    );
  });
});

test('FIX 1: an idle re-render preserves rendered chat content', async () => {
  await withChatApp({ '/api/messages': makeMessages(3), '/api/nodes': KNOWN_NODES }, async ({ testUtils, env }) => {
    testUtils.rerenderChatLog();
    const chat = env.document.getElementById('chat');
    const html = chat ? chat.innerHTML : '';
    for (const text of ['hello 1', 'hello 2', 'hello 3']) {
      assert.ok(html.includes(text), `chat should still contain "${text}" after re-render`);
    }
  });
});

test('FIX 2: chat hydration issues no per-node /api/nodes/:id requests', async () => {
  // The sender is absent from the bulk /api/nodes payload (an RF-only node).
  const messages = [
    { id: 1, channel: 0, from_id: '!ffff0000', to_id: '^all', text: 'rf only', rx_time: NOW, protocol: 'meshtastic' },
  ];
  await withChatApp({ '/api/messages': messages, '/api/nodes': [] }, async ({ calls }) => {
    const perNode = calls
      .map(c => c.url)
      .filter(url => /\/api\/nodes\/(!|%21)/.test(url));
    assert.deepEqual(
      perNode,
      [],
      `hydration must not fetch nodes one at a time, but requested: ${perNode.join(', ')}`,
    );
  });
});
