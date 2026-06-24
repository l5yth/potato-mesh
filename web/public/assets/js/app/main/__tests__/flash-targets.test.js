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

import { collectNodeIds, collectMessageIds, entryMessageId } from '../flash-targets.js';

test('collectNodeIds flattens and de-duplicates node_id across arrays', () => {
  const nodes = [{ node_id: '!a' }, { node_id: '!b' }];
  const positions = [{ node_id: '!b' }, { node_id: '!c' }];
  const telemetry = [{ node_id: '!a' }];
  const ids = collectNodeIds(nodes, positions, telemetry);
  assert.deepEqual([...ids].sort(), ['!a', '!b', '!c']);
});

test('collectNodeIds ignores non-array inputs and rows without a string node_id', () => {
  const ids = collectNodeIds(
    null,
    undefined,
    'not-an-array',
    [{ node_id: '!a' }, { node_id: 42 }, {}, null, { node_id: '' }],
  );
  assert.deepEqual([...ids], ['!a']);
});

test('collectNodeIds returns an empty set when nothing matches', () => {
  assert.equal(collectNodeIds().size, 0);
  assert.equal(collectNodeIds([], [{}]).size, 0);
});

test('collectMessageIds collects string ids from plaintext + encrypted deltas', () => {
  const plain = [{ id: 1 }, { id: 2 }];
  const encrypted = [{ id: 2 }, { id: 3 }];
  assert.deepEqual([...collectMessageIds(plain, encrypted)].sort(), ['1', '2', '3']);
});

test('collectMessageIds ignores non-arrays and rows without an id', () => {
  assert.deepEqual([...collectMessageIds(null, [{ id: '' }, {}, { id: 7 }])], ['7']);
  assert.equal(collectMessageIds().size, 0);
});

test('collectMessageIds + entryMessageId honor message_id / messageId fallbacks', () => {
  assert.deepEqual([...collectMessageIds([{ message_id: 5 }, { messageId: 6 }])], ['5', '6']);
  assert.equal(entryMessageId({ item: { message_id: 7 } }), '7');
  assert.equal(entryMessageId({ message: { messageId: 8 } }), '8');
});

test('entryMessageId reads a channel-tab item, a Log-tab message, or neither', () => {
  assert.equal(entryMessageId({ item: { id: 5 } }), '5'); // channel tab
  assert.equal(entryMessageId({ message: { id: 9 } }), '9'); // Log tab
  assert.equal(entryMessageId({ type: 'position', nodeId: '!a' }), null); // non-message
  assert.equal(entryMessageId(null), null);
  assert.equal(entryMessageId({ item: { id: '' } }), null);
});
