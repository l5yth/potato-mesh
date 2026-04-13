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
  fetchActiveNodeStats,
  formatActiveNodeStatsText,
  normaliseActiveNodeStatsPayload,
} from '../main.js';

const NOW = 1_700_000_000;

test('computeLocalActiveNodeStats calculates local hour/day/week/month counts with per-protocol data', () => {
  const nodes = [
    { last_heard: NOW - 60, protocol: 'meshtastic' },
    { last_heard: NOW - 4_000, protocol: 'meshcore' },
    { last_heard: NOW - 90_000, protocol: 'meshtastic' },
    { last_heard: NOW - (8 * 86_400), protocol: 'meshcore' },
    { last_heard: NOW - (20 * 86_400), protocol: 'meshtastic' },
  ];

  const stats = computeLocalActiveNodeStats(nodes, NOW);

  assert.equal(stats.hour, 1);
  assert.equal(stats.day, 2);
  assert.equal(stats.week, 3);
  assert.equal(stats.month, 5);
  assert.equal(stats.sampled, true);
  assert.deepEqual(stats.meshcore, { hour: 0, day: 1, week: 1, month: 2 });
  assert.deepEqual(stats.meshtastic, { hour: 1, day: 1, week: 2, month: 3 });
});

test('normaliseActiveNodeStatsPayload validates and normalizes API payload', () => {
  const payload = {
    active_nodes: {
      hour: '11',
      day: 22,
      week: 33,
      month: 44,
    },
    sampled: false,
  };

  const result = normaliseActiveNodeStatsPayload(payload);
  assert.equal(result.hour, 11);
  assert.equal(result.day, 22);
  assert.equal(result.week, 33);
  assert.equal(result.month, 44);
  assert.equal(result.sampled, false);

  assert.equal(normaliseActiveNodeStatsPayload({}), null);
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

test('normaliseActiveNodeStatsPayload rejects malformed stat values', () => {
  assert.equal(
    normaliseActiveNodeStatsPayload({ active_nodes: { hour: 'x', day: 1, week: 1, month: 1 } }),
    null
  );
  assert.equal(
    normaliseActiveNodeStatsPayload({ active_nodes: null }),
    null
  );
});

test('normaliseActiveNodeStatsPayload clamps negatives and truncates floats', () => {
  assert.deepEqual(
    normaliseActiveNodeStatsPayload({
      active_nodes: { hour: -1.9, day: 2.8, week: 3.1, month: 4.9 },
      sampled: 1
    }),
    { hour: 0, day: 2, week: 3, month: 4, sampled: true }
  );
});

test('fetchActiveNodeStats uses /api/stats when available', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return {
          active_nodes: { hour: 5, day: 15, week: 25, month: 35 },
          sampled: false,
        };
      },
    };
  };

  const stats = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl });

  assert.equal(calls[0], '/api/stats');
  assert.deepEqual(stats, {
    hour: 5,
    day: 15,
    week: 25,
    month: 35,
    sampled: false,
  });
});

test('fetchActiveNodeStats reuses cached /api/stats response for repeated calls', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return {
          active_nodes: { hour: 2, day: 4, week: 6, month: 8 },
          sampled: false,
        };
      },
    };
  };

  const first = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl });
  const second = await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl });

  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
});

test('fetchActiveNodeStats falls back to local counts when stats fetch fails', async () => {
  const nodes = [
    { last_heard: NOW - 120, protocol: 'meshtastic' },
    { last_heard: NOW - (10 * 86_400), protocol: 'meshcore' },
  ];
  const fetchImpl = async () => {
    throw new Error('network down');
  };

  const stats = await fetchActiveNodeStats({ nodes, nowSeconds: NOW, fetchImpl });

  assert.equal(stats.hour, 1);
  assert.equal(stats.day, 1);
  assert.equal(stats.week, 1);
  assert.equal(stats.month, 2);
  assert.equal(stats.sampled, true);
  assert.ok(stats.meshcore != null, 'fallback should include meshcore');
  assert.ok(stats.meshtastic != null, 'fallback should include meshtastic');
});

test('fetchActiveNodeStats falls back to local counts on non-OK HTTP responses', async () => {
  const stats = await fetchActiveNodeStats({
    nodes: [{ last_heard: NOW - 10 }],
    nowSeconds: NOW,
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(stats.sampled, true);
  assert.equal(stats.hour, 1);
});

test('fetchActiveNodeStats falls back to local counts on invalid payloads', async () => {
  const stats = await fetchActiveNodeStats({
    nodes: [{ last_heard: NOW - (31 * 86_400) }],
    nowSeconds: NOW,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { active_nodes: { hour: 'bad' } };
      }
    })
  });
  assert.equal(stats.sampled, true);
  assert.equal(stats.month, 0);
});

test('formatActiveNodeStatsText emits compact day/week/month footer string', () => {
  const text = formatActiveNodeStatsText({
    stats: { day: 2, week: 3, month: 4, sampled: false },
  });

  assert.equal(text, '2/day \u00b7 3/week \u00b7 4/month');
});
