/*
 * Copyright © 2025-26 l5yth & contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * You may not use this file except in compliance with the License.
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

import { buildTraceSegments } from '../trace-paths.js';

test('buildTraceSegments connects source, hops, and destination when coordinates exist', () => {
  const traces = [
    { id: 9_001, src: 2658361180, hops: [19_088_743], dest: 4_242_424_242, rx_time: 1700 },
  ];
  const nodes = [
    { node_id: '2658361180', latitude: 10.5, longitude: -71.2, role: 'ROUTER' },
    { node_id: '19088743', latitude: 11.1, longitude: -70.9, role: 'CLIENT' },
    { node_id: '4242424242', latitude: 12.3, longitude: -70.2, role: 'CLIENT_HIDDEN' },
  ];

  const segments = buildTraceSegments(traces, nodes, {
    colorForNode: node => `color:${node.role}`,
    limitDistance: false,
  });

  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].latlngs, [[10.5, -71.2], [11.1, -70.9]]);
  assert.deepEqual(segments[1].latlngs, [[11.1, -70.9], [12.3, -70.2]]);
  assert.equal(segments[0].color, 'color:ROUTER');
  assert.equal(segments[1].color, 'color:CLIENT');
  assert.equal(segments[0].rxTime, 1700);
});

test('buildTraceSegments drops paths through hops without locations', () => {
  const traces = [
    { id: 9_002, src: 101, hops: [202], dest: 303 },
  ];
  const nodes = [
    { node_id: '101', latitude: 1, longitude: 2, role: 'CLIENT' },
    { node_id: '202' },
    { node_id: '303', latitude: 3, longitude: 4, role: 'CLIENT' },
  ];

  const segments = buildTraceSegments(traces, nodes);

  assert.equal(segments.length, 0);
});

test('buildTraceSegments respects distance limits when evaluating coordinates', () => {
  const traces = [
    { id: 9_003, src: 1, dest: 2 },
  ];
  const nodes = [
    { node_id: '1', latitude: 0, longitude: 0, distance_km: 51 },
    { node_id: '2', latitude: 1, longitude: 1, distance_km: 3 },
  ];

  const segments = buildTraceSegments(traces, nodes, { limitDistance: true, maxDistanceKm: 50 });

  assert.equal(segments.length, 0);
});
