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

import { mergeChatMessages, __test__ } from '../chat-message-merge.js';

const { computeMessageIdentity, appendUniqueMessage, selectFirstTruthy } = __test__;

test('mergeChatMessages returns a cloned array when encrypted feed is empty', () => {
  const base = [{ id: 1, text: 'hello' }];
  const merged = mergeChatMessages(base, null);
  assert.deepEqual(merged, base);
  assert.notStrictEqual(merged, base);
});

test('mergeChatMessages appends encrypted-only entries and deduplicates by id', () => {
  const base = [
    { id: 1, text: 'hello' },
    { id: 2, text: 'world' }
  ];
  const encrypted = [
    { id: 2, encrypted: 'abc123' },
    { id: 3, encrypted: 'xyz789' }
  ];
  const merged = mergeChatMessages(base, encrypted);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map(entry => entry.id), [1, 2, 3]);
  assert.strictEqual(merged[1], base[1]);
  assert.strictEqual(merged[2], encrypted[1]);
});

test('mergeChatMessages deduplicates entries using fallback identity metadata', () => {
  const base = [
    { rx_time: 100, from_id: '!abcd', to_id: '!ef01', channel: 1, text: 'decrypted' }
  ];
  const encrypted = [
    { rx_time: 100, from_id: '!abcd', to_id: '!ef01', channel: 1, encrypted: 'secret' }
  ];
  const merged = mergeChatMessages(base, encrypted);
  assert.equal(merged.length, 1);
  assert.strictEqual(merged[0], base[0]);
});

test('computeMessageIdentity resolves identifiers and handles invalid input', () => {
  assert.equal(computeMessageIdentity(null), null);
  assert.equal(computeMessageIdentity(undefined), null);
  assert.equal(computeMessageIdentity('invalid'), null);
  assert.equal(computeMessageIdentity({}), null);
  assert.equal(computeMessageIdentity({ id: ' 42 ' }), 'id:42');
  assert.equal(
    computeMessageIdentity({ rx_time: 8, from_id: '!aaaa', to_id: '!bbbb', channel: 5 }),
    'tuple:8|!aaaa|!bbbb|5|||'
  );
});

test('appendUniqueMessage ignores invalid containers and respects identity registry', () => {
  const seen = new Set();
  const bucket = [];
  appendUniqueMessage(null, bucket, seen);
  appendUniqueMessage({ id: 1 }, bucket, {});
  appendUniqueMessage({ id: 1 }, null, seen);
  appendUniqueMessage({ id: 1 }, bucket, seen);
  appendUniqueMessage({ id: 1 }, bucket, seen);
  appendUniqueMessage({}, bucket, seen);
  assert.equal(bucket.length, 2);
  assert.equal(seen.has('id:1'), true);
  assert.deepEqual(bucket[1], {});
});

test('selectFirstTruthy handles non-array inputs and returns the first non-null value', () => {
  assert.equal(selectFirstTruthy(null), null);
  assert.equal(selectFirstTruthy(undefined), null);
  assert.equal(selectFirstTruthy('value'), null);
  assert.equal(selectFirstTruthy([]), null);
  assert.equal(selectFirstTruthy([null, undefined, 'first']), 'first');
});
