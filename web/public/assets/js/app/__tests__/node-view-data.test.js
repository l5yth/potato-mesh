/*
 * Copyright (C) 2025 l5yth
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

import { fetchTelemetryForNode, fetchPositionsForNode, toFiniteNumber } from '../node-view-data.js';

/**
 * Create a fetch stub that yields a predefined response.
 *
 * @param {Object} payload JSON payload returned from ``response.json``.
 * @param {Object} [options] Overrides for the response object.
 * @returns {Function} Async function emulating ``fetch``.
 */
function createFetchStub(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    async json() {
      return payload;
    }
  });
}

test('toFiniteNumber coerces values as expected', () => {
  assert.equal(toFiniteNumber(42), 42);
  assert.equal(toFiniteNumber('3.5'), 3.5);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber(Infinity), null);
});

test('fetchTelemetryForNode normalises telemetry entries', async () => {
  const now = Date.UTC(2025, 0, 8) ;
  const recentTs = now - 2 * 24 * 60 * 60 * 1000;
  const oldTs = now - 10 * 24 * 60 * 60 * 1000;
  const payload = [
    {
      telemetry_time: Math.floor(recentTs / 1000),
      battery_level: 88.2,
      channel_utilization: 30.5,
      air_util_tx: 12.1
    },
    {
      telemetry_time: Math.floor(oldTs / 1000),
      battery_level: 10,
      channel_utilization: 15,
      air_util_tx: 5
    },
    {
      telemetry_time: Math.floor(recentTs / 1000),
      battery_level: null,
      channel_utilization: null,
      air_util_tx: null
    }
  ];

  const fetchImpl = createFetchStub(payload);
  const result = await fetchTelemetryForNode({ nodeId: '!node', fetchImpl, now });
  assert.equal(result.length, 1);
  assert.equal(result[0].batteryLevel, 88.2);
  assert.equal(result[0].channelUtilization, 30.5);
  assert.equal(result[0].airUtilTx, 12.1);
  assert.equal(result[0].timestampMs, Math.floor(recentTs / 1000) * 1000);
});

test('fetchTelemetryForNode rejects failing requests', async () => {
  const fetchImpl = createFetchStub([], { ok: false, status: 503 });
  await assert.rejects(() => fetchTelemetryForNode({ nodeId: '!node', fetchImpl }), /status: 503/);
});

test('fetchTelemetryForNode validates node identifiers', async () => {
  await assert.rejects(() => fetchTelemetryForNode({ nodeId: ' ' }), TypeError);
});

test('fetchPositionsForNode normalises positional history', async () => {
  const now = Date.UTC(2025, 0, 8);
  const recentTs = now - 3 * 24 * 60 * 60 * 1000;
  const payload = [
    {
      position_time: Math.floor(recentTs / 1000),
      latitude: 12.34,
      longitude: 56.78,
      altitude: 123
    },
    {
      position_time: Math.floor((now - 9 * 24 * 60 * 60 * 1000) / 1000),
      latitude: 1,
      longitude: 2
    }
  ];
  const fetchImpl = createFetchStub(payload);
  const result = await fetchPositionsForNode({ nodeId: '!node', fetchImpl, now });
  assert.equal(result.length, 1);
  assert.equal(result[0].latitude, 12.34);
  assert.equal(result[0].longitude, 56.78);
  assert.equal(result[0].altitude, 123);
});

test('fetchPositionsForNode rejects failing requests', async () => {
  const fetchImpl = createFetchStub([], { ok: false, status: 404 });
  await assert.rejects(() => fetchPositionsForNode({ nodeId: '!node', fetchImpl }), /status: 404/);
});

test('fetchPositionsForNode validates node identifiers', async () => {
  await assert.rejects(() => fetchPositionsForNode({ nodeId: '' }), TypeError);
});
