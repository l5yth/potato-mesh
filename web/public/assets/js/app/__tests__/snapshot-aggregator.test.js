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
  SNAPSHOT_WINDOW,
  aggregateSnapshots,
  aggregateNodeSnapshots,
  aggregateTelemetrySnapshots,
  aggregatePositionSnapshots,
  aggregateNeighborSnapshots,
} from '../snapshot-aggregator.js';

const SAMPLE_NODE_ID = '!node';

function keyById(entry) {
  return entry && typeof entry.id === 'string' ? entry.id : null;
}

test('aggregateSnapshots merges snapshots in chronological order', () => {
  const snapshots = [
    { id: 'alpha', metric: null, label: 'latest', ts: 30, ignored: Number.NaN },
    { id: 'alpha', metric: 5, label: null, ts: 20 },
    { id: 'alpha', metric: 1, legacy: 'keep', ts: 10 },
  ];
  const aggregated = aggregateSnapshots(snapshots, { keySelector: keyById, limit: 3 });
  assert.equal(aggregated.length, 1);
  const record = aggregated[0];
  assert.equal(record.metric, 5);
  assert.equal(record.label, 'latest');
  assert.equal(record.legacy, 'keep');
  assert.deepEqual(record.snapshots.map(s => s.ts), [10, 20, 30]);
  assert.equal(record.latestSnapshot.ts, 30);
  assert.equal(Object.prototype.propertyIsEnumerable.call(record, 'snapshots'), false);
  assert.equal(Object.prototype.propertyIsEnumerable.call(record, 'latestSnapshot'), false);
  assert.equal('ignored' in record, false);
});

test('aggregateSnapshots enforces key selectors and respects limits', () => {
  assert.throws(() => aggregateSnapshots([{ id: 'noop' }], {}), /keySelector/);
  const snapshots = [
    { id: 'beta', value: 'newest', ts: 30 },
    { id: 'beta', value: 'mid', ts: 20 },
    { id: 'beta', value: 'oldest', ts: 10 },
  ];
  const aggregated = aggregateSnapshots(snapshots, { keySelector: keyById, limit: 2 });
  assert.equal(aggregated[0].snapshots.length, 2);
  assert.deepEqual(aggregated[0].snapshots.map(s => s.ts), [20, 30]);
});

test('aggregateNodeSnapshots reconciles identifiers and fills missing values', () => {
  const entries = [
    { nodeId: SAMPLE_NODE_ID, voltage: 4.2, battery_level: null, rx_time: 250 },
    { node_id: SAMPLE_NODE_ID, node_num: 42, battery_level: 20, rx_time: 200 },
    { node_num: 42, short_name: 'Legacy', battery_level: 15, rx_time: 100 },
  ];
  const aggregated = aggregateNodeSnapshots(entries, { limit: SNAPSHOT_WINDOW });
  assert.equal(aggregated.length, 1);
  const node = aggregated[0];
  assert.equal(node.node_id, SAMPLE_NODE_ID);
  assert.equal(node.node_num, 42);
  assert.equal(node.short_name, 'Legacy');
  assert.equal(node.battery_level, 20);
  assert.equal(node.voltage, 4.2);
  assert.equal(node.snapshots.length, 3);
});

test('aggregateTelemetrySnapshots and aggregatePositionSnapshots retain older non-null fields', () => {
  const telemetryEntries = [
    { node_id: SAMPLE_NODE_ID, node_num: 5, temperature: null, rx_time: 20 },
    { node_num: 5, temperature: 21.5, humidity: 52, rx_time: 10 },
  ];
  const positionEntries = [
    { node_id: SAMPLE_NODE_ID, node_num: 5, longitude: 13.4, rx_time: 25 },
    { node_num: 5, latitude: 52.5, rx_time: 15 },
  ];
  const telemetryAggregated = aggregateTelemetrySnapshots(telemetryEntries);
  const positionAggregated = aggregatePositionSnapshots(positionEntries, { limit: 3 });
  assert.equal(telemetryAggregated.length, 1);
  assert.equal(positionAggregated.length, 1);
  assert.equal(telemetryAggregated[0].temperature, 21.5);
  assert.equal(telemetryAggregated[0].humidity, 52);
  assert.equal(positionAggregated[0].latitude, 52.5);
  assert.equal(positionAggregated[0].longitude, 13.4);
});

test('aggregateNeighborSnapshots groups by node pairs', () => {
  const neighborSnapshots = [
    { node_id: '!src', node_num: 101, neighbor_id: '!dst', neighbor_num: 202, snr: null, rx_time: 180 },
    { node_id: '!src', node_num: 101, neighbor_id: '!dst', neighbor_num: 202, snr: -5, rx_time: 150 },
    { node_num: 101, neighbor_num: 202, snr: -11, rx_time: 100 },
    null,
  ];
  const aggregated = aggregateNeighborSnapshots(neighborSnapshots, { limit: 5 });
  assert.equal(aggregated.length, 1);
  const connection = aggregated[0];
  assert.equal(connection.node_id, '!src');
  assert.equal(connection.neighbor_id, '!dst');
  assert.equal(connection.snr, -5);
  assert.equal(connection.snapshots.length, 3);
});

test('aggregateSnapshots returns an empty array when no entries are provided', () => {
  assert.deepEqual(aggregateSnapshots(null, { keySelector: () => 'noop' }), []);
  assert.deepEqual(aggregateNodeSnapshots([], {}), []);
});

// Regression: hidden telemetry in the node table. Meshtastic telemetry is a
// protobuf oneof — each packet carries exactly one metric family — so the
// aggregate must keep the newest non-null value per field across families
// instead of merging a fixed packet-count window (TM-A1 in ACCEPTANCE.md).

/**
 * Build a newest-first packet stream: one environment packet followed by
 * ``newerCount`` newer device/power packets for the same node.
 *
 * @param {number} newerCount Number of non-environment packets newer than the
 *   environment packet.
 * @returns {Array<Object>} Telemetry entries ordered newest-first.
 */
function environmentThenNewerPackets(newerCount) {
  const entries = [];
  for (let i = newerCount; i >= 1; i -= 1) {
    entries.push({
      id: 9000 + i,
      node_id: SAMPLE_NODE_ID,
      rx_time: 1000 + i * 60,
      telemetry_type: i % 2 ? 'device' : 'power',
      // Power packets carry no extracted metric columns at all; device packets
      // carry the device family only.
      ...(i % 2 ? { battery_level: 80, voltage: 4.05 } : {}),
    });
  }
  entries.push({
    id: 9000,
    node_id: SAMPLE_NODE_ID,
    rx_time: 1000,
    telemetry_type: 'environment',
    temperature: 21.5,
    relative_humidity: 40.2,
    barometric_pressure: 1013.2,
  });
  return entries;
}

test('aggregateTelemetrySnapshots keeps environment metrics past SNAPSHOT_WINDOW newer packets of other types', () => {
  const aggregated = aggregateTelemetrySnapshots(environmentThenNewerPackets(SNAPSHOT_WINDOW + 1));
  assert.equal(aggregated.length, 1);
  const record = aggregated[0];
  // Latest known environment readings survive alongside the newest device values.
  assert.equal(record.temperature, 21.5);
  assert.equal(record.relative_humidity, 40.2);
  assert.equal(record.barometric_pressure, 1013.2);
  assert.equal(record.battery_level, 80);
  assert.equal(record.voltage, 4.05);
});

test('aggregateTelemetrySnapshots prefers the newest non-null value per field regardless of input order', () => {
  // Append/IndexedDB-seed order: the older packet sits first in the array, the
  // way a warm cache seed (key order) or an incremental mergeById append holds it.
  const older = { id: 3, node_id: SAMPLE_NODE_ID, rx_time: 1000, telemetry_type: 'device', battery_level: 20, voltage: 3.2 };
  const newer = { id: 9, node_id: SAMPLE_NODE_ID, rx_time: 2000, telemetry_type: 'device', battery_level: 90, voltage: 4.1 };
  for (const entries of [[older, newer], [newer, older]]) {
    const aggregated = aggregateTelemetrySnapshots(entries);
    assert.equal(aggregated.length, 1);
    const record = aggregated[0];
    assert.equal(record.battery_level, 90);
    assert.equal(record.voltage, 4.1);
    // The hidden history stays chronological and the latest snapshot is the
    // newest packet by timestamp, not by array position.
    assert.deepEqual(record.snapshots.map(s => s.rx_time), [1000, 2000]);
    assert.equal(record.latestSnapshot.rx_time, 2000);
  }
});

test('aggregateTelemetrySnapshots resolves equal timestamps to the row later in the input', () => {
  // Same-second packets are equally fresh; the deterministic tie rule is that
  // the row appearing later in the input (a fresher append) wins the conflict.
  const tied = aggregateTelemetrySnapshots([
    { id: 1, node_id: SAMPLE_NODE_ID, rx_time: 1000, battery_level: 20 },
    { id: 2, node_id: SAMPLE_NODE_ID, rx_time: 1000, battery_level: 90 },
  ]);
  assert.equal(tied.length, 1);
  assert.equal(tied[0].battery_level, 90);
  assert.equal(tied[0].latestSnapshot.id, 2);
  // Two untimestamped rows tie at -Infinity: the explicit comparator keeps the
  // ordering deterministic (no NaN from subtracting infinities) and the later
  // row still wins.
  const untimed = aggregateTelemetrySnapshots([
    { id: 3, node_id: SAMPLE_NODE_ID, voltage: 3.2 },
    { id: 4, node_id: SAMPLE_NODE_ID, voltage: 4.1 },
  ]);
  assert.equal(untimed.length, 1);
  assert.equal(untimed[0].voltage, 4.1);
  assert.deepEqual(untimed[0].snapshots.map(s => s.id), [3, 4]);
});

test('aggregateTelemetrySnapshots never overwrites a valid value with an empty field', () => {
  const aggregated = aggregateTelemetrySnapshots([
    { id: 2, node_id: SAMPLE_NODE_ID, rx_time: 2000, telemetry_type: 'environment', temperature: 22.1, relative_humidity: null },
    { id: 1, node_id: SAMPLE_NODE_ID, rx_time: 1000, telemetry_type: 'environment', temperature: 21.5, relative_humidity: 40.2 },
  ]);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].temperature, 22.1);
  assert.equal(aggregated[0].relative_humidity, 40.2);
});
