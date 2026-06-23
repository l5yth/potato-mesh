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

import { cacheKeyFor } from '../cache-keys.js';

test('nodes key on the canonical node id (snake or camel)', () => {
  assert.equal(cacheKeyFor('nodes', { node_id: '!abc' }), '!abc');
  assert.equal(cacheKeyFor('nodes', { nodeId: '!def' }), '!def');
  assert.equal(cacheKeyFor('nodes', { id: 5 }), null); // nodes need node_id specifically
});

test('neighbors key on the composite node_id|neighbor_id', () => {
  assert.equal(cacheKeyFor('neighbors', { node_id: '!a', neighbor_id: '!b' }), '!a|!b');
  assert.equal(cacheKeyFor('neighbors', { nodeId: '!a', neighborId: '!b' }), '!a|!b');
  assert.equal(cacheKeyFor('neighbors', { node_id: '!a' }), null); // missing neighbor side
  assert.equal(cacheKeyFor('neighbors', { neighbor_id: '!b' }), null); // missing node side
});

test('other collections key on the record id', () => {
  assert.equal(cacheKeyFor('messages', { id: 7 }), '7');
  assert.equal(cacheKeyFor('messages', { message_id: 'm1' }), 'm1');
  assert.equal(cacheKeyFor('messages', { messageId: 'm2' }), 'm2');
  assert.equal(cacheKeyFor('positions', { id: 9 }), '9');
  assert.equal(cacheKeyFor('telemetry', {}), null);
});

test('non-object records have no key', () => {
  assert.equal(cacheKeyFor('nodes', null), null);
  assert.equal(cacheKeyFor('messages', undefined), null);
  assert.equal(cacheKeyFor('messages', 'x'), null);
});
