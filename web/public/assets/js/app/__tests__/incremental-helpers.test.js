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
import { maxRecordTimestamp, minRecordTimestamp, mergeById, mergeByCompositeKey, trimToLimit, trimToWindow } from '../incremental-helpers.js';

// ---------------------------------------------------------------------------
// maxRecordTimestamp
// ---------------------------------------------------------------------------

test('maxRecordTimestamp returns 0 for an empty array', () => {
  assert.equal(maxRecordTimestamp([]), 0);
});

test('maxRecordTimestamp returns 0 for non-array input', () => {
  assert.equal(maxRecordTimestamp(null), 0);
  assert.equal(maxRecordTimestamp(undefined), 0);
  assert.equal(maxRecordTimestamp('string'), 0);
});

test('maxRecordTimestamp extracts the highest rx_time by default', () => {
  const records = [
    { rx_time: 100 },
    { rx_time: 300 },
    { rx_time: 200 },
  ];
  assert.equal(maxRecordTimestamp(records), 300);
});

test('maxRecordTimestamp inspects last_heard by default', () => {
  const records = [
    { last_heard: 500 },
    { last_heard: 250 },
  ];
  assert.equal(maxRecordTimestamp(records), 500);
});

test('maxRecordTimestamp returns 0 when records lack timestamp fields', () => {
  const records = [{ node_id: '!abc' }, { node_id: '!def' }];
  assert.equal(maxRecordTimestamp(records), 0);
});

test('maxRecordTimestamp accepts custom field names', () => {
  const records = [
    { telemetry_time: 700, rx_time: 600 },
    { telemetry_time: 800 },
  ];
  assert.equal(maxRecordTimestamp(records, ['telemetry_time']), 800);
});

test('maxRecordTimestamp picks the max across multiple fields', () => {
  const records = [
    { rx_time: 100, position_time: 400 },
    { rx_time: 300, position_time: 200 },
  ];
  assert.equal(maxRecordTimestamp(records, ['rx_time', 'position_time']), 400);
});

test('maxRecordTimestamp skips null and non-object entries', () => {
  const records = [null, undefined, 42, { rx_time: 10 }];
  assert.equal(maxRecordTimestamp(records), 10);
});

test('maxRecordTimestamp ignores non-number timestamp values', () => {
  const records = [{ rx_time: 'abc' }, { rx_time: 50 }];
  assert.equal(maxRecordTimestamp(records), 50);
});

// ---------------------------------------------------------------------------
// minRecordTimestamp
// ---------------------------------------------------------------------------

test('minRecordTimestamp returns 0 for an empty array', () => {
  assert.equal(minRecordTimestamp([]), 0);
});

test('minRecordTimestamp returns 0 for non-array input', () => {
  assert.equal(minRecordTimestamp(null), 0);
  assert.equal(minRecordTimestamp(undefined), 0);
  assert.equal(minRecordTimestamp('string'), 0);
});

test('minRecordTimestamp extracts the lowest positive rx_time by default', () => {
  // The middle row exercises both branches of the running-minimum test: 100
  // lowers the floor from 300, then 200 (>= 100) leaves it unchanged.
  const records = [{ rx_time: 300 }, { rx_time: 100 }, { rx_time: 200 }];
  assert.equal(minRecordTimestamp(records), 100);
});

test('minRecordTimestamp inspects last_heard by default', () => {
  const records = [{ last_heard: 500 }, { last_heard: 250 }];
  assert.equal(minRecordTimestamp(records), 250);
});

test('minRecordTimestamp returns 0 when records lack timestamp fields', () => {
  const records = [{ node_id: '!abc' }, { node_id: '!def' }];
  assert.equal(minRecordTimestamp(records), 0);
});

test('minRecordTimestamp accepts custom field names', () => {
  const records = [{ telemetry_time: 800 }, { telemetry_time: 400 }];
  assert.equal(minRecordTimestamp(records, ['telemetry_time']), 400);
});

test('minRecordTimestamp picks the min across multiple fields', () => {
  const records = [{ rx_time: 400, position_time: 150 }];
  assert.equal(minRecordTimestamp(records, ['rx_time', 'position_time']), 150);
});

test('minRecordTimestamp skips null and non-object entries', () => {
  const records = [null, undefined, 42, { rx_time: 10 }];
  assert.equal(minRecordTimestamp(records), 10);
});

test('minRecordTimestamp ignores non-number and non-positive timestamps', () => {
  const records = [{ rx_time: 'abc' }, { rx_time: 0 }, { rx_time: -5 }, { rx_time: 70 }];
  assert.equal(minRecordTimestamp(records), 70);
});

// ---------------------------------------------------------------------------
// mergeById
// ---------------------------------------------------------------------------

test('mergeById returns existing when incoming is empty', () => {
  const existing = [{ id: 1, v: 'a' }];
  assert.strictEqual(mergeById(existing, [], 'id'), existing);
  assert.strictEqual(mergeById(existing, null, 'id'), existing);
  assert.strictEqual(mergeById(existing, undefined, 'id'), existing);
});

test('mergeById deduplicates by keyField keeping the incoming value', () => {
  const existing = [
    { id: 1, v: 'old' },
    { id: 2, v: 'keep' },
  ];
  const incoming = [
    { id: 1, v: 'new' },
    { id: 3, v: 'added' },
  ];
  const result = mergeById(existing, incoming, 'id');
  assert.equal(result.length, 3);
  const byId = Object.fromEntries(result.map(r => [r.id, r.v]));
  assert.equal(byId[1], 'new');
  assert.equal(byId[2], 'keep');
  assert.equal(byId[3], 'added');
});

test('mergeById works with string keys', () => {
  const existing = [{ node_id: '!abc', name: 'A' }];
  const incoming = [{ node_id: '!abc', name: 'B' }];
  const result = mergeById(existing, incoming, 'node_id');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});

test('mergeById skips items with null or undefined key', () => {
  const existing = [{ id: 1, v: 'a' }];
  const incoming = [{ v: 'no-id' }, { id: 2, v: 'b' }];
  const result = mergeById(existing, incoming, 'id');
  assert.equal(result.length, 2);
});

test('mergeById returns all incoming when existing is empty', () => {
  const result = mergeById([], [{ id: 1 }, { id: 2 }], 'id');
  assert.equal(result.length, 2);
});

// ---------------------------------------------------------------------------
// mergeByCompositeKey
// ---------------------------------------------------------------------------

test('mergeByCompositeKey deduplicates by composite key', () => {
  const existing = [
    { node_id: '!a', neighbor_id: '!b', snr: 5 },
    { node_id: '!a', neighbor_id: '!c', snr: 3 },
  ];
  const incoming = [
    { node_id: '!a', neighbor_id: '!b', snr: 8 },
    { node_id: '!a', neighbor_id: '!d', snr: 1 },
  ];
  const result = mergeByCompositeKey(existing, incoming, ['node_id', 'neighbor_id']);
  assert.equal(result.length, 3);
  const ab = result.find(r => r.neighbor_id === '!b');
  assert.equal(ab.snr, 8, 'incoming should overwrite existing for same composite key');
});

test('mergeByCompositeKey returns existing when incoming is empty', () => {
  const existing = [{ a: 1, b: 2 }];
  assert.strictEqual(mergeByCompositeKey(existing, [], ['a', 'b']), existing);
  assert.strictEqual(mergeByCompositeKey(existing, null, ['a', 'b']), existing);
});

test('mergeByCompositeKey handles missing key fields gracefully', () => {
  const existing = [{ node_id: '!a' }];
  const incoming = [{ node_id: '!a', neighbor_id: '!b' }];
  const result = mergeByCompositeKey(existing, incoming, ['node_id', 'neighbor_id']);
  assert.equal(result.length, 2, 'different composite keys due to missing field');
});

// ---------------------------------------------------------------------------
// trimToLimit
// ---------------------------------------------------------------------------

test('trimToLimit returns the same array when within limit', () => {
  const records = [{ id: 1, rx_time: 100 }, { id: 2, rx_time: 200 }];
  const result = trimToLimit(records, 5);
  assert.strictEqual(result, records);
});

test('trimToLimit trims to limit keeping newest entries', () => {
  const records = [
    { id: 1, rx_time: 100 },
    { id: 2, rx_time: 300 },
    { id: 3, rx_time: 200 },
    { id: 4, rx_time: 400 },
  ];
  const result = trimToLimit(records, 2);
  assert.equal(result.length, 2);
  const ids = result.map(r => r.id);
  assert.ok(ids.includes(4), 'should keep newest (id=4)');
  assert.ok(ids.includes(2), 'should keep second newest (id=2)');
});

test('trimToLimit uses custom timestamp field', () => {
  const records = [
    { id: 1, last_heard: 100 },
    { id: 2, last_heard: 300 },
    { id: 3, last_heard: 200 },
  ];
  const result = trimToLimit(records, 1, 'last_heard');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

test('trimToLimit returns input for non-array values', () => {
  assert.equal(trimToLimit(null, 10), null);
  assert.equal(trimToLimit(undefined, 10), undefined);
});

test('trimToLimit handles records with missing timestamp fields', () => {
  const records = [
    { id: 1, rx_time: 100 },
    { id: 2 },
    { id: 3, rx_time: 300 },
  ];
  const result = trimToLimit(records, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 3);
});

// ---------------------------------------------------------------------------
// trimToWindow (issue #796)
// ---------------------------------------------------------------------------

test('trimToWindow drops records older than the floor and keeps the boundary', () => {
  const records = [
    { id: 1, rx_time: 90 },
    { id: 2, rx_time: 100 }, // exactly at the floor → kept
    { id: 3, rx_time: 150 },
  ];
  const result = trimToWindow(records, 100);
  assert.deepEqual(result.map(r => r.id), [2, 3]);
});

test('trimToWindow retains records with a missing or non-numeric timestamp', () => {
  const records = [
    { id: 1 },
    { id: 2, rx_time: 'nope' },
    { id: 3, rx_time: 50 },
    { id: 4, rx_time: 500 },
  ];
  const result = trimToWindow(records, 100);
  assert.deepEqual(result.map(r => r.id), [1, 2, 4]);
});

test('trimToWindow uses a custom timestamp field', () => {
  const records = [
    { id: 1, last_heard: 10 },
    { id: 2, last_heard: 200 },
  ];
  const result = trimToWindow(records, 100, 'last_heard');
  assert.deepEqual(result.map(r => r.id), [2]);
});

test('trimToWindow returns the input unchanged for an unusable floor', () => {
  const records = [{ id: 1, rx_time: 10 }];
  assert.equal(trimToWindow(records, 0), records);
  assert.equal(trimToWindow(records, Number.NaN), records);
  assert.equal(trimToWindow(records, -5), records);
});

test('trimToWindow returns input for non-array values', () => {
  assert.equal(trimToWindow(null, 100), null);
  assert.equal(trimToWindow(undefined, 100), undefined);
});
