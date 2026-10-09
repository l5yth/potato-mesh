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
 * Render-side guards for the node-centric Log feed (SPEC LV7, amended by LA2
 * and LA3):
 *
 *   - A node-info entry renders its reason — "node info · advert" for a bare
 *     heard, "node info · message" for a decrypted chat message recorded
 *     node-centrically — and degrades to the kind alone when no reason is
 *     present.
 *   - A position entry reads "position · <lat>, <lon>", one middle dot, no
 *     colon and no em dash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { CHAT_LOG_ENTRY_TYPES, NODE_INFO_REASONS } from '../chat-log-tabs.js';

/** Minimal dashboard config: auto-refresh disabled, chat enabled. */
const CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** The kind word of a node-info entry (SPEC LA2). */
const NODE_INFO_KIND = '<span class="chat-entry-kind">node info</span>';

/** Sender node used as the inline display source for the crafted entries. */
const NODE = Object.freeze({
  node_id: '!00000001',
  long_name: 'Alice',
  short_name: 'Alic',
  role: 'CLIENT',
  protocol: 'meshtastic',
});

/**
 * Initialise the dashboard headlessly and hand the test body the
 * ``buildChatLogEntryParts`` render helper exposed on ``_testUtils``.
 *
 * @param {function(Function): void} fn Receives ``buildChatLogEntryParts``.
 * @returns {void}
 */
function withRenderHelper(fn) {
  const env = createDomEnvironment({ includeBody: true });
  env.registerElement('chat', env.createElement('div', 'chat'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
  try {
    const { _testUtils } = initializeApp(CONFIG);
    fn(_testUtils.buildChatLogEntryParts);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
}

test('node-info entry renders the advert reason', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.NODE_INFO,
      reason: NODE_INFO_REASONS.ADVERT,
      ts: 1000,
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts && parts.html.includes(`${NODE_INFO_KIND} · advert`),
      `expected advert reason, got: ${parts && parts.html}`);
  });
});

test('decrypted-message node-info renders the message reason, never a body', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.NODE_INFO,
      reason: NODE_INFO_REASONS.MESSAGE,
      ts: 1000,
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts.html.includes(`${NODE_INFO_KIND} · message`),
      `expected message reason, got: ${parts.html}`);
  });
});

test('node-info without a reason degrades to the kind alone', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.NODE_INFO,
      ts: 1000,
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts.html.includes(`<span class="chat-entry-part">${NODE_INFO_KIND}</span>`),
      `the kind must carry no reason, got: ${parts.html}`);
  });
});

test('position entry reads "position · lat, lon", without a colon or an em dash', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.POSITION,
      ts: 1000,
      position: { latitude: 52.5, longitude: 13.4 },
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts.html.includes('<span class="chat-entry-kind">position</span> · 52.5000, 13.4000'),
      `expected the middle dot, got: ${parts.html}`);
    assert.ok(!parts.html.includes(': 52'),
      `position must not use a colon separator, got: ${parts.html}`);
    assert.ok(!parts.html.includes('—'),
      `position must not use the em dash separator, got: ${parts.html}`);
  });
});
