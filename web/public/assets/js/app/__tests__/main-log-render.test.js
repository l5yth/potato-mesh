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
 * Render-side guards for the node-centric Log feed (SPEC LV7, amended):
 *
 *   - A node-info entry renders its reason — "Updated node info (advert)" for a
 *     bare heard, "(message)" for a decrypted chat message recorded
 *     node-centrically — and degrades to plain copy when no reason is present.
 *   - A position entry reads "Broadcasted position info: …" with a colon, not
 *     the em dash used by telemetry.
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
    assert.ok(parts && parts.html.includes('Updated node info (advert)'),
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
    assert.ok(parts.html.includes('Updated node info (message)'),
      `expected message reason, got: ${parts.html}`);
  });
});

test('node-info without a reason degrades to plain copy', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.NODE_INFO,
      ts: 1000,
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts.html.includes('Updated node info'));
    assert.ok(!parts.html.includes('Updated node info ('),
      `plain copy must carry no reason suffix, got: ${parts.html}`);
  });
});

test('position entry uses a colon separator, not an em dash', () => {
  withRenderHelper(buildChatLogEntryParts => {
    const parts = buildChatLogEntryParts({
      type: CHAT_LOG_ENTRY_TYPES.POSITION,
      ts: 1000,
      position: { latitude: 52.5, longitude: 13.4 },
      node: NODE,
      nodeId: NODE.node_id,
    });
    assert.ok(parts.html.includes('Broadcasted position info:'),
      `expected colon separator, got: ${parts.html}`);
    assert.ok(!parts.html.includes('—'),
      `position must not use the em dash separator, got: ${parts.html}`);
  });
});
