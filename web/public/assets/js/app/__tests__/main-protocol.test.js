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

import { withApp, innerHtml } from './main-app-test-helpers.js';

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

// --- createMessageChatEntry: MeshCore channel message sender resolution ---

/**
 * A MeshCore COMPANION node used as the canonical sender fixture in the
 * channel-message tests below.
 */
const T114_ZEH = { node_id: '!aabbccdd', long_name: 'T114-Zeh', short_name: '  T ', role: 'COMPANION', protocol: 'meshcore' };

/**
 * Build a minimal MeshCore channel message payload for createMessageChatEntry.
 * @param {string} text Message text (typically "SenderName: body" format).
 * @param {object} [overrides] Properties to merge in.
 */
function makeMeshcoreChannelMsg(text, overrides = {}) {
  return { text, rx_time: 1000, protocol: 'meshcore', to_id: '^all', node: null, ...overrides };
}

test('createMessageChatEntry: meshcore channel message uses sender node short name when found', () => {
  withApp((t) => {
    // Seed a node with a known long_name so findNodeByLongName can resolve it.
    t.rebuildNodeIndex([T114_ZEH]);
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('T114-Zeh: Hello world'));
    const html = innerHtml(div);
    // Badge should NOT be the fallback '?' — the node's short_name should be used
    assert.ok(html.includes('T'), 'badge should contain T from derived short name');
    assert.ok(!html.includes('?'), 'badge should not show placeholder question mark');
  });
});

test('createMessageChatEntry: meshcore channel message hides sender long name — only body shown', () => {
  withApp((t) => {
    t.rebuildNodeIndex([T114_ZEH]);
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('T114-Zeh: Hello world'));
    const html = innerHtml(div);
    // The sender long name is NOT prepended as a link — only the text after the colon is shown
    assert.ok(html.includes('Hello world'), 'body text after colon should be rendered');
    // Sender name should not appear as a link (href to node page) in the body
    assert.ok(!html.includes('T114-Zeh:'), 'sender long name prefix with colon should not appear in body');
  });
});

test('createMessageChatEntry: meshcore channel message, sender node not found — shows body only', () => {
  withApp((t) => {
    t.rebuildNodeIndex([]);  // empty — no nodes known
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('UnknownSender: Hello'));
    const html = innerHtml(div);
    // Only the body text is shown; sender name is not prepended as a link
    assert.ok(html.includes('Hello'), 'body text after colon should still be rendered');
    assert.ok(!html.includes('UnknownSender:'), 'sender long name prefix with colon should not appear in body');
    assert.ok(!html.includes('/nodes/'), 'should not produce a node link when sender is not found');
  });
});

test('createMessageChatEntry: meshcore channel message, no colon in text — body unchanged', () => {
  withApp((t) => {
    t.rebuildNodeIndex([T114_ZEH]);
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('no colon here'));
    const html = innerHtml(div);
    assert.ok(html.includes('no colon here'), 'body text should be rendered as-is when no sender prefix found');
    assert.ok(!html.includes('/nodes/'), 'should not produce a node link when no colon prefix');
  });
});

test('createMessageChatEntry: meshcore message with @[Name] mention resolved to badge', () => {
  withApp((t) => {
    t.rebuildNodeIndex([
      { ...T114_ZEH, node_id: '!11111111' },
      { node_id: '!22222222', long_name: 'BGruenauBot', short_name: ' BG ', role: 'CLIENT', protocol: 'meshcore' },
    ]);
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('BGruenauBot: ack @[T114-Zeh]', { rx_time: 2000 }));
    const html = innerHtml(div);
    // The @[T114-Zeh] mention should render as a short-name badge span
    assert.ok(html.includes('short-name'), 'mention should produce a short-name badge');
    // The sender long name is not prepended as a link in the body
    assert.ok(!html.includes('BGruenauBot:'), 'sender long name prefix with colon should not appear in body');
  });
});

test('createMessageChatEntry: meshcore message with @[Name] mention, node not found — fallback', () => {
  withApp((t) => {
    t.rebuildNodeIndex([]);
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('EchoBot: Pong! @[Ghost]', { rx_time: 3000 }));
    const html = innerHtml(div);
    // @[Ghost] mention with no matching node renders as escaped plain text
    assert.ok(html.includes('@[Ghost]'), 'unresolved mention should render as escaped @[Name] text');
  });
});

test('createMessageChatEntry: meshcore channel message with hydrated node — body only shown', () => {
  // Simulates the case where the ingestor resolved from_id successfully.
  // The node is hydrated (m.node is not null), and the body still has "SenderName: body".
  withApp((t) => {
    t.rebuildNodeIndex([T114_ZEH]);
    // node is already hydrated — ingestor resolved from_id via contacts
    const div = t.createMessageChatEntry(makeMeshcoreChannelMsg('T114-Zeh: Test message', { rx_time: 5000, node: T114_ZEH }));
    const html = innerHtml(div);
    // Only the body text after the colon is shown; sender long name is not prepended as a link
    assert.ok(html.includes('Test message'), 'body text after colon should be rendered');
    assert.ok(!html.includes('T114-Zeh:'), 'sender long name prefix with colon should not appear in body');
  });
});

test('createMessageChatEntry: meshtastic message with @[Name] is NOT resolved as mention', () => {
  withApp((t) => {
    t.rebuildNodeIndex([
      { node_id: '!11111111', long_name: 'Alice', short_name: 'ALCE', role: 'CLIENT', protocol: 'meshtastic' },
    ]);
    const div = t.createMessageChatEntry({
      text: 'hello @[Alice]',
      rx_time: 4000,
      protocol: 'meshtastic',
      node: { short_name: 'ALCE', role: 'CLIENT', protocol: 'meshtastic' },
    });
    const html = innerHtml(div);
    // Meshtastic messages do not process @[Name] — rendered as literal escaped text
    assert.ok(html.includes('@[Alice]') || html.includes('@&#x5B;Alice&#x5D;') || html.includes('@&#91;Alice&#93;') || html.includes('@[Alice]'),
      'meshtastic @[Name] should be escaped literally, not resolved');
    // Ensure no mention badge was injected (no extra short-name span beyond the sender badge)
    const shortNameCount = (html.match(/short-name/g) || []).length;
    assert.ok(shortNameCount <= 1, 'only the sender badge should be present, no mention badge');
  });
});

// --- renderShortHtml badge padding ---

test('renderShortHtml leaves 4-char ASCII names unpadded', () => {
  withApp(() => {
    const html = globalThis.PotatoMesh.renderShortHtml('0ac7', 'CLIENT');
    assert.ok(!html.includes('&nbsp;0ac7'), 'should not add leading space');
    assert.ok(!html.includes('0ac7&nbsp;'), 'should not add trailing space');
  });
});

test('renderShortHtml adds single space padding for short emoji names', () => {
  withApp(() => {
    const html = globalThis.PotatoMesh.renderShortHtml('\u26A1', 'CLIENT');
    // Should produce " ⚡ " — one leading, one trailing space (as &nbsp;)
    assert.ok(html.includes('&nbsp;\u26A1&nbsp;'), 'emoji should have one space on each side');
    // Should NOT have double leading spaces
    assert.ok(!html.includes('&nbsp;&nbsp;\u26A1'), 'should not double-pad emoji');
  });
});

test('renderShortHtml adds single space padding for surrogate pair emoji', () => {
  withApp(() => {
    const html = globalThis.PotatoMesh.renderShortHtml('\uD83D\uDE43', 'CLIENT');
    // 🙃 is a surrogate pair (length 2 in JS) but 1 grapheme
    assert.ok(html.includes('&nbsp;\uD83D\uDE43&nbsp;'), 'surrogate emoji should have one space on each side');
  });
});

test('renderShortHtml adds single space padding for ZWJ emoji sequence', () => {
  withApp(() => {
    const zwj = '\u{1F3C3}\u{200D}\u{2642}\u{FE0F}'; // 🏃‍♂️ — length 5, 1 grapheme
    const html = globalThis.PotatoMesh.renderShortHtml(zwj, 'CLIENT');
    assert.ok(html.includes(`&nbsp;${zwj}&nbsp;`), 'ZWJ emoji should have one space on each side');
  });
});

test('renderShortHtml adds single space padding for plain 2-char name', () => {
  withApp(() => {
    const html = globalThis.PotatoMesh.renderShortHtml('ab', 'CLIENT');
    assert.ok(html.includes('&nbsp;ab&nbsp;'), '2-char name should have one space on each side');
  });
});
