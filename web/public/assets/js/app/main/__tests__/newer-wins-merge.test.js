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

/**
 * Unit tests for `main/newer-wins-merge.js` (SPEC CC6): on a key collision
 * the row with the newer own time wins; ties and rows without a time keep
 * the incoming row; order and identity of the held rows are kept.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeNewer, mergeNewerById, mergeNewerByCompositeKey } from '../newer-wins-merge.js';

test('nothing incoming returns the held rows themselves', () => {
  const held = [{ id: 1, rx_time: 5 }];
  assert.equal(mergeNewerById(held, [], 'id', 'rx_time'), held);
  assert.equal(mergeNewerById(held, null, 'id', 'rx_time'), held);
  assert.equal(mergeNewerById(held, undefined, 'id', 'rx_time'), held);
});

test('an older incoming row loses a collision; a newer one or a tie replaces', () => {
  const a = { node_id: '!a', last_heard: 100, name: 'held' };
  const b = { node_id: '!b', last_heard: 100, name: 'held' };
  const c = { node_id: '!c', last_heard: 100, name: 'held' };
  const merged = mergeNewerById([a, b, c], [
    { node_id: '!a', last_heard: 40, name: 'late' },
    { node_id: '!b', last_heard: 120, name: 'newer' },
    { node_id: '!c', last_heard: 100, name: 'tie' },
  ], 'node_id', 'last_heard');
  assert.equal(merged[0], a, 'the held row stays, as the same object');
  assert.deepEqual(merged.map(row => row.name), ['held', 'newer', 'tie']);
});

test('a row without a usable time replaces, as mergeById did', () => {
  const merged = mergeNewerById([{ id: 1, rx_time: 9, v: 'held' }, { id: 2, v: 'held' }], [
    { id: 1, v: 'no time' },
    { id: 2, rx_time: 3, v: 'timed' },
    { id: 3, rx_time: '7', v: 'string time' },
  ], 'id', 'rx_time');
  assert.deepEqual(merged.map(row => row.v), ['no time', 'timed', 'string time']);
});

test('held keys keep their place; new keys follow in arrival order; null keys drop', () => {
  const merged = mergeNewerById(
    [{ id: 2, rx_time: 1 }, { rx_time: 1 }, { id: 1, rx_time: 1 }],
    [{ id: 3, rx_time: 1 }, { id: 1, rx_time: 2 }, { id: null, rx_time: 9 }, { id: 0, rx_time: 1 }],
    'id',
    'rx_time',
  );
  assert.deepEqual(merged.map(row => row.id), [2, 1, 3, 0]);
});

test('the composite form keys on every field and drops no row', () => {
  const held = [{ node_id: '!a', neighbor_id: '!b', rx_time: 50, snr: 1 }];
  const merged = mergeNewerByCompositeKey(held, [
    { node_id: '!a', neighbor_id: '!b', rx_time: 10, snr: 9 },
    { node_id: '!a', neighbor_id: '!c', rx_time: 10, snr: 2 },
    { node_id: '!a', rx_time: 10, snr: 3 },
  ], ['node_id', 'neighbor_id'], 'rx_time');
  assert.equal(merged[0], held[0], 'the older pair row lost');
  assert.deepEqual(merged.map(row => row.snr), [1, 2, 3]);
});

test('mergeNewer takes any key function', () => {
  const merged = mergeNewer([{ k: 'x', t: 5 }], [{ k: 'X', t: 4 }, { k: 'y', t: 1 }], row => row.k.toLowerCase(), 't');
  assert.deepEqual(merged, [{ k: 'x', t: 5 }, { k: 'y', t: 1 }]);
});
