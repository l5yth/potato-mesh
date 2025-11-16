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

  assert.equal(countedBody, 'ESC(×2) EMOJI(✨)');
});
