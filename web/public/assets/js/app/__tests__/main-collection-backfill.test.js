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
 * Regression guard for issue #832 (frontend data population).
 *
 * The server supports backward `?before=` pagination on every bulk collection
 * (SPEC BP1-BP8), but only the message feed wired it on the client — so the
 * node table (and positions / telemetry / neighbors / traces) stalled at the
 * newest `MAX_QUERY_LIMIT` (1000) rows the server returns in one page.  This
 * test pins the fix (SPEC BP9a follow-up): after the newest page paints, every
 * bulk collection pages backward through its visibility window in the
 * background, so the table fills past the first 1000 rows.
 *
 * @module app/__tests__/main-collection-backfill
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomEnvironment } from './dom-environment.js';
import { initializeApp } from '../main.js';
import { NODE_LIMIT, TRACE_LIMIT } from '../main/constants.js';

/** Minimal config that disables the auto-refresh timer so timing is ours. */
const BASE_CONFIG = Object.freeze({
  channel: 'Primary',
  frequency: '915MHz',
  refreshMs: 0,
  refreshIntervalSeconds: 0,
  chatEnabled: true,
  mapCenter: { lat: 0, lon: 0 },
  mapZoom: null,
  maxDistanceKm: 0,
  instancesFeatureEnabled: false,
  instanceDomain: null,
  snapshotWindowSeconds: 3600,
});

/** Build a resolved fetch-style response around a JSON body. */
function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Yield to pending microtasks/timers so the background backfill settles. */
function settle(ms = 120) {
  return new Promise(r => setTimeout(r, ms));
}

/** Format an integer as a canonical `!%08x` node id. */
const nid = n => `!${n.toString(16).padStart(8, '0')}`;

test('every bulk collection pages backward past the first 1000-row page (#832)', async () => {
  const now = Math.floor(Date.now() / 1000);

  // Full newest pages (=== the per-collection cap) so each backfill continues to
  // an older page; a short page would (correctly) mean the window is exhausted.
  const newestNodes = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    node_id: nid(0x10000 + i), last_heard: now - i, short_name: `N${i}`, role: 'CLIENT',
  }));
  const newestPositions = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    id: 1_000_000 + i, node_id: nid(0x10000 + i), rx_time: now - i, latitude: 52, longitude: 13,
  }));
  const newestTelemetry = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    id: 2_000_000 + i, node_id: nid(0x10000 + i), rx_time: now - i, battery_level: 50,
  }));
  const newestNeighbors = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    node_id: nid(0x10000 + i), neighbor_id: nid(0x10001 + i), rx_time: now - i, snr: 5,
  }));
  const newestTraces = Array.from({ length: TRACE_LIMIT }, (_, i) => ({
    id: 3_000_000 + i, rx_time: now - i, from_id: nid(0x10000 + i), to_id: nid(0x20000 + i),
  }));

  // One older row per collection (a short page → the walk stops after one step).
  const older = now - NODE_LIMIT - 50;
  const olderNodes = [{ node_id: '!aaaa0001', last_heard: older, short_name: 'OLD', role: 'CLIENT' }];
  const olderPositions = [{ id: 1_900_000, node_id: '!aaaa0001', rx_time: older, latitude: 52, longitude: 13 }];
  const olderTelemetry = [{ id: 2_900_000, node_id: '!aaaa0001', rx_time: older, battery_level: 10 }];
  const olderNeighbors = [{ node_id: '!aaaa0001', neighbor_id: '!aaaa0002', rx_time: older, snr: 1 }];
  const olderTraces = [{ id: 3_900_000, rx_time: older, from_id: '!aaaa0001', to_id: '!aaaa0002' }];

  const beforeRequested = {
    nodes: false, positions: false, telemetry: false, neighbors: false, traces: false,
  };

  function stubFetch(url) {
    // The hydrator must not fall back to per-node lookups (it resolves from the
    // bulk map); answer 404-equivalent just in case.
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    const isBefore = url.includes('before=');
    if (url.startsWith('/api/nodes')) {
      if (isBefore) { beforeRequested.nodes = true; return jsonResponse(olderNodes); }
      return jsonResponse(newestNodes);
    }
    if (url.startsWith('/api/positions')) {
      if (isBefore) { beforeRequested.positions = true; return jsonResponse(olderPositions); }
      return jsonResponse(newestPositions);
    }
    if (url.startsWith('/api/telemetry')) {
      if (isBefore) { beforeRequested.telemetry = true; return jsonResponse(olderTelemetry); }
      return jsonResponse(newestTelemetry);
    }
    if (url.startsWith('/api/neighbors')) {
      if (isBefore) { beforeRequested.neighbors = true; return jsonResponse(olderNeighbors); }
      return jsonResponse(newestNeighbors);
    }
    if (url.startsWith('/api/traces')) {
      if (isBefore) { beforeRequested.traces = true; return jsonResponse(olderTraces); }
      return jsonResponse(newestTraces);
    }
    if (url.startsWith('/api/messages')) return jsonResponse([]); // chat empty → no interference
    return jsonResponse([]); // /api/stats and anything else
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;

    // The newest page paints first — the table is filled to the server's cap
    // before any backward paging happens (so the page is never blank/blocking).
    assert.equal(
      _testUtils.getLoadedNodeCount(), NODE_LIMIT,
      'the newest page must render before backward paging starts',
    );

    // Let the one-shot background backfill page each collection backward.
    await _testUtils.flushCollectionBackfills();
    await settle();

    // Every bulk collection paged backward via ?before= — the core of the fix.
    assert.deepEqual(
      beforeRequested,
      { nodes: true, positions: true, telemetry: true, neighbors: true, traces: true },
      'each bulk collection must page backward through its window, not stall at the newest 1000 rows',
    );

    // The node table grew past the single 1000-row page (the user-visible bug:
    // "the node table only lists 1000 items").
    assert.equal(
      _testUtils.getLoadedNodeCount(), NODE_LIMIT + 1,
      `older nodes beyond the first page must be backfilled in (loaded=${_testUtils.getLoadedNodeCount()})`,
    );
    // The other four collections also grew by their one older page.
    assert.equal(_testUtils.getLoadedPositionCount(), NODE_LIMIT + 1, 'positions backfilled');
    assert.equal(_testUtils.getLoadedTelemetryCount(), NODE_LIMIT + 1, 'telemetry backfilled');
    assert.equal(_testUtils.getLoadedNeighborCount(), NODE_LIMIT + 1, 'neighbors backfilled');
    assert.equal(_testUtils.getLoadedTraceCount(), TRACE_LIMIT + 1, 'traces backfilled');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a short newest page records no frontier and fires no backward request (#832)', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Every newest page is *short* (< the per-collection cap) ⇒ the window is
  // already exhausted, so the backfill must record no frontier and issue no
  // ?before= request (no empty, long-loading page — the perf requirement).
  const nodes = [{ node_id: '!aaaa0001', last_heard: now, short_name: 'A', role: 'CLIENT' }];
  const beforeSeen = [];
  function stubFetch(url) {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.includes('before=')) beforeSeen.push(url);
    if (url.startsWith('/api/nodes')) return jsonResponse(nodes);
    if (url.startsWith('/api/messages')) return jsonResponse([]);
    return jsonResponse([]); // positions / telemetry / neighbors / traces / stats short
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCollectionBackfills();
    await settle();
    assert.deepEqual(beforeSeen, [], 'no collection should page backward when its window is not full');
    assert.equal(_testUtils.getLoadedNodeCount(), 1, 'the single short page is shown as-is');
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('a failed backfill page is swallowed and leaves the newest page intact (#832)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const newestNodes = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    node_id: nid(0x10000 + i), last_heard: now - i, short_name: `N${i}`, role: 'CLIENT',
  }));
  function stubFetch(url) {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) {
      if (url.includes('before=')) return Promise.reject(new Error('nodes backfill boom'));
      return jsonResponse(newestNodes);
    }
    if (url.startsWith('/api/messages')) return jsonResponse([]);
    return jsonResponse([]);
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCollectionBackfills();
    await settle();
    // The rejected backward page is caught (not rethrown) and the newest page
    // stays rendered.
    assert.equal(_testUtils.getLoadedNodeCount(), NODE_LIMIT);
    assert.ok(
      warnings.some(args => String(args[0]).includes('nodes backfill failed')),
      'the backfill failure should be logged, not rethrown',
    );
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('the node backfill walks multiple older pages until the window is exhausted (#832)', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Newest page (full) → first older page (full, strictly older) → short page.
  const newestNodes = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    node_id: nid(0x10000 + i), last_heard: now - i, short_name: `N${i}`, role: 'CLIENT',
  }));
  const olderPage1 = Array.from({ length: NODE_LIMIT }, (_, i) => ({
    node_id: nid(0x80000 + i), last_heard: now - NODE_LIMIT - i, short_name: `O${i}`, role: 'CLIENT',
  }));
  const olderPage2 = [{ node_id: '!ffff0001', last_heard: now - 2 * NODE_LIMIT - 5, short_name: 'LAST', role: 'CLIENT' }];

  let nodeBeforeCount = 0;
  function stubFetch(url) {
    if (url.startsWith('/api/nodes/')) return jsonResponse(null);
    if (url.startsWith('/api/nodes')) {
      if (url.includes('before=')) {
        nodeBeforeCount += 1;
        if (nodeBeforeCount === 1) return jsonResponse(olderPage1); // full → keep paging
        if (nodeBeforeCount === 2) return jsonResponse(olderPage2); // short → stop
        return jsonResponse([]);
      }
      return jsonResponse(newestNodes);
    }
    if (url.startsWith('/api/messages')) return jsonResponse([]);
    return jsonResponse([]);
  }

  const env = createDomEnvironment({ includeBody: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = url => stubFetch(url);
  try {
    const { _testUtils } = initializeApp(BASE_CONFIG);
    await _testUtils.initialLoad;
    await _testUtils.flushCollectionBackfills();
    await settle();
    assert.equal(nodeBeforeCount, 2, 'paged backward twice, then stopped on the short page');
    assert.equal(
      _testUtils.getLoadedNodeCount(), NODE_LIMIT * 2 + 1,
      `the whole window must be paged in (loaded=${_testUtils.getLoadedNodeCount()})`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});
