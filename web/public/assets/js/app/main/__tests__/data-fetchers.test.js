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
  fetchMessages,
  fetchNeighbors,
  fetchNodeById,
  fetchNodes,
  fetchPositions,
  fetchTelemetry,
  fetchTraces,
  filterRecentTraces,
  resolveSnapshotLimit,
} from '../data-fetchers.js';
import { NODE_LIMIT, SNAPSHOT_LIMIT, TRACE_LIMIT } from '../constants.js';

/**
 * Install a temporary global ``fetch`` stub that records every call and
 * returns the supplied response.  Returns a teardown handle that restores
 * the previous binding and exposes the captured call list.
 *
 * @param {{ ok?: boolean, status?: number, body?: any }|Function} responseOrFn
 *   Response descriptor or an async function returning one.
 * @returns {{ calls: Array<{url: string, init: any}>, restore: Function }}
 *   Stub control surface.
 */
function withFetchStub(responseOrFn) {
  const previous = globalThis.fetch;
  const calls = [];
  const handler = typeof responseOrFn === 'function'
    ? responseOrFn
    : () => responseOrFn;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const descriptor = await handler(url, init);
    return {
      ok: descriptor.ok ?? true,
      status: descriptor.status ?? 200,
      json: async () => descriptor.body ?? [],
    };
  };
  return {
    calls,
    restore() {
      if (previous === undefined) {
        delete globalThis.fetch;
      } else {
        globalThis.fetch = previous;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// resolveSnapshotLimit
// ---------------------------------------------------------------------------

test('resolveSnapshotLimit multiplies the requested limit by SNAPSHOT_LIMIT', () => {
  assert.equal(resolveSnapshotLimit(10), Math.min(10 * SNAPSHOT_LIMIT, NODE_LIMIT));
});

test('resolveSnapshotLimit caps to maxLimit', () => {
  assert.equal(resolveSnapshotLimit(NODE_LIMIT), NODE_LIMIT);
  assert.equal(resolveSnapshotLimit(NODE_LIMIT * 2), NODE_LIMIT);
});

test('resolveSnapshotLimit defaults to NODE_LIMIT for invalid input', () => {
  assert.equal(resolveSnapshotLimit(null), NODE_LIMIT);
  assert.equal(resolveSnapshotLimit(0), NODE_LIMIT);
  assert.equal(resolveSnapshotLimit(-5), NODE_LIMIT);
  assert.equal(resolveSnapshotLimit(Number.NaN), NODE_LIMIT);
});

// ---------------------------------------------------------------------------
// filterRecentTraces
// ---------------------------------------------------------------------------

test('filterRecentTraces returns empty array for non-array input', () => {
  assert.deepEqual(filterRecentTraces(null), []);
  assert.deepEqual(filterRecentTraces(undefined), []);
  assert.deepEqual(filterRecentTraces({}), []);
});

test('filterRecentTraces returns a copy of the input when maxAgeSeconds is non-positive', () => {
  const input = [{ rx_time: 1 }, { rx_time: 2 }];
  const result = filterRecentTraces(input, 0);
  assert.deepEqual(result, input);
  assert.notEqual(result, input); // Returns a copy, not the same reference.

  const negativeResult = filterRecentTraces(input, -10);
  assert.deepEqual(negativeResult, input);
});

test('filterRecentTraces drops traces older than the cutoff', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const traces = [
    { rx_time: nowSeconds }, // recent
    { rx_time: nowSeconds - 7200 }, // older than 1h
    { rxIso: new Date((nowSeconds - 30) * 1000).toISOString() }, // recent via ISO
  ];
  const filtered = filterRecentTraces(traces, 3600);
  assert.equal(filtered.length, 2);
});

test('filterRecentTraces drops traces with no usable timestamp', () => {
  const filtered = filterRecentTraces([{ noTime: true }, { rx_time: null }], 3600);
  assert.deepEqual(filtered, []);
});

// ---------------------------------------------------------------------------
// fetchNodeById
// ---------------------------------------------------------------------------

test('fetchNodeById returns null for non-string inputs', async () => {
  assert.equal(await fetchNodeById(null), null);
  assert.equal(await fetchNodeById(42), null);
});

test('fetchNodeById returns null for blank string inputs', async () => {
  assert.equal(await fetchNodeById(''), null);
  assert.equal(await fetchNodeById('   '), null);
});

test('fetchNodeById returns null on HTTP 404', async () => {
  const stub = withFetchStub({ ok: false, status: 404 });
  try {
    assert.equal(await fetchNodeById('!aabbccdd'), null);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes('!aabbccdd'));
  } finally {
    stub.restore();
  }
});

test('fetchNodeById throws on non-OK non-404 responses', async () => {
  const stub = withFetchStub({ ok: false, status: 500 });
  try {
    await assert.rejects(() => fetchNodeById('!aabbccdd'), /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('fetchNodeById returns parsed payload on success', async () => {
  const stub = withFetchStub({ ok: true, status: 200, body: { node_id: '!aabbccdd' } });
  try {
    const result = await fetchNodeById('!aabbccdd');
    assert.deepEqual(result, { node_id: '!aabbccdd' });
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// fetchNodes / fetchNeighbors / fetchTelemetry / fetchPositions / fetchTraces
// ---------------------------------------------------------------------------

test('fetchNodes appends since when greater than zero', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchNodes(10, 1234);
    assert.ok(stub.calls[0].url.includes('since=1234'));
  } finally {
    stub.restore();
  }
});

test('fetchNodes throws on non-OK', async () => {
  const stub = withFetchStub({ ok: false, status: 503 });
  try {
    await assert.rejects(() => fetchNodes(), /HTTP 503/);
  } finally {
    stub.restore();
  }
});

test('fetchNeighbors hits the neighbours endpoint', async () => {
  const stub = withFetchStub({ ok: true, body: [{ node_id: '!a' }] });
  try {
    const result = await fetchNeighbors(50);
    assert.ok(stub.calls[0].url.startsWith('/api/neighbors?'));
    assert.deepEqual(result, [{ node_id: '!a' }]);
  } finally {
    stub.restore();
  }
});

test('fetchNeighbors propagates HTTP errors', async () => {
  const stub = withFetchStub({ ok: false, status: 502 });
  try {
    await assert.rejects(() => fetchNeighbors(), /HTTP 502/);
  } finally {
    stub.restore();
  }
});

test('fetchTelemetry hits the telemetry endpoint', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchTelemetry(50, 100);
    assert.ok(stub.calls[0].url.startsWith('/api/telemetry?'));
    assert.ok(stub.calls[0].url.includes('since=100'));
  } finally {
    stub.restore();
  }
});

test('fetchTelemetry propagates HTTP errors', async () => {
  const stub = withFetchStub({ ok: false, status: 504 });
  try {
    await assert.rejects(() => fetchTelemetry(), /HTTP 504/);
  } finally {
    stub.restore();
  }
});

test('fetchPositions hits the positions endpoint', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchPositions();
    assert.ok(stub.calls[0].url.startsWith('/api/positions?'));
  } finally {
    stub.restore();
  }
});

test('fetchPositions propagates HTTP errors', async () => {
  const stub = withFetchStub({ ok: false, status: 500 });
  try {
    await assert.rejects(() => fetchPositions(), /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('fetchTraces filters expired entries', async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stub = withFetchStub({
    ok: true,
    body: [
      { rx_time: nowSeconds },
      { rx_time: nowSeconds - 365 * 24 * 3600 },
    ],
  });
  try {
    const result = await fetchTraces();
    // Only the recent trace should survive.
    assert.equal(result.length, 1);
    assert.ok(stub.calls[0].url.startsWith('/api/traces?'));
  } finally {
    stub.restore();
  }
});

test('fetchTraces falls back to TRACE_LIMIT on bogus input', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchTraces(Number.NaN);
    assert.ok(stub.calls[0].url.includes(`limit=${TRACE_LIMIT}`));
  } finally {
    stub.restore();
  }
});

test('fetchTraces propagates HTTP errors', async () => {
  const stub = withFetchStub({ ok: false, status: 500 });
  try {
    await assert.rejects(() => fetchTraces(), /HTTP 500/);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// fetchMessages
// ---------------------------------------------------------------------------

test('fetchMessages returns [] when chatEnabled is false', async () => {
  const stub = withFetchStub({ ok: true, body: [{ id: 1 }] });
  try {
    const result = await fetchMessages(10, { chatEnabled: false });
    assert.deepEqual(result, []);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('fetchMessages applies normaliseMessageLimit when provided', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchMessages(999, {
      normaliseMessageLimit: () => 25,
      chatEnabled: true,
    });
    assert.ok(stub.calls[0].url.includes('limit=25'));
  } finally {
    stub.restore();
  }
});

test('fetchMessages forwards encrypted=true and since when set', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchMessages(10, { encrypted: true, since: 555 });
    assert.ok(stub.calls[0].url.includes('encrypted=true'));
    assert.ok(stub.calls[0].url.includes('since=555'));
  } finally {
    stub.restore();
  }
});

test('fetchMessages omits limit normalisation when normaliser is absent', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchMessages(50);
    assert.ok(stub.calls[0].url.includes('limit=50'));
  } finally {
    stub.restore();
  }
});

test('fetchMessages propagates HTTP errors', async () => {
  const stub = withFetchStub({ ok: false, status: 500 });
  try {
    await assert.rejects(() => fetchMessages(10), /HTTP 500/);
  } finally {
    stub.restore();
  }
});
