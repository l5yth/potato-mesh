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

import {
  buildMessageBody,
  buildMessageIndex,
  normaliseEmojiValue,
  normaliseMessageId,
  renderLiteralWithLinks,
  resolveReplyPrefix
} from '../message-replies.js';

test('normaliseMessageId coerces numeric identifiers', () => {
  assert.equal(normaliseMessageId(42), '42');
  assert.equal(normaliseMessageId(' 0042 '), '42');
  assert.equal(normaliseMessageId('alpha'), 'alpha');
  assert.equal(normaliseMessageId(null), null);
});

test('buildMessageIndex normalises identifiers and ignores duplicates', () => {
  const messages = [
    { id: '001', text: 'first' },
    { packet_id: 1, text: 'second' },
    { id: '2', text: 'third' }
  ];
  const index = buildMessageIndex(messages);
  assert.equal(index.size, 2);
  assert.equal(index.get('1'), messages[0]);
  assert.equal(index.get('2'), messages[2]);
});

test('resolveReplyPrefix renders reply badge and buildMessageBody joins emoji', () => {
  const parent = {
    id: 99,
    node: { short_name: 'BEEF', long_name: 'Parent Node', role: 'CLIENT' },
    text: 'parent message'
  };
  const reaction = { id: 100, reply_id: 99, emoji: '🔥' };
  const index = buildMessageIndex([parent, reaction]);

  const prefix = resolveReplyPrefix({
    message: reaction,
    messagesById: index,
    nodesById: new Map(),
    renderShortHtml: (short, role, longName) => `SHORT(${short}|${role}|${longName})`,
    escapeHtml: value => `ESC(${value})`
  });

  assert.equal(
    prefix,
    '<span class="chat-entry-reply">[ESC(in reply to) SHORT(BEEF|CLIENT|Parent Node)]</span>'
  );

  const body = buildMessageBody({
    message: { text: 'Hello', emoji: ' 🔥 ' },
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(body, 'ESC(Hello) EMOJI(🔥)');
});

test('buildMessageBody suppresses reaction slot markers and formats counts', () => {
  const reaction = {
    text: ' 1 ',
    emoji: '👍',
    portnum: 'REACTION_APP',
    reply_id: 123,
  };
  const body = buildMessageBody({
    message: reaction,
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(body, 'EMOJI(👍)');

  const countedReaction = {
    text: '2',
    emoji: '✨',
    reply_id: 123
  };
  const countedBody = buildMessageBody({
    message: countedReaction,
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(countedBody, 'EMOJI(✨) ESC(×2)');
});

test('buildMessageBody treats REACTION_APP packets without reply identifiers as reactions', () => {
  const reactionAppPacket = {
    text: '1',
    emoji: '🚀',
    portnum: 'REACTION_APP'
  };

  const body = buildMessageBody({
    message: reactionAppPacket,
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(body, 'EMOJI(🚀)');
});

test('buildMessageBody renders reaction emoji from text when emoji field carries placeholder counts', () => {
  const placeholderEmojiMessage = {
    text: '💩',
    emoji: '1',
    reply_id: 98822809,
    portnum: 'TEXT_MESSAGE_APP'
  };

  const body = buildMessageBody({
    message: placeholderEmojiMessage,
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(body, 'EMOJI(💩)');
});

test('buildMessageBody appends reaction counts for REACTION_APP packets without reply identifiers', () => {
  const countedReactionAppPacket = {
    text: '2',
    emoji: '🌶',
    portnum: 'REACTION_APP'
  };

  const body = buildMessageBody({
    message: countedReactionAppPacket,
    escapeHtml: value => `ESC(${value})`,
    renderEmojiHtml: value => `EMOJI(${value})`
  });

  assert.equal(body, 'EMOJI(🌶) ESC(×2)');
});

// ---------------------------------------------------------------------------
// buildMessageBody — renderMentionHtml callback
// ---------------------------------------------------------------------------

// Shared mock helpers reused across the mention-callback tests below.
const esc = v => `ESC(${v})`;
const emoji = v => `EMOJI(${v})`;
const badge = name => `BADGE(${name})`;

test('buildMessageBody throws TypeError when renderMentionHtml is not a function', () => {
  assert.throws(
    () => buildMessageBody({
      message: { text: 'hello' },
      escapeHtml: v => v,
      renderEmojiHtml: v => v,
      renderMentionHtml: 42,
    }),
    { name: 'TypeError', message: 'renderMentionHtml must be a function when provided' }
  );
});

test('buildMessageBody without renderMentionHtml escapes @[Name] literally', () => {
  const body = buildMessageBody({
    message: { text: 'hello @[Alice]' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
  });
  assert.equal(body, 'ESC(hello @[Alice])');
});

test('buildMessageBody with renderMentionHtml replaces single @[Name] mention', () => {
  const body = buildMessageBody({
    message: { text: 'hi @[Alice] there' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: badge,
  });
  assert.equal(body, 'ESC(hi )BADGE(Alice)ESC( there)');
});

test('buildMessageBody with renderMentionHtml handles multiple mentions', () => {
  const calls = [];
  const body = buildMessageBody({
    message: { text: '@[A] and @[B]' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: (name) => { calls.push(name); return `BADGE(${name})`; },
  });
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(body, 'BADGE(A)ESC( and )BADGE(B)');
});

test('buildMessageBody trims mention name whitespace before callback (#727)', () => {
  const calls = [];
  const body = buildMessageBody({
    message: { text: '@[ Timo +] hello' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: (name) => { calls.push(name); return `BADGE(${name})`; },
  });
  // The callback should receive the trimmed mention name so that whitespace
  // typed by MeshCore users (e.g. "@[ Timo +]" or "@[T-deck NK ]") matches
  // the canonical long name stored on the node record.
  assert.deepEqual(calls, ['Timo +']);
  assert.equal(body, 'BADGE(Timo +)ESC( hello)');
});

test('buildMessageBody trims trailing whitespace in mention name (#727)', () => {
  const calls = [];
  buildMessageBody({
    message: { text: '@[T-deck NK ] ping' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: (name) => { calls.push(name); return `BADGE(${name})`; },
  });
  assert.deepEqual(calls, ['T-deck NK']);
});

test('buildMessageBody with renderMentionHtml escapes literal segments', () => {
  const body = buildMessageBody({
    message: { text: '<b> @[Alice]' },
    escapeHtml: v => v.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    renderEmojiHtml: emoji,
    renderMentionHtml: badge,
  });
  assert.equal(body, '&lt;b&gt; BADGE(Alice)');
});

test('buildMessageBody with renderMentionHtml at start of text', () => {
  const body = buildMessageBody({
    message: { text: '@[Alice] hello' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: badge,
  });
  assert.equal(body, 'BADGE(Alice)ESC( hello)');
});

test('buildMessageBody with renderMentionHtml at end of text', () => {
  const body = buildMessageBody({
    message: { text: 'hello @[Alice]' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: badge,
  });
  assert.equal(body, 'ESC(hello )BADGE(Alice)');
});

test('buildMessageBody with renderMentionHtml: no mentions, callback not invoked', () => {
  let called = false;
  const body = buildMessageBody({
    message: { text: 'plain text' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: () => { called = true; return 'BADGE'; },
  });
  assert.equal(called, false);
  assert.equal(body, 'ESC(plain text)');
});

test('buildMessageBody with renderMentionHtml: null renderMentionHtml behaves like no callback', () => {
  const body = buildMessageBody({
    message: { text: 'hi @[Alice]' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: null,
  });
  assert.equal(body, 'ESC(hi @[Alice])');
});

test('buildMessageBody reaction path unaffected by renderMentionHtml', () => {
  const reaction = { text: '1', emoji: '👍', portnum: 'REACTION_APP' };
  let called = false;
  const body = buildMessageBody({
    message: reaction,
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: () => { called = true; return 'BADGE'; },
  });
  assert.equal(called, false);
  assert.equal(body, 'EMOJI(👍)');
});

test('buildMessageBody with renderMentionHtml: unclosed @[ treated as literal', () => {
  const body = buildMessageBody({
    message: { text: 'hello @[unclosed' },
    escapeHtml: esc,
    renderEmojiHtml: emoji,
    renderMentionHtml: () => 'BADGE',
  });
  // @[ without closing ] does not match the pattern — treated as literal
  assert.equal(body, 'ESC(hello @[unclosed)');
});

// ---------------------------------------------------------------------------
// renderLiteralWithLinks — URL detection
// ---------------------------------------------------------------------------

const e = v => `E(${v})`;

test('renderLiteralWithLinks passes plain text through escapeHtml', () => {
  assert.equal(renderLiteralWithLinks('hello world', e), 'E(hello world)');
});

test('renderLiteralWithLinks wraps http:// URL in an anchor element', () => {
  const result = renderLiteralWithLinks('check http://example.com out', e);
  assert.equal(result, 'E(check )<a href="E(http://example.com)" target="_blank" rel="noopener noreferrer">E(http://example.com)</a>E( out)');
});

test('renderLiteralWithLinks wraps https:// URL in an anchor element', () => {
  const result = renderLiteralWithLinks('see https://example.com/path?q=1', e);
  assert.ok(result.includes('<a href='), 'should produce an anchor');
  assert.ok(result.includes('target="_blank"'), 'should open in new tab');
  assert.ok(result.includes('rel="noopener noreferrer"'), 'should include noopener rel');
});

test('renderLiteralWithLinks strips trailing period from URL', () => {
  const result = renderLiteralWithLinks('visit https://example.com.', e);
  assert.ok(result.includes('href="E(https://example.com)"'), 'period should not be in href');
  assert.ok(result.includes('>E(https://example.com)<'), 'period should not be in link text');
  assert.ok(result.endsWith('E(.)'), 'trailing period should appear as escaped text after the link');
});

test('renderLiteralWithLinks strips trailing comma from URL', () => {
  const result = renderLiteralWithLinks('go to https://example.com, then stop', e);
  assert.ok(result.includes('href="E(https://example.com)"'), 'comma must not be in href');
});

test('renderLiteralWithLinks handles URL at the start of text', () => {
  const result = renderLiteralWithLinks('https://example.com is great', e);
  assert.ok(result.startsWith('<a href='), 'anchor should be at start');
  assert.ok(result.endsWith('E( is great)'), 'text after URL should be escaped');
});

test('renderLiteralWithLinks handles URL at the end of text', () => {
  const result = renderLiteralWithLinks('see https://example.com', e);
  assert.ok(result.startsWith('E(see )'), 'text before URL should be escaped');
  assert.ok(result.includes('<a href='), 'URL should be linked');
});

test('renderLiteralWithLinks handles multiple URLs in text', () => {
  const result = renderLiteralWithLinks('a https://foo.com b https://bar.com c', e);
  const matches = result.match(/<a href=/g) || [];
  assert.equal(matches.length, 2, 'should produce two anchors');
});

test('renderLiteralWithLinks does not linkify non-http schemes', () => {
  const result = renderLiteralWithLinks('ftp://example.com', e);
  assert.ok(!result.includes('<a href='), 'ftp:// should not be linkified');
  assert.equal(result, 'E(ftp://example.com)');
});

test('renderLiteralWithLinks returns empty string for empty input', () => {
  assert.equal(renderLiteralWithLinks('', e), '');
});

test('buildMessageBody linkifies URLs in message text without renderMentionHtml', () => {
  const body = buildMessageBody({
    message: { text: 'visit https://example.com now' },
    escapeHtml: e,
    renderEmojiHtml: v => `EMOJI(${v})`,
  });
  assert.ok(body.includes('<a href='), 'URL should be linkified');
  assert.ok(body.includes('target="_blank"'), 'should open in new tab');
});

test('buildMessageBody linkifies URLs alongside @[Name] mentions', () => {
  const body = buildMessageBody({
    message: { text: '@[Alice] see https://example.com' },
    escapeHtml: e,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: name => `BADGE(${name})`,
  });
  assert.ok(body.startsWith('BADGE(Alice)'), 'mention should be rendered as badge');
  assert.ok(body.includes('<a href='), 'URL should be linkified');
});

// ---------------------------------------------------------------------------
// normaliseEmojiValue — codepoint conversion
// ---------------------------------------------------------------------------

test('normaliseEmojiValue converts integer codepoint above 127 to emoji', () => {
  assert.equal(normaliseEmojiValue(128077), '\u{1F44D}');
});

test('normaliseEmojiValue converts string codepoint above 127 to emoji', () => {
  assert.equal(normaliseEmojiValue('128077'), '\u{1F44D}');
});

test('normaliseEmojiValue preserves small integer as string', () => {
  assert.equal(normaliseEmojiValue(49), '49');
});

test('normaliseEmojiValue preserves small digit string as-is', () => {
  assert.equal(normaliseEmojiValue('1'), '1');
});

test('normaliseEmojiValue passes through emoji character unchanged', () => {
  assert.equal(normaliseEmojiValue('\u{1F44D}'), '\u{1F44D}');
});

test('normaliseEmojiValue returns null for null', () => {
  assert.equal(normaliseEmojiValue(null), null);
});

test('normaliseEmojiValue returns null for empty string', () => {
  assert.equal(normaliseEmojiValue(''), null);
});

// ---------------------------------------------------------------------------
// isReactionMessage — tightened classification (bug #699)
// ---------------------------------------------------------------------------

test('buildMessageBody does not treat reply with emoji and substantial text as reaction', () => {
  const message = {
    text: 'Great job!',
    emoji: '\u{1F44D}',
    reply_id: 123,
    portnum: 'TEXT_MESSAGE_APP'
  };
  const body = buildMessageBody({
    message,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`
  });
  // Text should be rendered as a normal message, not suppressed into a reaction.
  assert.ok(body.includes('ESC(Great job!)'), 'text content should be visible');
});

test('buildMessageBody treats reply with emoji and no text as reaction', () => {
  const message = {
    emoji: '\u{1F44D}',
    reply_id: 123,
  };
  const body = buildMessageBody({
    message,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`
  });
  assert.equal(body, 'EMOJI(\u{1F44D})');
});

test('buildMessageBody treats reply with emoji and whitespace text as reaction', () => {
  const message = {
    text: '   ',
    emoji: '\u{1F44D}',
    reply_id: 123,
  };
  const body = buildMessageBody({
    message,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`
  });
  assert.equal(body, 'EMOJI(\u{1F44D})');
});

test('buildMessageBody treats reply with emoji and digit text as reaction', () => {
  const message = {
    text: '3',
    emoji: '\u{2728}',
    reply_id: 456,
  };
  const body = buildMessageBody({
    message,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`
  });
  assert.equal(body, 'EMOJI(\u{2728}) ESC(\u00d73)');
});

test('buildMessageBody renders emoji from numeric codepoint in reaction', () => {
  const message = {
    text: '2',
    emoji: 128077,
    reply_id: 789,
    portnum: 'REACTION_APP'
  };
  const body = buildMessageBody({
    message,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`
  });
  assert.equal(body, 'EMOJI(\u{1F44D}) ESC(\u00d72)');
});
