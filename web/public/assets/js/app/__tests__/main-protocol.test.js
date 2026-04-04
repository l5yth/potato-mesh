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

/**
 * Run a test body with a fresh app instance, ensuring cleanup regardless of
 * outcome.  Eliminates the repetitive try/finally boilerplate across tests.
 *
 * @param {function(Object): void} fn Receives the _testUtils object.
 */
function withApp(fn) {
  const { testUtils, cleanup } = setupApp();
  try {
    fn(testUtils);
  } finally {
    cleanup();
  }
}

/**
 * Extract the serialised HTML string from a DOM element returned by the test
 * utils.  The stub environment exposes innerHTML as a plain string; this
 * normalises the fallback path for environments where it may not be.
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
function innerHtml(el) {
  return String(typeof el.innerHTML === 'string' ? el.innerHTML : el.childNodes?.[0] ?? '');
}

// --- buildDisplayContext ---

test('buildDisplayContext extracts protocol from trace candidate source', () => {
  withApp((t) => {
    const entry = {
      nodeId: '!aabbccdd',
      trace: { protocol: 'meshcore', node_id: '!aabbccdd' },
    };
    const ctx = t.buildDisplayContext(entry);
    assert.equal(ctx.protocol, 'meshcore', 'protocol must be picked from entry.trace');
  });
});

test('buildDisplayContext extracts protocol from node candidate source', () => {
  withApp((t) => {
    const entry = {
      nodeId: '!aabbccdd',
      node: { protocol: 'meshcore' },
    };
    const ctx = t.buildDisplayContext(entry);
    assert.equal(ctx.protocol, 'meshcore', 'protocol must be picked from entry.node');
  });
});

test('buildDisplayContext protocol is null when no candidate carries it', () => {
  withApp((t) => {
    const entry = { nodeId: '!aabbccdd', node: { short_name: 'X' } };
    const ctx = t.buildDisplayContext(entry);
    assert.equal(ctx.protocol, null, 'protocol should be null when absent from all sources');
  });
});

// --- normalizeOverlaySource ---

test('normalizeOverlaySource propagates string protocol field', () => {
  withApp((t) => {
    const result = t.normalizeOverlaySource({ protocol: 'meshcore' });
    assert.equal(result.protocol, 'meshcore');
  });
});

test('normalizeOverlaySource propagates "meshtastic" protocol', () => {
  withApp((t) => {
    const result = t.normalizeOverlaySource({ protocol: 'meshtastic' });
    assert.equal(result.protocol, 'meshtastic');
  });
});

test('normalizeOverlaySource omits protocol when absent', () => {
  withApp((t) => {
    const result = t.normalizeOverlaySource({ longName: 'Alice' });
    assert.ok(!('protocol' in result), 'protocol should not be set when source has none');
  });
});

test('normalizeOverlaySource omits protocol when value is not a string', () => {
  withApp((t) => {
    const result = t.normalizeOverlaySource({ protocol: 42 });
    assert.ok(!('protocol' in result), 'protocol should not be set for non-string values');
  });
});

// --- buildMapPopupHtml ---

test('buildMapPopupHtml shows no icon for null protocol', () => {
  withApp((t) => {
    const html = t.buildMapPopupHtml({ long_name: 'Alice', node_id: '!abc123', protocol: null }, 0);
    assert.ok(!html.includes('meshtastic.svg'), 'popup should not show meshtastic icon when protocol is null');
    assert.ok(!html.includes('meshcore.svg'), 'popup should not show meshcore icon when protocol is null');
  });
});

test('buildMapPopupHtml shows no icon when protocol is absent', () => {
  withApp((t) => {
    const html = t.buildMapPopupHtml({ long_name: 'Bob', node_id: '!abc456' }, 0);
    assert.ok(!html.includes('meshtastic.svg'), 'popup should not show any icon when protocol is absent');
    assert.ok(!html.includes('meshcore.svg'), 'popup should not show any icon when protocol is absent');
  });
});

test('buildMapPopupHtml shows meshtastic icon for explicit meshtastic protocol', () => {
  withApp((t) => {
    const html = t.buildMapPopupHtml({ long_name: 'Alice', node_id: '!abc123', protocol: 'meshtastic' }, 0);
    assert.ok(html.includes('meshtastic.svg'), 'popup should show meshtastic icon for explicit meshtastic protocol');
  });
});

test('buildMapPopupHtml omits meshtastic icon for meshcore protocol', () => {
  withApp((t) => {
    const html = t.buildMapPopupHtml({ long_name: 'Eve', node_id: '!abc789', protocol: 'meshcore' }, 0);
    assert.ok(!html.includes('meshtastic.svg'), 'popup should not show meshtastic icon for meshcore nodes');
  });
});

// --- createAnnouncementEntry ---

test('createAnnouncementEntry prefixes meshtastic icon when protocol is meshtastic', () => {
  withApp((t) => {
    const div = t.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'ALI',
      longName: 'Alice',
      role: 'CLIENT',
      metadataSource: { protocol: 'meshtastic' },
      nodeData: null,
      messageHtml: 'joined the mesh',
    });
    assert.ok(innerHtml(div).includes('meshtastic.svg'), 'announcement should include meshtastic icon');
  });
});

test('createAnnouncementEntry shows no icon when protocol is absent', () => {
  withApp((t) => {
    const div = t.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'BOB',
      longName: 'Bob',
      role: 'ROUTER',
      metadataSource: {},
      nodeData: null,
      messageHtml: 'detected',
    });
    assert.ok(!innerHtml(div).includes('meshtastic.svg'), 'no meshtastic icon when protocol is absent');
    assert.ok(!innerHtml(div).includes('meshcore.svg'), 'no meshcore icon when protocol is absent');
  });
});

test('createAnnouncementEntry omits meshtastic icon for meshcore protocol', () => {
  withApp((t) => {
    const div = t.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'MC1',
      longName: 'MeshCore Node',
      role: 'REPEATER',
      metadataSource: { protocol: 'meshcore' },
      nodeData: null,
      messageHtml: 'seen',
    });
    assert.ok(!innerHtml(div).includes('meshtastic.svg'), 'announcement for meshcore should not include meshtastic icon');
  });
});

test('createAnnouncementEntry shows meshcore icon for meshcore protocol', () => {
  withApp((t) => {
    const div = t.createAnnouncementEntry({
      timestampSeconds: 1000,
      shortName: 'MC1',
      longName: 'MeshCore Node',
      role: 'REPEATER',
      protocol: 'meshcore',
      metadataSource: null,
      nodeData: null,
      messageHtml: 'seen',
    });
    assert.ok(innerHtml(div).includes('meshcore.svg'), 'announcement for meshcore should include meshcore icon');
  });
});

// --- createMessageChatEntry ---

test('createMessageChatEntry prefixes meshtastic icon when node protocol is meshtastic', () => {
  withApp((t) => {
    const div = t.createMessageChatEntry({
      text: 'hello mesh',
      rx_time: 1000,
      node: { short_name: 'ALI', role: 'CLIENT', protocol: 'meshtastic' },
    });
    assert.ok(innerHtml(div).includes('meshtastic.svg'), 'chat entry should include meshtastic icon');
  });
});

test('createMessageChatEntry shows no icon when node protocol is absent', () => {
  withApp((t) => {
    const div = t.createMessageChatEntry({
      text: 'hi',
      rx_time: 2000,
      node: { short_name: 'BOB', role: 'ROUTER' },
    });
    assert.ok(!innerHtml(div).includes('meshtastic.svg'), 'no meshtastic icon when protocol is absent');
    assert.ok(!innerHtml(div).includes('meshcore.svg'), 'no meshcore icon when protocol is absent');
  });
});

test('createMessageChatEntry omits meshtastic icon for meshcore node', () => {
  withApp((t) => {
    const div = t.createMessageChatEntry({
      text: 'test',
      rx_time: 3000,
      node: { short_name: 'MC1', role: 'REPEATER', protocol: 'meshcore' },
    });
    assert.ok(!innerHtml(div).includes('meshtastic.svg'), 'chat entry for meshcore node should not show meshtastic icon');
  });
});

test('createMessageChatEntry shows meshcore icon for meshcore node', () => {
  withApp((t) => {
    const div = t.createMessageChatEntry({
      text: 'test',
      rx_time: 3000,
      node: { short_name: 'MC1', role: 'REPEATER', protocol: 'meshcore' },
    });
    assert.ok(innerHtml(div).includes('meshcore.svg'), 'chat entry for meshcore node should show meshcore icon');
  });
});
