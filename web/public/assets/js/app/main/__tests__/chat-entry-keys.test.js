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

import { CHAT_LOG_ENTRY_TYPES } from '../../chat-log-tabs.js';
import { chatMessageEntryKey, chatLogEntryKey } from '../chat-entry-keys.js';

test('chatMessageEntryKey prefers the message id', () => {
  assert.equal(chatMessageEntryKey({ id: 42 }), 'msg:42');
  assert.equal(chatMessageEntryKey({ message_id: 'a1' }), 'msg:a1');
  assert.equal(chatMessageEntryKey({ messageId: 'b2' }), 'msg:b2');
});

test('chatMessageEntryKey falls back to a composite when id is absent or blank', () => {
  assert.equal(
    chatMessageEntryKey({ rx_time: 100, from_id: '!x', text: 'hi' }),
    'msg:100:!x:hi',
  );
  // An empty-string id is treated as absent.
  assert.equal(
    chatMessageEntryKey({ id: '', rxTime: 7, fromId: '!y', text: 'yo' }),
    'msg:7:!y:yo',
  );
  // Missing composite fields collapse to empty segments.
  assert.equal(chatMessageEntryKey({}), 'msg:::');
});

test('chatMessageEntryKey tolerates non-object input', () => {
  assert.equal(chatMessageEntryKey(null), 'msg:');
  assert.equal(chatMessageEntryKey('nope'), 'msg:');
});

test('chatLogEntryKey reuses the message key for encrypted entries', () => {
  const entry = { type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, message: { id: 9 } };
  assert.equal(chatLogEntryKey(entry), 'enc:msg:9');
});

test('chatLogEntryKey builds a type/node/ts/neighbor/reason key for announcements', () => {
  assert.equal(
    chatLogEntryKey({ type: CHAT_LOG_ENTRY_TYPES.NODE_NEW, nodeId: '!abc', ts: 123 }),
    'log:node-new:!abc:123::',
  );
  // Neighbor id read directly off the entry.
  assert.equal(
    chatLogEntryKey({ type: 'neighbor', nodeId: '!a', ts: 1, neighborId: '!b' }),
    'log:neighbor:!a:1:!b:',
  );
  // Neighbor id read from the nested neighbor payload.
  assert.equal(
    chatLogEntryKey({ type: 'neighbor', nodeId: '!a', ts: 1, neighbor: { neighbor_id: '!c' } }),
    'log:neighbor:!a:1:!c:',
  );
});

test('chatLogEntryKey distinguishes node-info entries by reason', () => {
  // Same node + timestamp but different reasons must not collide in the cache.
  const base = { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, nodeId: '!a', ts: 7 };
  assert.equal(chatLogEntryKey({ ...base, reason: 'advert' }), 'log:node-info:!a:7::advert');
  assert.equal(chatLogEntryKey({ ...base, reason: 'message' }), 'log:node-info:!a:7::message');
  assert.notEqual(
    chatLogEntryKey({ ...base, reason: 'advert' }),
    chatLogEntryKey({ ...base, reason: 'message' }),
  );
});

test('chatLogEntryKey defaults missing fields to empty segments', () => {
  assert.equal(chatLogEntryKey({}), 'log:::::');
});

test('chatLogEntryKey tolerates non-object input', () => {
  assert.equal(chatLogEntryKey(null), 'log:');
  assert.equal(chatLogEntryKey(7), 'log:');
});

test('chatLogEntryKey without a message on an encrypted entry uses the generic key', () => {
  // No ``message`` → falls through to the generic announcement key path.
  const entry = { type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, nodeId: '!z', ts: 5 };
  assert.equal(chatLogEntryKey(entry), `log:${CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED}:!z:5::`);
});
