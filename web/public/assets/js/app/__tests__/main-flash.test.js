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
 * VF-A2/VF-A3 — live-update flash is driven *only* by SSE-ping deltas, and a
 * node/position/telemetry ping flashes the affected node. Verified via the flash
 * counter + the ids handed to the flash (the row/marker DOM application itself is
 * unit-tested in main/__tests__/flash.test.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveApp, DEFAULT_RESPONSES } from './sse-app-harness.js';

const NOW = Math.floor(Date.now() / 1000);

function ping(FakeEventSource, collection) {
  FakeEventSource.instances[0].dispatch('change', { data: JSON.stringify({ collection }) });
}

test('the initial load does not flash (no strobe on paint)', async () => {
  await runLiveApp({}, async ({ testUtils }) => {
    assert.equal(testUtils.getLiveFlashCount(), 0);
  });
});

test('a nodes ping flashes the changed node', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    ping(FakeEventSource, 'nodes');
    await testUtils.flushLiveRefresh();
    assert.equal(testUtils.getLiveFlashCount(), 1);
    assert.deepEqual(testUtils.getLastFlashedNodeIds(), ['!a']);
  });
});

test('a positions ping flashes the position\'s node', async () => {
  const responses = {
    ...DEFAULT_RESPONSES,
    '/api/positions': [{ id: 1, node_id: '!p', rx_time: NOW, latitude: 1, longitude: 2 }],
  };
  await runLiveApp({ responses }, async ({ testUtils, FakeEventSource }) => {
    ping(FakeEventSource, 'positions');
    await testUtils.flushLiveRefresh();
    assert.deepEqual(testUtils.getLastFlashedNodeIds(), ['!p']);
  });
});

test('a telemetry ping flashes the telemetry node', async () => {
  const responses = {
    ...DEFAULT_RESPONSES,
    '/api/telemetry': [{ id: 1, node_id: '!t', rx_time: NOW, battery_level: 80 }],
  };
  await runLiveApp({ responses }, async ({ testUtils, FakeEventSource }) => {
    ping(FakeEventSource, 'telemetry');
    await testUtils.flushLiveRefresh();
    assert.deepEqual(testUtils.getLastFlashedNodeIds(), ['!t']);
  });
});

test('a messages ping flashes the message', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    ping(FakeEventSource, 'messages');
    await testUtils.flushLiveRefresh();
    assert.deepEqual(testUtils.getLastFlashedMessageIds(), ['1']);
  });
});

test('a message (server publishes messages + nodes) flashes both the message and its author node', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    const es = FakeEventSource.instances[0];
    // The server publishes BOTH on a message ingest (#822 / PS4 extension).
    es.dispatch('change', { data: JSON.stringify({ collection: 'messages' }) });
    es.dispatch('change', { data: JSON.stringify({ collection: 'nodes' }) });
    await testUtils.flushLiveRefresh();
    assert.deepEqual(testUtils.getLastFlashedMessageIds(), ['1']);
    assert.deepEqual(testUtils.getLastFlashedNodeIds(), ['!a']);
  });
});

test('a reconnect resync does not flash (VF2 — SSE pings only)', async () => {
  await runLiveApp({}, async ({ testUtils, FakeEventSource }) => {
    FakeEventSource.instances[0].dispatch('open', {}); // resync = full refresh, no flash
    await testUtils.flushLiveRefresh();
    assert.equal(testUtils.getLiveFlashCount(), 0);
  });
});

test('a neighbors ping flashes nothing (out of scope, VF3)', async () => {
  const responses = {
    ...DEFAULT_RESPONSES,
    '/api/neighbors': [{ node_id: '!n', neighbor_id: '!m', rx_time: NOW }],
  };
  await runLiveApp({ responses }, async ({ testUtils, FakeEventSource }) => {
    ping(FakeEventSource, 'neighbors');
    await testUtils.flushLiveRefresh();
    assert.equal(testUtils.getLiveFlashCount(), 0);
  });
});
