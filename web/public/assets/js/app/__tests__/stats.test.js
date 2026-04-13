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
  computeLocalActiveNodeStats,
  normaliseActiveNodeStatsPayload,
  fetchActiveNodeStats,
  formatActiveNodeStatsText,
} from '../stats.js';

const NOW = 1_700_000_000;

// ---------------------------------------------------------------------------
// computeLocalActiveNodeStats
// ---------------------------------------------------------------------------

test('computeLocalActiveNodeStats counts nodes within each window', () => {
  const nodes = [
    { last_heard: NOW - 60, protocol: 'meshtastic' },   // within hour, day, week, month
    { last_heard: NOW - 4_000, protocol: 'meshcore' },   // within day, week, month
    { last_heard: NOW - 90_000, protocol: 'meshtastic' }, // within week, month
    { last_heard: NOW - (8 * 86_400), protocol: 'meshcore' },  // within month only
    { last_heard: NOW - (20 * 86_400), protocol: 'meshtastic' }, // within month only
  ];

  const result = computeLocalActiveNodeStats(nodes, NOW);
  assert.equal(result.hour, 1);
  assert.equal(result.day, 2);
  assert.equal(result.week, 3);
  assert.equal(result.month, 5);
  assert.equal(result.sampled, true);
  assert.deepEqual(result.meshcore, { hour: 0, day: 1, week: 1, month: 2 });
  assert.deepEqual(result.meshtastic, { hour: 1, day: 1, week: 2, month: 3 });
});

test('computeLocalActiveNodeStats returns zero counts for empty node array', () => {
  const result = computeLocalActiveNodeStats([], NOW);
  assert.equal(result.hour, 0);
  assert.equal(result.day, 0);
  assert.equal(result.week, 0);
  assert.equal(result.month, 0);
  assert.equal(result.sampled, true);
  assert.deepEqual(result.meshcore, { hour: 0, day: 0, week: 0, month: 0 });
  assert.deepEqual(result.meshtastic, { hour: 0, day: 0, week: 0, month: 0 });
});

test('computeLocalActiveNodeStats handles non-array nodes gracefully', () => {
  const result = computeLocalActiveNodeStats(null, NOW);
  assert.equal(result.hour, 0);
  assert.deepEqual(result.meshcore, { hour: 0, day: 0, week: 0, month: 0 });
  const result2 = computeLocalActiveNodeStats(undefined, NOW);
  assert.equal(result2.hour, 0);
  assert.deepEqual(result2.meshcore, { hour: 0, day: 0, week: 0, month: 0 });
});

test('computeLocalActiveNodeStats ignores nodes with missing last_heard', () => {
  const nodes = [
    { last_heard: null },
    {},
    { last_heard: undefined },
    { last_heard: 'not-a-number' },
  ];
  const result = computeLocalActiveNodeStats(nodes, NOW);
  assert.equal(result.hour, 0);
  assert.deepEqual(result.meshcore, { hour: 0, day: 0, week: 0, month: 0 });
  assert.deepEqual(result.meshtastic, { hour: 0, day: 0, week: 0, month: 0 });
});

test('computeLocalActiveNodeStats uses Date.now() when nowSeconds is non-finite', () => {
  // Just verify it runs without throwing and returns numeric counts.
  const result = computeLocalActiveNodeStats([{ last_heard: Date.now() / 1000 - 60 }], NaN);
  assert.equal(typeof result.hour, 'number');
  assert.ok(result.hour >= 0);
  assert.ok(result.meshcore != null);
});

test('computeLocalActiveNodeStats counts nodes exactly at window boundary', () => {
  // A node whose last_heard equals exactly now - 3600 is within the hour window (<=).
  const nodes = [{ last_heard: NOW - 3600, protocol: 'meshtastic' }];
  const result = computeLocalActiveNodeStats(nodes, NOW);
  assert.equal(result.hour, 1);
  assert.equal(result.meshtastic.hour, 1);
  assert.equal(result.meshcore.hour, 0);
});

test('computeLocalActiveNodeStats bins unknown protocols into meshtastic bucket', () => {
  const nodes = [
    { last_heard: NOW - 100, protocol: 'reticulum' },
    { last_heard: NOW - 200, protocol: 'meshcore' },
  ];
  const result = computeLocalActiveNodeStats(nodes, NOW);
  assert.equal(result.hour, 2);
  assert.equal(result.meshcore.hour, 1);
  assert.equal(result.meshtastic.hour, 1);
});

// ---------------------------------------------------------------------------
// normaliseActiveNodeStatsPayload
// ---------------------------------------------------------------------------

test('normaliseActiveNodeStatsPayload validates and normalises API payload', () => {
  const result = normaliseActiveNodeStatsPayload({
    active_nodes: { hour: '11', day: 22, week: 33, month: 44 },
    sampled: false,
  });
  assert.equal(result.hour, 11);
  assert.equal(result.day, 22);
  assert.equal(result.week, 33);
  assert.equal(result.month, 44);
  assert.equal(result.sampled, false);
});

test('normaliseActiveNodeStatsPayload includes per-protocol buckets when present', () => {
  const result = normaliseActiveNodeStatsPayload({
    active_nodes: { hour: 10, day: 20, week: 30, month: 40 },
    meshcore: { hour: 3, day: 8, week: 12, month: 15 },
    meshtastic: { hour: 7, day: 12, week: 18, month: 25 },
    sampled: false,
  });
  assert.deepEqual(result.meshcore, { hour: 3, day: 8, week: 12, month: 15 });
  assert.deepEqual(result.meshtastic, { hour: 7, day: 12, week: 18, month: 25 });
});

test('normaliseActiveNodeStatsPayload omits per-protocol buckets when absent', () => {
  const result = normaliseActiveNodeStatsPayload({
    active_nodes: { hour: 1, day: 2, week: 3, month: 4 },
    sampled: false,
  });
  assert.equal(result.meshcore, undefined);
  assert.equal(result.meshtastic, undefined);
});

test('normaliseActiveNodeStatsPayload ignores malformed per-protocol buckets', () => {
  const result = normaliseActiveNodeStatsPayload({
    active_nodes: { hour: 1, day: 2, week: 3, month: 4 },
    meshcore: { hour: 'bad', day: 1, week: 1, month: 1 },
    meshtastic: 'not-an-object',
    sampled: false,
  });
  assert.equal(result.hour, 1);
  assert.equal(result.meshcore, undefined);
  assert.equal(result.meshtastic, undefined);
});

test('normaliseActiveNodeStatsPayload returns null for missing active_nodes', () => {
  assert.equal(normaliseActiveNodeStatsPayload({}), null);
  assert.equal(normaliseActiveNodeStatsPayload({ active_nodes: null }), null);
});

test('normaliseActiveNodeStatsPayload returns null when any stat is non-numeric', () => {
  assert.equal(
    normaliseActiveNodeStatsPayload({ active_nodes: { hour: 'x', day: 1, week: 1, month: 1 } }),
    null
  );
});

test('normaliseActiveNodeStatsPayload clamps negatives and truncates floats', () => {
  assert.deepEqual(
    normaliseActiveNodeStatsPayload({
      active_nodes: { hour: -1.9, day: 2.8, week: 3.1, month: 4.9 },
      sampled: 1,
    }),
    { hour: 0, day: 2, week: 3, month: 4, sampled: true }
  );
});

test('normaliseActiveNodeStatsPayload returns null for null/non-object input', () => {
  assert.equal(normaliseActiveNodeStatsPayload(null), null);
  assert.equal(normaliseActiveNodeStatsPayload('string'), null);
});

// ---------------------------------------------------------------------------
// fetchActiveNodeStats
// ---------------------------------------------------------------------------

test('fetchActiveNodeStats returns remote stats when /api/stats succeeds', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return { active_nodes: { hour: 5, day: 15, week: 25, month: 35 }, sampled: false };
      },
    };
  };

  const stats = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl });

  assert.equal(calls[0], '/api/stats');
  assert.deepEqual(stats, { hour: 5, day: 15, week: 25, month: 35, sampled: false });
});

test('fetchActiveNodeStats falls back to local counts on network error', async () => {
  const nodes = [
    { last_heard: NOW - 120, protocol: 'meshtastic' },
    { last_heard: NOW - (10 * 86_400), protocol: 'meshcore' },
  ];
  const stats = await fetchActiveNodeStats({
    nodes,
    nowSeconds: NOW,
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.equal(stats.hour, 1);
  assert.equal(stats.day, 1);
  assert.equal(stats.week, 1);
  assert.equal(stats.month, 2);
  assert.equal(stats.sampled, true);
  assert.ok(stats.meshcore != null, 'fallback should include meshcore');
  assert.ok(stats.meshtastic != null, 'fallback should include meshtastic');
});

test('fetchActiveNodeStats falls back to local counts on non-OK status', async () => {
  const stats = await fetchActiveNodeStats({
    nodes: [{ last_heard: NOW - 10 }],
    nowSeconds: NOW,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(stats.sampled, true);
  assert.equal(stats.hour, 1);
});

test('fetchActiveNodeStats falls back to local counts on invalid payload', async () => {
  const stats = await fetchActiveNodeStats({
    nodes: [{ last_heard: NOW - (31 * 86_400) }],
    nowSeconds: NOW,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { active_nodes: { hour: 'bad' } }; },
    }),
  });
  assert.equal(stats.sampled, true);
  assert.equal(stats.month, 0);
});

test('fetchActiveNodeStats reuses cached result for repeated calls with same fetchImpl', async () => {
  const calls = [];
  // Use a fresh function object so it does not share cache with earlier tests.
  const freshFetch = async url => {
    calls.push(url);
    return {
      ok: true,
      async json() { return { active_nodes: { hour: 1, day: 2, week: 3, month: 4 }, sampled: false }; },
    };
  };

  const first = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: freshFetch });
  const second = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: freshFetch });

  // The second call should hit the cache and not issue another fetch.
  assert.equal(calls.length, 1, 'only one fetch should be issued when cache is warm');
  assert.deepEqual(first, second);
});

test('fetchActiveNodeStats concurrent calls share a single in-flight request', async () => {
  const calls = [];
  let resolveResponse;
  const responsePromise = new Promise(resolve => { resolveResponse = resolve; });

  // Use a fresh function so no existing cache applies.
  const concFetch = async url => {
    calls.push(url);
    return responsePromise;
  };

  // Fire two concurrent fetches before the response resolves.
  const [p1, p2] = [
    fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: concFetch }),
    fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: concFetch }),
  ];
  // Now let the response settle.
  resolveResponse({
    ok: true,
    async json() { return { active_nodes: { hour: 9, day: 9, week: 9, month: 9 }, sampled: false }; },
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2, 'concurrent requests should receive the same result');
});

// ---------------------------------------------------------------------------
// formatActiveNodeStatsText
// ---------------------------------------------------------------------------

test('formatActiveNodeStatsText emits compact day/week/month string', () => {
  assert.equal(
    formatActiveNodeStatsText({
      stats: { day: 2, week: 3, month: 4, sampled: false },
    }),
    '2/day \u00b7 3/week \u00b7 4/month'
  );
});

test('formatActiveNodeStatsText handles missing or null stats gracefully', () => {
  const text = formatActiveNodeStatsText({ stats: null });
  assert.equal(text, '0/day \u00b7 0/week \u00b7 0/month', 'defaults to zero counts for null stats');
});
