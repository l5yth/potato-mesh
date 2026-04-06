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
  normaliseMessageId,
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
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
  });
  assert.equal(body, 'ESC(hello @[Alice])');
});

test('buildMessageBody with renderMentionHtml replaces single @[Name] mention', () => {
  const body = buildMessageBody({
    message: { text: 'hi @[Alice] there' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: name => `BADGE(${name})`,
  });
  assert.equal(body, 'ESC(hi )BADGE(Alice)ESC( there)');
});

test('buildMessageBody with renderMentionHtml handles multiple mentions', () => {
  const calls = [];
  const body = buildMessageBody({
    message: { text: '@[A] and @[B]' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: (name) => { calls.push(name); return `BADGE(${name})`; },
  });
  assert.deepEqual(calls, ['A', 'B']);
  assert.equal(body, 'BADGE(A)ESC( and )BADGE(B)');
});

test('buildMessageBody with renderMentionHtml escapes literal segments', () => {
  const body = buildMessageBody({
    message: { text: '<b> @[Alice]' },
    escapeHtml: v => v.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: name => `BADGE(${name})`,
  });
  assert.equal(body, '&lt;b&gt; BADGE(Alice)');
});

test('buildMessageBody with renderMentionHtml at start of text', () => {
  const body = buildMessageBody({
    message: { text: '@[Alice] hello' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: name => `BADGE(${name})`,
  });
  assert.equal(body, 'BADGE(Alice)ESC( hello)');
});

test('buildMessageBody with renderMentionHtml at end of text', () => {
  const body = buildMessageBody({
    message: { text: 'hello @[Alice]' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: name => `BADGE(${name})`,
  });
  assert.equal(body, 'ESC(hello )BADGE(Alice)');
});

test('buildMessageBody with renderMentionHtml: no mentions, callback not invoked', () => {
  let called = false;
  const body = buildMessageBody({
    message: { text: 'plain text' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: () => { called = true; return 'BADGE'; },
  });
  assert.equal(called, false);
  assert.equal(body, 'ESC(plain text)');
});

test('buildMessageBody with renderMentionHtml: null renderMentionHtml behaves like no callback', () => {
  const body = buildMessageBody({
    message: { text: 'hi @[Alice]' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: null,
  });
  assert.equal(body, 'ESC(hi @[Alice])');
});

test('buildMessageBody reaction path unaffected by renderMentionHtml', () => {
  const reaction = { text: '1', emoji: '👍', portnum: 'REACTION_APP' };
  let called = false;
  const body = buildMessageBody({
    message: reaction,
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: () => { called = true; return 'BADGE'; },
  });
  assert.equal(called, false);
  assert.equal(body, 'EMOJI(👍)');
});

test('buildMessageBody with renderMentionHtml: unclosed @[ treated as literal', () => {
  const body = buildMessageBody({
    message: { text: 'hello @[unclosed' },
    escapeHtml: v => `ESC(${v})`,
    renderEmojiHtml: v => `EMOJI(${v})`,
    renderMentionHtml: () => 'BADGE',
  });
  // @[ without closing ] does not match the pattern — treated as literal
  assert.equal(body, 'ESC(hello @[unclosed)');
});
