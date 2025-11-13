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
  SNAPSHOT_DEPTH,
  aggregateSnapshotSeries,
  hasSnapshotValue,
  __testUtils,
} from '../snapshot-aggregator.js';

const { defaultMergeStrategy } = __testUtils;

test('hasSnapshotValue rejects blanks but preserves zero-like values', () => {
  assert.equal(hasSnapshotValue(null), false);
  assert.equal(hasSnapshotValue(undefined), false);
  assert.equal(hasSnapshotValue(''), false);
  assert.equal(hasSnapshotValue('   '), false);
  assert.equal(hasSnapshotValue([]), false);
  assert.equal(hasSnapshotValue({}), false);

  assert.equal(hasSnapshotValue(0), true);
  assert.equal(hasSnapshotValue(false), true);
  assert.equal(hasSnapshotValue('hello'), true);
  assert.equal(hasSnapshotValue([1]), true);
  assert.equal(hasSnapshotValue({ key: 'value' }), true);
});

test('aggregateSnapshotSeries merges oldest-to-newest snapshots without losing data', () => {
  const snapshots = [
    { node_id: '!abc', battery_level: 80, voltage: 3.7, rx_time: 100 },
    { node_id: '!abc', battery_level: null, temperature: 21.5, rx_time: 200 },
    { node_id: '!abc', battery_level: 77, voltage: '', humidity: 53.2, rx_time: 300 },
  ];

  const aggregates = aggregateSnapshotSeries(snapshots, {
    keyFn: entry => entry.node_id,
    timestampFn: entry => entry.rx_time,
  });

  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0].key, '!abc');
  assert.deepEqual(aggregates[0].snapshots, snapshots);
  assert.deepEqual(aggregates[0].aggregate, {
    node_id: '!abc',
    battery_level: 77,
    voltage: 3.7,
    temperature: 21.5,
    humidity: 53.2,
    rx_time: 300,
  });
});

test('aggregateSnapshotSeries caps history depth and uses mergeStrategy override', () => {
  const calls = [];
  const mergeStrategy = snapshots => {
    calls.push([...snapshots]);
    return { latest: snapshots.at(-1), count: snapshots.length };
  };

  const entries = Array.from({ length: SNAPSHOT_DEPTH + 2 }, (_, index) => ({
    key: 'node',
    seq: index,
    rx: index,
  }));

  const aggregates = aggregateSnapshotSeries(entries, {
    depth: SNAPSHOT_DEPTH,
    keyFn: entry => entry.key,
    timestampFn: entry => entry.rx,
    mergeStrategy,
  });

  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0].aggregate.count, SNAPSHOT_DEPTH);
  assert.equal(aggregates[0].aggregate.latest.seq, SNAPSHOT_DEPTH + 1);
  assert.ok(calls.length >= 1);
  const expectedOldestSeq = Math.max(0, entries.length - SNAPSHOT_DEPTH);
  assert.equal(aggregates[0].snapshots[0].seq, expectedOldestSeq);
  assert.equal(aggregates[0].snapshots.at(-1).seq, SNAPSHOT_DEPTH + 1);
});

test('defaultMergeStrategy tolerates invalid input and preserves boolean values', () => {
  assert.deepEqual(defaultMergeStrategy(null), {});
  assert.deepEqual(defaultMergeStrategy([null, undefined, '']), {});

  const result = defaultMergeStrategy([
    { node_id: '!node', online: false, description: '' },
    { role: 'CLIENT', online: true },
  ]);

  assert.deepEqual(result, {
    node_id: '!node',
    online: true,
    role: 'CLIENT',
  });
});
