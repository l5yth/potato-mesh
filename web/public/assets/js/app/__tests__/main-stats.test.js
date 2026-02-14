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
  fetchPaginatedCollection,
  fetchActiveNodeStats,
  formatActiveNodeStatsText,
  normaliseActiveNodeStatsPayload,
  readNextCursorHeader,
} from '../main.js';

const NOW = 1_700_000_000;

test('computeLocalActiveNodeStats calculates local hour/day/week/month counts', () => {
  const nodes = [
    { last_heard: NOW - 60 },
    { last_heard: NOW - 4_000 },
    { last_heard: NOW - 90_000 },
    { last_heard: NOW - (8 * 86_400) },
    { last_heard: NOW - (20 * 86_400) },
  ];

  const stats = computeLocalActiveNodeStats(nodes, NOW);

  assert.deepEqual(stats, {
    hour: 1,
    day: 2,
    week: 3,
    month: 5,
    sampled: true,
  });
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

  assert.deepEqual(normaliseActiveNodeStatsPayload(payload), {
    hour: 11,
    day: 22,
    week: 33,
    month: 44,
    sampled: false,
  });

  assert.equal(normaliseActiveNodeStatsPayload({}), null);
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

test('fetchActiveNodeStats does not reuse cache across different fetch implementations', async () => {
  const callsA = [];
  const callsB = [];
  const fetchImplA = async (url) => {
    callsA.push(url);
    return {
      ok: true,
      async json() {
        return { active_nodes: { hour: 1, day: 1, week: 1, month: 1 }, sampled: false };
      },
    };
  };
  const fetchImplB = async (url) => {
    callsB.push(url);
    return {
      ok: true,
      async json() {
        return { active_nodes: { hour: 2, day: 2, week: 2, month: 2 }, sampled: false };
      },
    };
  };

  await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: fetchImplA });
  await fetchActiveNodeStats({ nodes: [], nowSeconds: NOW, fetchImpl: fetchImplB });

  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 1);
});

test('fetchActiveNodeStats falls back to local counts when stats fetch fails', async () => {
  const nodes = [
    { last_heard: NOW - 120 },
    { last_heard: NOW - (10 * 86_400) },
  ];
  const fetchImpl = async () => {
    throw new Error('network down');
  };

  const stats = await fetchActiveNodeStats({ nodes, nowSeconds: NOW, fetchImpl });

  assert.deepEqual(stats, {
    hour: 1,
    day: 1,
    week: 1,
    month: 2,
    sampled: true,
  });
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

test('formatActiveNodeStatsText emits expected dashboard string', () => {
  const text = formatActiveNodeStatsText({
    channel: 'LongFast',
    frequency: '868MHz',
    stats: { hour: 1, day: 2, week: 3, month: 4, sampled: false },
  });

  assert.equal(
    text,
    'LongFast (868MHz) — active nodes: 1/hour, 2/day, 3/week, 4/month.'
  );
});

test('formatActiveNodeStatsText appends sampled marker when local fallback is used', () => {
  const text = formatActiveNodeStatsText({
    channel: 'LongFast',
    frequency: '868MHz',
    stats: { hour: 9, day: 8, week: 7, month: 6, sampled: true },
  });

  assert.equal(
    text,
    'LongFast (868MHz) — active nodes: 9/hour, 8/day, 7/week, 6/month (sampled).'
  );
});

test('readNextCursorHeader reads cursor token from response headers', () => {
  const response = {
    headers: {
      get(name) {
        return name === 'X-Next-Cursor' ? 'cursor-token' : null;
      },
    },
  };
  assert.equal(readNextCursorHeader(response), 'cursor-token');
});

test('readNextCursorHeader returns null when response headers are missing', () => {
  assert.equal(readNextCursorHeader(null), null);
  assert.equal(readNextCursorHeader({ headers: {} }), null);
});

test('fetchPaginatedCollection follows cursor headers and merges pages', async () => {
  const calls = [];
  const pages = new Map([
    ['/api/nodes?limit=2', { items: [{ id: 'a' }, { id: 'b' }], next: 'cursor-1' }],
    ['/api/nodes?limit=2&cursor=cursor-1', { items: [{ id: 'c' }], next: null }],
  ]);
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = pages.get(url);
    if (!page) {
      throw new Error(`unexpected url ${url}`);
    }
    return {
      ok: true,
      headers: { get: (name) => (name === 'X-Next-Cursor' ? page.next : null) },
      async json() {
        return page.items;
      },
    };
  };

  const items = await fetchPaginatedCollection({
    path: '/api/nodes',
    limit: 2,
    maxRows: 10,
    fetchImpl,
  });

  assert.deepEqual(calls, ['/api/nodes?limit=2', '/api/nodes?limit=2&cursor=cursor-1']);
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c']);
});

test('fetchPaginatedCollection returns empty list when path is missing', async () => {
  const items = await fetchPaginatedCollection({
    path: '',
    limit: 10,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => [] }),
  });
  assert.deepEqual(items, []);
});

test('fetchPaginatedCollection enforces maxRows and propagates params', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      headers: { get: () => (url.includes('cursor=') ? null : 'next-1') },
      async json() {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      },
    };
  };
  const items = await fetchPaginatedCollection({
    path: '/api/messages',
    limit: 3,
    maxRows: 4,
    params: { since: '123', encrypted: 'true' },
    fetchImpl,
  });

  assert.equal(calls[0], '/api/messages?limit=3&since=123&encrypted=true');
  assert.equal(items.length, 4);
});

test('fetchPaginatedCollection throws on non-ok responses', async () => {
  await assert.rejects(
    fetchPaginatedCollection({
      path: '/api/messages',
      limit: 2,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => [] }),
    }),
    /HTTP 503/
  );
});

test('fetchPaginatedCollection throws on invalid payload shapes', async () => {
  await assert.rejects(
    fetchPaginatedCollection({
      path: '/api/messages',
      limit: 2,
      fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({}) }),
    }),
    /invalid paginated payload/
  );
});

test('fetchPaginatedCollection ignores blank params and defaults invalid limits', async () => {
  const calls = [];
  const items = await fetchPaginatedCollection({
    path: '/api/messages',
    limit: 0,
    maxRows: 0,
    params: { since: ' ', encrypted: null, scope: 'recent' },
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        headers: { get: () => null },
        async json() {
          return [{ id: 1 }];
        },
      };
    },
  });

  assert.deepEqual(items, [{ id: 1 }]);
  assert.equal(calls[0], '/api/messages?limit=200&scope=recent');
});

test('fetchPaginatedCollection stops when a page is empty even if cursor was present', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/nodes?limit=2') {
      return {
        ok: true,
        headers: { get: (name) => (name === 'X-Next-Cursor' ? 'cursor-1' : null) },
        async json() {
          return [{ id: 'a' }];
        },
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      async json() {
        return [];
      },
    };
  };

  const items = await fetchPaginatedCollection({
    path: '/api/nodes',
    limit: 2,
    fetchImpl,
  });

  assert.deepEqual(items, [{ id: 'a' }]);
  assert.deepEqual(calls, ['/api/nodes?limit=2', '/api/nodes?limit=2&cursor=cursor-1']);
});
