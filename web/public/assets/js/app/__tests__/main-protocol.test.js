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

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';

const MINIMAL_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 30,
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
 * Spin up a minimal DOM environment, call initializeApp with a stub config,
 * and return the inner test utilities alongside an env.cleanup() handle.
 *
 * @returns {{ testUtils: Object, cleanup: Function }}
 */
function setupApp() {
  const env = createDomEnvironment({ includeBody: true });
  // themeToggle is accessed without a null guard in initializeApp.
  env.createElement('button', 'themeToggle');
  const { _testUtils } = initializeApp(MINIMAL_CONFIG);
  return { testUtils: _testUtils, cleanup: env.cleanup.bind(env) };
}

// --- normalizeOverlaySource ---

test('normalizeOverlaySource propagates string protocol field', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const result = testUtils.normalizeOverlaySource({ protocol: 'meshcore' });
    assert.equal(result.protocol, 'meshcore');
  } finally {
    cleanup();
  }
});

test('normalizeOverlaySource propagates "meshtastic" protocol', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const result = testUtils.normalizeOverlaySource({ protocol: 'meshtastic' });
    assert.equal(result.protocol, 'meshtastic');
  } finally {
    cleanup();
  }
});

test('normalizeOverlaySource omits protocol when absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const result = testUtils.normalizeOverlaySource({ longName: 'Alice' });
    assert.ok(!('protocol' in result), 'protocol should not be set when source has none');
  } finally {
    cleanup();
  }
});

test('normalizeOverlaySource omits protocol when value is not a string', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const result = testUtils.normalizeOverlaySource({ protocol: 42 });
    assert.ok(!('protocol' in result), 'protocol should not be set for non-string values');
  } finally {
    cleanup();
  }
});

// --- buildMapPopupHtml ---

test('buildMapPopupHtml includes meshtastic icon for null protocol', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const html = testUtils.buildMapPopupHtml({ long_name: 'Alice', node_id: '!abc123', protocol: null }, 0);
    assert.ok(html.includes('meshtastic.svg'), 'popup should show meshtastic icon for null protocol');
  } finally {
    cleanup();
  }
});

test('buildMapPopupHtml includes meshtastic icon for absent protocol', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const html = testUtils.buildMapPopupHtml({ long_name: 'Bob', node_id: '!abc456' }, 0);
    assert.ok(html.includes('meshtastic.svg'), 'popup should show meshtastic icon when protocol absent');
  } finally {
    cleanup();
  }
});

test('buildMapPopupHtml omits meshtastic icon for meshcore protocol', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const html = testUtils.buildMapPopupHtml({ long_name: 'Eve', node_id: '!abc789', protocol: 'meshcore' }, 0);
    assert.ok(!html.includes('meshtastic.svg'), 'popup should not show meshtastic icon for meshcore nodes');
  } finally {
    cleanup();
  }
});

// --- createAnnouncementEntry ---

test('createAnnouncementEntry prefixes meshtastic icon when protocol is meshtastic', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'ALI',
      longName: 'Alice',
      role: 'CLIENT',
      metadataSource: { protocol: 'meshtastic' },
      nodeData: null,
      messageHtml: 'joined the mesh',
    });
    const html = typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '';
    assert.ok(String(html).includes('meshtastic.svg'), 'announcement should include meshtastic icon');
  } finally {
    cleanup();
  }
});

test('createAnnouncementEntry prefixes meshtastic icon when protocol is absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'BOB',
      longName: 'Bob',
      role: 'ROUTER',
      metadataSource: {},
      nodeData: null,
      messageHtml: 'detected',
    });
    const html = String(typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '');
    assert.ok(html.includes('meshtastic.svg'), 'announcement without protocol should show meshtastic icon');
  } finally {
    cleanup();
  }
});

test('createAnnouncementEntry omits meshtastic icon for meshcore protocol', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'MC1',
      longName: 'MeshCore Node',
      role: 'REPEATER',
      metadataSource: { protocol: 'meshcore' },
      nodeData: null,
      messageHtml: 'seen',
    });
    const html = String(typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '');
    assert.ok(!html.includes('meshtastic.svg'), 'announcement for meshcore should not include meshtastic icon');
  } finally {
    cleanup();
  }
});

// --- createMessageChatEntry ---

test('createMessageChatEntry prefixes meshtastic icon when node protocol is meshtastic', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createMessageChatEntry({
      text: 'hello mesh',
      rx_time: 1000,
      node: { short_name: 'ALI', role: 'CLIENT', protocol: 'meshtastic' },
    });
    const html = String(typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '');
    assert.ok(html.includes('meshtastic.svg'), 'chat entry should include meshtastic icon');
  } finally {
    cleanup();
  }
});

test('createMessageChatEntry prefixes meshtastic icon when node protocol is absent', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createMessageChatEntry({
      text: 'hi',
      rx_time: 2000,
      node: { short_name: 'BOB', role: 'ROUTER' },
    });
    const html = String(typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '');
    assert.ok(html.includes('meshtastic.svg'), 'chat entry without protocol should show meshtastic icon');
  } finally {
    cleanup();
  }
});

test('createMessageChatEntry omits meshtastic icon for meshcore node', () => {
  const { testUtils, cleanup } = setupApp();
  try {
    const div = testUtils.createMessageChatEntry({
      text: 'test',
      rx_time: 3000,
      node: { short_name: 'MC1', role: 'REPEATER', protocol: 'meshcore' },
    });
    const html = String(typeof div.innerHTML === 'string' ? div.innerHTML : div.childNodes?.[0] ?? '');
    assert.ok(!html.includes('meshtastic.svg'), 'chat entry for meshcore node should not show meshtastic icon');
  } finally {
    cleanup();
  }
});
