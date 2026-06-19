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

import { renderChatEntryContent } from '../chat-entry-renderer.js';

// Shared simple mocks used across the tests below.
const esc = v => `ESC(${v})`;
const emoji = v => `EMOJI(${v})`;
const renderShortHtml = (short, role, long /*, source */) => `SHORT(${short ?? '?'}|${role ?? '-'}|${long ?? '-'})`;

function makeNode(overrides = {}) {
  return {
    node_id: '!aabbccdd',
    short_name: 'AL',
    long_name: 'Alice',
    role: 'CLIENT',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MeshCore leading @[Name] as reply (#727 — issue 1)
// ---------------------------------------------------------------------------

test('renderChatEntryContent: MeshCore channel leading @[Name] becomes reply prefix', () => {
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice', protocol: 'meshcore' });
  const bob = makeNode({ node_id: '!22222222', short_name: 'BO', long_name: 'Bob', protocol: 'meshcore' });
  const nodesById = new Map([
    [alice.node_id, alice],
    [bob.node_id, bob],
  ]);
  const message = {
    text: 'Bob: @[Alice] thanks!',
    protocol: 'meshcore',
    to_id: '^all',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('chat-entry-reply'), 'should include reply prefix span');
  assert.ok(html.includes('ESC(in reply to)'), 'reply prefix label should be escaped');
  assert.ok(html.includes('SHORT(AL|CLIENT|Alice)'), 'reply target should be rendered as short name badge');
  // The @[Alice] should NOT appear inline as a mention badge — it has been
  // consumed into the reply prefix.  The remaining text is "thanks!".
  assert.ok(html.includes('ESC(thanks!)'), 'remaining text should appear');
  // Exactly one SHORT(...) appearance: the reply badge (mention was absorbed).
  assert.equal((html.match(/SHORT\(/g) ?? []).length, 1);
});

test('renderChatEntryContent: MeshCore channel leading @[Name] handles name whitespace', () => {
  const timo = makeNode({ node_id: '!6aee769f', short_name: 'TI', long_name: '\u{1F4FA} Timo +', protocol: 'meshcore' });
  const nodesById = new Map([[timo.node_id, timo]]);
  const message = {
    text: 'Bob: @[ Timo +] vielleicht hat jemand einen tip',
    protocol: 'meshcore',
    to_id: '^all',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  // Should resolve despite leading space + emoji prefix on the registry name.
  assert.ok(html.includes('chat-entry-reply'));
  assert.ok(html.includes('SHORT(TI|CLIENT'), 'Timo + should be resolved via fallback match');
  assert.ok(html.includes('ESC(vielleicht hat jemand einen tip)'));
});

test('renderChatEntryContent: MeshCore multi-mention body does NOT emit reply prefix', () => {
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice', protocol: 'meshcore' });
  const bob = makeNode({ node_id: '!22222222', short_name: 'BO', long_name: 'Bob', protocol: 'meshcore' });
  const nodesById = new Map([[alice.node_id, alice], [bob.node_id, bob]]);
  const message = {
    text: 'X: @[Alice] and @[Bob] both',
    protocol: 'meshcore',
    to_id: '^all',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(!html.includes('chat-entry-reply'), 'multi-mention should not trigger reply prefix');
  // Both mentions render as inline badges.
  assert.ok(html.includes('SHORT(AL|CLIENT|Alice)'));
  assert.ok(html.includes('SHORT(BO|CLIENT|Bob)'));
});

test('renderChatEntryContent: MeshCore reply does not quote a same-named Meshtastic node (protocol collision)', () => {
  // A Meshtastic and a MeshCore node share the long name "Timo".  The
  // Meshtastic node is inserted first, so the protocol-blind lookup returns it.
  // A MeshCore message quoting @[Timo] must badge the MeshCore node, never the
  // Meshtastic one.
  const meshtastic = makeNode({ node_id: '!10000001', short_name: 'MTMT', long_name: 'Timo', role: 'ROUTER', protocol: 'meshtastic' });
  const meshcore = makeNode({ node_id: '!20000002', short_name: 'MCMC', long_name: 'Timo', role: 'CLIENT', protocol: 'meshcore' });
  const nodesById = new Map([
    [meshtastic.node_id, meshtastic],
    [meshcore.node_id, meshcore],
  ]);
  const message = { text: 'X: @[Timo] thanks!', protocol: 'meshcore', to_id: '^all' };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('chat-entry-reply'), 'leading mention becomes a reply prefix');
  assert.ok(html.includes('SHORT(MCMC|CLIENT|Timo)'), 'reply target must be the MeshCore node');
  assert.ok(!html.includes('MTMT'), 'reply must NOT quote the same-named Meshtastic node');
});

test('renderChatEntryContent: MeshCore mention synthesises a node when only a same-named Meshtastic node exists', () => {
  // Only a Meshtastic "Timo" is in the registry.  A MeshCore message must NOT
  // quote it; instead a synthetic MeshCore-stamped badge carrying the name is
  // rendered (issue: don't quote meshtastic nodes in a meshcore message).
  const meshtastic = makeNode({ node_id: '!10000001', short_name: 'MTMT', long_name: 'Timo', role: 'ROUTER', protocol: 'meshtastic' });
  const nodesById = new Map([[meshtastic.node_id, meshtastic]]);
  const message = { text: 'X: hi @[Timo] and @[Timo]', protocol: 'meshcore', to_id: '^all' };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('SHORT(Timo|-|Timo)'), 'mention renders a synthetic node badge carrying the name');
  assert.ok(!html.includes('MTMT'), 'mention must NOT resolve to the same-named Meshtastic node');
});

test('renderChatEntryContent: leading mention with unresolved node surfaces a reply prefix using a synthetic node badge (#727)', () => {
  // Production deployments cap ``/api/nodes`` at 1000 entries, so the global
  // registry can be missing nodes that recent messages reference.  In that
  // case the leading-mention-as-reply detection still emits a reply prefix, now
  // backed by a protocol-stamped synthetic node badge (never a bare
  // ``@[Name] body...`` leak, and never a same-named node from another protocol).
  const nodesById = new Map();
  const message = {
    text: 'X: @[DA6ML/p] ja, klingt sehr gut',
    protocol: 'meshcore',
    to_id: '^all',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('chat-entry-reply'), 'should include a reply prefix even without a node match');
  assert.ok(html.includes('ESC(in reply to)'), 'reply prefix label is escaped');
  assert.ok(html.includes('SHORT(DA6ML/p|-|DA6ML/p)'), 'mention renders as a synthetic node badge carrying the name');
  assert.ok(html.includes('ESC(ja, klingt sehr gut)'), 'remaining text rendered after the prefix');
  // The bare ``@[Name]`` form must NOT survive into the body.
  assert.ok(!html.includes('@[ESC('), 'unresolved mention should not leak into the body');
});

test('renderChatEntryContent: inline (non-leading) unresolved mentions render as synthetic node badges', () => {
  // Mentions that are NOT at the start no longer fall back to an escaped
  // ``@[Name]`` literal; they render a protocol-stamped synthetic node badge so
  // the mention is honored without borrowing a node from another protocol.
  const nodesById = new Map();
  const message = {
    text: 'X: hello @[Unknown] there',
    protocol: 'meshcore',
    to_id: '^all',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(!html.includes('chat-entry-reply'), 'mid-text mention must not become reply prefix');
  assert.ok(html.includes('SHORT(Unknown|-|Unknown)'), 'unresolved inline mention renders a synthetic node badge');
  assert.ok(!html.includes('@[ESC(Unknown)]'), 'bare escaped literal must not survive');
});

test('renderChatEntryContent: MeshCore DM leading mention also becomes reply prefix', () => {
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice' });
  const nodesById = new Map([[alice.node_id, alice]]);
  const message = {
    text: '@[Alice] private reply',
    protocol: 'meshcore',
    to_id: '!22222222', // DM target, not ^all
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('chat-entry-reply'), 'DM should also get reply prefix when leading mention resolves');
  assert.ok(html.includes('ESC(private reply)'));
});

// ---------------------------------------------------------------------------
// Structured reply_id prefix (Meshtastic)
// ---------------------------------------------------------------------------

test('renderChatEntryContent: Meshtastic reply_id takes precedence over mention detection', () => {
  const parent = makeNode({ node_id: '!11111111', short_name: 'PA', long_name: 'Parent' });
  const nodesById = new Map([[parent.node_id, parent]]);
  const parentMsg = { id: 7029, node_id: parent.node_id, node: parent };
  const messagesById = new Map([['7029', parentMsg]]);

  const message = {
    id: 8000,
    reply_id: 7029,
    text: 'ok got it',
    protocol: 'meshtastic',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById,
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(html.includes('chat-entry-reply'));
  assert.ok(html.includes('SHORT(PA|CLIENT|Parent)'));
  assert.ok(html.includes('ESC(ok got it)'));
});

// ---------------------------------------------------------------------------
// Non-MeshCore messages: no mention rendering
// ---------------------------------------------------------------------------

test('renderChatEntryContent: Meshtastic messages do NOT render @[Name] as badges', () => {
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice' });
  const nodesById = new Map([[alice.node_id, alice]]);
  const message = {
    text: 'look at @[Alice] here',
    protocol: 'meshtastic',
  };

  const { html } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  // Meshtastic does not carry @[Name] mentions, so the text is escaped literal.
  assert.ok(!html.includes('SHORT(AL'), 'no mention badge for non-MeshCore protocol');
  assert.ok(html.includes('ESC(look at @[Alice] here)'), 'literal text should be escaped verbatim');
});

// ---------------------------------------------------------------------------
// Encrypted messages
// ---------------------------------------------------------------------------

test('renderChatEntryContent: encrypted message uses notice formatter when provided', () => {
  const message = { encrypted: true, text: 'GAA=', protocol: 'meshtastic' };
  const { html } = renderChatEntryContent({
    message,
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    formatEncryptedMessageNotice: () => ({ content: '[encrypted]', isHtml: false }),
  });
  assert.equal(html, 'ESC([encrypted])');
});

test('renderChatEntryContent: encrypted message without notice formatter returns empty', () => {
  const message = { encrypted: true, text: 'GAA=', protocol: 'meshtastic' };
  const { html } = renderChatEntryContent({
    message,
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });
  assert.equal(html, '');
});

// ---------------------------------------------------------------------------
// meshcoreSenderNode fallback return value
// ---------------------------------------------------------------------------

test('renderChatEntryContent: returns meshcoreSenderNode when prefix resolves against registry', () => {
  const sender = makeNode({ node_id: '!11111111', short_name: 'SN', long_name: 'Sender', protocol: 'meshcore' });
  const nodesById = new Map([[sender.node_id, sender]]);
  const message = {
    text: 'Sender: hello everyone',
    protocol: 'meshcore',
    to_id: '^all',
    // Note: no `.node` — simulates ingestor not hydrating the sender.
  };

  const { parsedMeshcorePrefix, meshcoreSenderNode } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  assert.ok(parsedMeshcorePrefix);
  assert.equal(parsedMeshcorePrefix.senderName, 'Sender');
  assert.equal(meshcoreSenderNode, sender);
});

test('renderChatEntryContent: does not perform sender lookup when message.node is set', () => {
  const hydrated = makeNode({ node_id: '!existing', short_name: 'HY', long_name: 'Sender' });
  const registry = makeNode({ node_id: '!otherid', short_name: 'XX', long_name: 'Sender' });
  const nodesById = new Map([[registry.node_id, registry]]);
  const message = {
    text: 'Sender: hi',
    protocol: 'meshcore',
    to_id: '^all',
    node: hydrated,
  };

  const { meshcoreSenderNode } = renderChatEntryContent({
    message,
    nodesById,
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });

  // When the ingestor already hydrated message.node, the helper should NOT
  // override it via a name-based lookup.
  assert.equal(meshcoreSenderNode, null);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('renderChatEntryContent: non-object message returns empty html', () => {
  const result = renderChatEntryContent({
    message: null,
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });
  assert.equal(result.html, '');
});

test('renderChatEntryContent: throws when escapeHtml is not a function', () => {
  assert.throws(() => renderChatEntryContent({
    message: { text: 'hi' },
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: null,
    renderEmojiHtml: emoji,
  }), TypeError);
});

test('renderChatEntryContent: throws when renderShortHtml is not a function', () => {
  assert.throws(() => renderChatEntryContent({
    message: { text: 'hi' },
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml: null,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  }), TypeError);
});

test('renderChatEntryContent: throws when renderEmojiHtml is not a function', () => {
  assert.throws(() => renderChatEntryContent({
    message: { text: 'hi' },
    nodesById: new Map(),
    messagesById: new Map(),
    renderShortHtml,
    escapeHtml: esc,
    renderEmojiHtml: null,
  }), TypeError);
});
