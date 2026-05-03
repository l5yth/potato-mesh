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
  buildTelemetryIndex,
  mergePositionsIntoNodes,
  mergeTelemetryIntoNodes,
} from '../data-merge.js';

// ---------------------------------------------------------------------------
// mergePositionsIntoNodes — early returns
// ---------------------------------------------------------------------------

test('mergePositionsIntoNodes is a no-op when nodes is not an array', () => {
  const positions = [{ node_id: '!a', latitude: 1, longitude: 2 }];
  // Just assert no throw.
  mergePositionsIntoNodes(null, positions);
  mergePositionsIntoNodes(undefined, positions);
});

test('mergePositionsIntoNodes is a no-op when positions is not an array', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, null);
  mergePositionsIntoNodes(nodes, undefined);
  assert.deepEqual(nodes, [{ node_id: '!a' }]);
});

test('mergePositionsIntoNodes is a no-op for empty node arrays', () => {
  mergePositionsIntoNodes([], [{ node_id: '!a', latitude: 1, longitude: 2 }]);
});

test('mergePositionsIntoNodes is a no-op when no nodes carry a string node_id', () => {
  // Hits the `if (nodesById.size === 0) return;` early exit.
  const nodes = [{ node_num: 5 }];
  mergePositionsIntoNodes(nodes, [{ node_id: '!a', latitude: 1, longitude: 2 }]);
  assert.deepEqual(nodes, [{ node_num: 5 }]);
});

// ---------------------------------------------------------------------------
// mergePositionsIntoNodes — merge logic
// ---------------------------------------------------------------------------

test('mergePositionsIntoNodes copies coordinates when none exist', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [{
    node_id: '!a',
    latitude: 52.5,
    longitude: 13.4,
    altitude: 100,
    position_time: 1700000000,
    position_time_iso: '2023-11-14T22:13:20.000Z',
    location_source: 'gps',
    precision_bits: 24,
  }]);
  assert.equal(nodes[0].latitude, 52.5);
  assert.equal(nodes[0].longitude, 13.4);
  assert.equal(nodes[0].altitude, 100);
  assert.equal(nodes[0].position_time, 1700000000);
  assert.equal(nodes[0].pos_time_iso, '2023-11-14T22:13:20.000Z');
  assert.equal(nodes[0].location_source, 'gps');
  assert.equal(nodes[0].precision_bits, 24);
});

test('mergePositionsIntoNodes generates an ISO when only numeric position_time is supplied', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [{
    node_id: '!a',
    latitude: 1,
    longitude: 2,
    position_time: 1700000000,
  }]);
  assert.equal(nodes[0].pos_time_iso, new Date(1700000000 * 1000).toISOString());
});

test('mergePositionsIntoNodes preserves ISO when numeric position_time is missing', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [{
    node_id: '!a',
    latitude: 1,
    longitude: 2,
    position_time_iso: '2024-01-01T00:00:00.000Z',
  }]);
  assert.equal(nodes[0].pos_time_iso, '2024-01-01T00:00:00.000Z');
});

test('mergePositionsIntoNodes ignores incoming positions with non-finite coordinates', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [{ node_id: '!a', latitude: 'NaN', longitude: 1 }]);
  assert.equal(nodes[0].latitude, undefined);
});

test('mergePositionsIntoNodes only applies the first matching position per node', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [
    { node_id: '!a', latitude: 1, longitude: 2 },
    { node_id: '!a', latitude: 99, longitude: 99 },
  ]);
  assert.equal(nodes[0].latitude, 1);
});

test('mergePositionsIntoNodes skips packets older than the existing snapshot', () => {
  const nodes = [{
    node_id: '!a',
    latitude: 5,
    longitude: 5,
    position_time: 2000,
  }];
  mergePositionsIntoNodes(nodes, [{
    node_id: '!a',
    latitude: 9,
    longitude: 9,
    position_time: 1000,
  }]);
  assert.equal(nodes[0].latitude, 5); // unchanged
});

test('mergePositionsIntoNodes accepts strictly newer packets', () => {
  const nodes = [{
    node_id: '!a',
    latitude: 5,
    longitude: 5,
    position_time: 1000,
  }];
  mergePositionsIntoNodes(nodes, [{
    node_id: '!a',
    latitude: 9,
    longitude: 9,
    position_time: 2000,
  }]);
  assert.equal(nodes[0].latitude, 9);
});

test('mergePositionsIntoNodes skips entries lacking a node_id', () => {
  const nodes = [{ node_id: '!a' }];
  mergePositionsIntoNodes(nodes, [{ latitude: 1, longitude: 2 }, null]);
  assert.equal(nodes[0].latitude, undefined);
});

// ---------------------------------------------------------------------------
// buildTelemetryIndex
// ---------------------------------------------------------------------------

test('buildTelemetryIndex returns empty maps for non-array input', () => {
  const { byNodeId, byNodeNum } = buildTelemetryIndex(null);
  assert.equal(byNodeId.size, 0);
  assert.equal(byNodeNum.size, 0);
});

test('buildTelemetryIndex keeps the freshest entry per node_id', () => {
  const { byNodeId } = buildTelemetryIndex([
    { node_id: '!a', rx_time: 100, payload: 'old' },
    { node_id: '!a', rx_time: 200, payload: 'new' },
  ]);
  assert.equal(byNodeId.get('!a').entry.payload, 'new');
});

test('buildTelemetryIndex falls back to telemetry_time when rx_time is absent', () => {
  const { byNodeId } = buildTelemetryIndex([
    { node_id: '!a', telemetry_time: 50, payload: 'fallback' },
  ]);
  assert.equal(byNodeId.get('!a').timestamp, 50);
});

test('buildTelemetryIndex indexes by numeric node_num', () => {
  const { byNodeNum } = buildTelemetryIndex([
    { node_num: 42, rx_time: 100, payload: 'first' },
  ]);
  assert.ok(byNodeNum.has(42));
});

test('buildTelemetryIndex skips non-object entries', () => {
  const { byNodeId, byNodeNum } = buildTelemetryIndex([null, 'string', 5]);
  assert.equal(byNodeId.size, 0);
  assert.equal(byNodeNum.size, 0);
});

// ---------------------------------------------------------------------------
// mergeTelemetryIntoNodes
// ---------------------------------------------------------------------------

test('mergeTelemetryIntoNodes is a no-op when nodes is empty or not an array', () => {
  mergeTelemetryIntoNodes([], []);
  mergeTelemetryIntoNodes(null, []);
});

test('mergeTelemetryIntoNodes copies metrics when matched by node_id', () => {
  const nodes = [{ node_id: '!a' }];
  mergeTelemetryIntoNodes(nodes, [{
    node_id: '!a',
    battery_level: 85,
    voltage: 4.1,
    rx_time: 100,
    telemetry_time: 95,
  }]);
  assert.equal(nodes[0].battery_level, 85);
  assert.equal(nodes[0].voltage, 4.1);
  assert.equal(nodes[0].telemetry_time, 95);
  assert.equal(nodes[0].telemetry_rx_time, 100);
});

test('mergeTelemetryIntoNodes falls back to node_num lookup', () => {
  const nodes = [{ num: 42 }];
  mergeTelemetryIntoNodes(nodes, [{
    node_num: 42,
    temperature: 21.5,
  }]);
  assert.equal(nodes[0].temperature, 21.5);
});

test('mergeTelemetryIntoNodes ignores nodes that do not match by id or num', () => {
  const nodes = [{ node_id: '!a', num: 1 }];
  mergeTelemetryIntoNodes(nodes, [{ node_id: '!b', battery_level: 50 }]);
  assert.equal(nodes[0].battery_level, undefined);
});

test('mergeTelemetryIntoNodes skips null metric values', () => {
  const nodes = [{ node_id: '!a', battery_level: 99 }];
  mergeTelemetryIntoNodes(nodes, [{ node_id: '!a', battery_level: null }]);
  assert.equal(nodes[0].battery_level, 99);
});

test('mergeTelemetryIntoNodes tolerates non-object entries in the list', () => {
  const nodes = [null, undefined, { node_id: '!a' }];
  mergeTelemetryIntoNodes(nodes, [{ node_id: '!a', voltage: 3.9 }]);
  assert.equal(nodes[2].voltage, 3.9);
});
