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
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice' });
  const bob = makeNode({ node_id: '!22222222', short_name: 'BO', long_name: 'Bob' });
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
  const timo = makeNode({ node_id: '!6aee769f', short_name: 'TI', long_name: '\u{1F4FA} Timo +' });
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
  const alice = makeNode({ node_id: '!11111111', short_name: 'AL', long_name: 'Alice' });
  const bob = makeNode({ node_id: '!22222222', short_name: 'BO', long_name: 'Bob' });
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

test('renderChatEntryContent: leading mention with unresolved node still surfaces a reply prefix using the raw name (#727)', () => {
  // Production deployments cap ``/api/nodes`` at 1000 entries, so the global
  // registry can be missing nodes that recent messages reference.  In that
  // case the leading-mention-as-reply detection must still emit a reply
  // prefix using the bare mention name, otherwise the body would render as
  // ``@[Name] body...`` and look like an unresolved mention link.
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
  assert.ok(html.includes('ESC(DA6ML/p)'), 'mention name is shown verbatim (escaped)');
  assert.ok(html.includes('ESC(ja, klingt sehr gut)'), 'remaining text rendered after the prefix');
  // The bare ``@[Name]`` form must NOT survive into the body.
  assert.ok(!html.includes('@[ESC('), 'unresolved mention should not leak into the body');
});

test('renderChatEntryContent: inline (non-leading) mentions still render as escaped literals when unresolved', () => {
  // Mentions that are NOT at the start are left as escaped literals — the
  // reply-prefix fallback only applies to leading-mention-as-reply.
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
  assert.ok(html.includes('@[ESC(Unknown)]'), 'unresolved inline mention falls back to escaped literal');
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
  const sender = makeNode({ node_id: '!11111111', short_name: 'SN', long_name: 'Sender' });
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
