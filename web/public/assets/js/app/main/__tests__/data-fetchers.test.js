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
  fetchAllMessages,
  paginateMessages,
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

test('fetchMessages forwards a positive before cursor and omits a non-positive one', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    await fetchMessages(10, { before: 1234 });
    assert.ok(stub.calls[0].url.includes('before=1234'));
    await fetchMessages(10, { before: 0 });
    assert.ok(!stub.calls[1].url.includes('before='));
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// fetchAllMessages (issue #796 backward pagination)
// ---------------------------------------------------------------------------

test('fetchAllMessages pages backward until a short page and de-duplicates by id', async () => {
  // limit=2; the inclusive cursor re-returns the boundary row, which must be
  // de-duplicated rather than counted twice.
  const stub = withFetchStub((url) => {
    if (url.includes('before=40')) {
      return { ok: true, body: [{ id: 4, rx_time: 40 }, { id: 3, rx_time: 30 }] };
    }
    if (url.includes('before=30')) {
      return { ok: true, body: [{ id: 3, rx_time: 30 }] }; // short page → stop
    }
    return { ok: true, body: [{ id: 5, rx_time: 50 }, { id: 4, rx_time: 40 }] };
  });
  try {
    const all = await fetchAllMessages(2, {});
    assert.deepEqual(all.map(m => m.id), [5, 4, 3]);
    assert.equal(stub.calls.length, 3);
    assert.ok(stub.calls[1].url.includes('before=40'));
    assert.ok(stub.calls[2].url.includes('before=30'));
  } finally {
    stub.restore();
  }
});

test('fetchAllMessages stops when the server ignores the cursor (no progress)', async () => {
  // The stub returns the same full page regardless of the cursor; without the
  // no-progress guard this would loop forever.
  const stub = withFetchStub({ ok: true, body: [{ id: 5, rx_time: 50 }, { id: 4, rx_time: 40 }] });
  try {
    const all = await fetchAllMessages(2, {});
    assert.deepEqual(all.map(m => m.id), [5, 4]);
    assert.equal(stub.calls.length, 2); // page 1 + one no-progress page, then stop
  } finally {
    stub.restore();
  }
});

test('fetchAllMessages returns [] and makes one call for an empty window', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    const all = await fetchAllMessages(2, {});
    assert.deepEqual(all, []);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('fetchAllMessages stops when no row carries a usable timestamp cursor', async () => {
  // A full page whose rows lack rx_time cannot advance the cursor; the loop must
  // still terminate (and keep the rows it found).
  const stub = withFetchStub({ ok: true, body: [{ id: 7 }, { id: 8 }] });
  try {
    const all = await fetchAllMessages(2, {});
    assert.deepEqual(all.map(m => m.id), [7, 8]);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('fetchAllMessages skips rows without an id and forwards retrieval flags', async () => {
  const stub = withFetchStub({ ok: true, body: [{ rx_time: 40 }] }); // no id → skipped, short page
  try {
    const all = await fetchAllMessages(2, { encrypted: true });
    assert.deepEqual(all, []);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes('encrypted=true'));
  } finally {
    stub.restore();
  }
});

test('fetchAllMessages honours the maxPages backstop against a runaway feed', async () => {
  // Every page is full and strictly older, so only maxPages bounds the walk.
  let n = 0;
  const stub = withFetchStub(() => {
    n += 1;
    return { ok: true, body: [{ id: 100 - n, rx_time: 100 - n }] };
  });
  try {
    const all = await fetchAllMessages(1, { maxPages: 3 });
    assert.equal(all.length, 3);
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// paginateMessages (issue #802 progressive backward pagination)
// ---------------------------------------------------------------------------

test('paginateMessages yields each page of fresh rows separately as it pages back', async () => {
  // Two full pages then a short page; the inclusive cursor re-returns the
  // boundary row, which must be de-duplicated out of the later yield.
  const stub = withFetchStub((url) => {
    if (url.includes('before=30')) {
      return { ok: true, body: [{ id: 3, rx_time: 30 }] }; // short → stop (all seen)
    }
    if (url.includes('before=40')) {
      return { ok: true, body: [{ id: 4, rx_time: 40 }, { id: 3, rx_time: 30 }] };
    }
    return { ok: true, body: [{ id: 5, rx_time: 50 }, { id: 4, rx_time: 40 }] };
  });
  try {
    const pages = [];
    for await (const batch of paginateMessages(2, {})) {
      pages.push(batch.map(m => m.id));
    }
    // One array per page, each carrying only that page's newly-seen ids — proof
    // the caller can render progressively instead of awaiting the whole window.
    assert.deepEqual(pages, [[5, 4], [3]]);
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('paginateMessages seeds its first request from a positive before cursor', async () => {
  // A single short page so the walk stops after the seeded request.
  const stub = withFetchStub({ ok: true, body: [{ id: 9, rx_time: 90 }] });
  try {
    const pages = [];
    for await (const batch of paginateMessages(2, { before: 500 })) {
      pages.push(batch);
    }
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes('before=500'), stub.calls[0].url);
    assert.deepEqual(pages.flat().map(m => m.id), [9]);
  } finally {
    stub.restore();
  }
});

test('paginateMessages ignores a non-finite before seed', async () => {
  const stub = withFetchStub({ ok: true, body: [{ id: 1, rx_time: 10 }] });
  try {
    const pages = [];
    for await (const batch of paginateMessages(2, { before: Number.NaN })) {
      pages.push(batch);
    }
    assert.equal(stub.calls.length, 1);
    assert.ok(!stub.calls[0].url.includes('before='), stub.calls[0].url);
  } finally {
    stub.restore();
  }
});

test('paginateMessages stops cleanly when a page is not an array', async () => {
  // A malformed (non-array) JSON body must end the walk rather than throw.
  const stub = withFetchStub({ ok: true, body: { error: 'nope' } });
  try {
    const pages = [];
    for await (const batch of paginateMessages(2, {})) {
      pages.push(batch);
    }
    assert.deepEqual(pages, []);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// responsePromise (cold-load boot prefetch consumption)
// ---------------------------------------------------------------------------

/** Build a Response-like resolved value with the given JSON body. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('fetchNodes consumes a supplied responsePromise without hitting the network', async () => {
  const stub = withFetchStub({ ok: true, body: [{ node_id: '!net' }] });
  try {
    const boot = Promise.resolve(jsonResponse([{ node_id: '!boot' }]));
    const nodes = await fetchNodes(NODE_LIMIT, 0, { responsePromise: boot });
    assert.deepEqual(nodes, [{ node_id: '!boot' }]);
    assert.equal(stub.calls.length, 0, 'the prefetched response is used, no fetch issued');
  } finally {
    stub.restore();
  }
});

test('fetchTraces still applies the recency filter to a prefetched response', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const boot = Promise.resolve(jsonResponse([
      { id: 1, rx_time: nowSeconds },              // recent — kept
      { id: 2, rx_time: nowSeconds - 40 * 86400 }, // older than the 28-day TRACE_MAX_AGE — dropped
    ]));
    const traces = await fetchTraces(TRACE_LIMIT, 0, { responsePromise: boot });
    assert.deepEqual(traces.map(t => t.id), [1]);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('fetchMessages consumes a supplied responsePromise', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    const boot = Promise.resolve(jsonResponse([{ id: 7, text: 'boot' }]));
    const messages = await fetchMessages(NODE_LIMIT, { responsePromise: boot });
    assert.deepEqual(messages, [{ id: 7, text: 'boot' }]);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a rejected responsePromise falls back to a fresh network fetch', async () => {
  const stub = withFetchStub({ ok: true, body: [{ node_id: '!fallback' }] });
  try {
    const boot = Promise.reject(new Error('prefetch died'));
    const nodes = await fetchNodes(NODE_LIMIT, 0, { responsePromise: boot });
    assert.deepEqual(nodes, [{ node_id: '!fallback' }]);
    assert.equal(stub.calls.length, 1, 'a failed prefetch re-fetches so data is never lost');
    assert.ok(stub.calls[0].url.startsWith('/api/nodes?'));
  } finally {
    stub.restore();
  }
});

test('a prefetched non-ok response throws like a failed fetch', async () => {
  const stub = withFetchStub({ ok: true, body: [] });
  try {
    const boot = Promise.resolve(jsonResponse(null, { ok: false, status: 503 }));
    await assert.rejects(() => fetchPositions(NODE_LIMIT, 0, { responsePromise: boot }), /HTTP 503/);
  } finally {
    stub.restore();
  }
});
