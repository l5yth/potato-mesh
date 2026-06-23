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
  isStale,
  isExpired,
  recordTimestampSeconds,
  CACHE_STALENESS_SECONDS,
  CACHE_RETENTION_SECONDS,
} from '../cache-lifetime.js';

const DAY = 24 * 60 * 60;
const NOW = 1_000_000_000; // arbitrary unix-seconds anchor

const ago = seconds => NOW - seconds;

// --- recordTimestampSeconds ---------------------------------------------

test('recordTimestampSeconds picks the first usable field per collection', () => {
  assert.equal(recordTimestampSeconds('nodes', { last_heard: 111 }), 111);
  assert.equal(recordTimestampSeconds('nodes', { lastHeard: 222 }), 222); // camelCase
  assert.equal(recordTimestampSeconds('messages', { rx_time: 333 }), 333);
  assert.equal(recordTimestampSeconds('positions', { position_time: 444 }), 444); // fallback
  assert.equal(recordTimestampSeconds('telemetry', { telemetry_time: 555 }), 555); // fallback
  assert.equal(recordTimestampSeconds('neighbors', { rx_time: 666 }), 666);
  assert.equal(recordTimestampSeconds('traces', { rx_time: 777 }), 777);
});

test('recordTimestampSeconds skips non-positive values and falls through', () => {
  // last_heard 0 is rejected → falls through to position_time.
  assert.equal(recordTimestampSeconds('nodes', { last_heard: 0, position_time: 888 }), 888);
  assert.equal(recordTimestampSeconds('nodes', { last_heard: -5, first_heard: 999 }), 999);
});

test('recordTimestampSeconds returns null for unusable input', () => {
  assert.equal(recordTimestampSeconds('nodes', null), null);
  assert.equal(recordTimestampSeconds('nodes', 'nope'), null);
  assert.equal(recordTimestampSeconds('messages', { unrelated: 1 }), null);
  assert.equal(recordTimestampSeconds('nodes', { last_heard: Number.NaN }), null);
});

test('recordTimestampSeconds uses default fields for an unknown collection', () => {
  assert.equal(recordTimestampSeconds('weird', { rx_time: 12 }), 12);
  assert.equal(recordTimestampSeconds('weird', { last_heard: 34 }), 34);
});

// --- isStale (cached-copy age) ------------------------------------------

test('nodes go stale after 24h; observations after their window', () => {
  assert.equal(isStale('nodes', { cachedAt: ago(1 * 60 * 60) }, NOW), false); // 1h old
  assert.equal(isStale('nodes', { cachedAt: ago(25 * 60 * 60) }, NOW), true); // 25h old
  assert.equal(isStale('messages', { cachedAt: ago(6 * DAY) }, NOW), false);
  assert.equal(isStale('messages', { cachedAt: ago(8 * DAY) }, NOW), true);
  assert.equal(isStale('traces', { cachedAt: ago(20 * DAY) }, NOW), false);
  assert.equal(isStale('traces', { cachedAt: ago(29 * DAY) }, NOW), true);
});

test('isStale treats a missing/invalid cachedAt as stale', () => {
  assert.equal(isStale('nodes', {}, NOW), true);
  assert.equal(isStale('nodes', { cachedAt: 0 }, NOW), true);
  assert.equal(isStale('nodes', null, NOW), true);
});

test('isStale uses the 7-day default for an unknown collection', () => {
  assert.equal(isStale('weird', { cachedAt: ago(6 * DAY) }, NOW), false);
  assert.equal(isStale('weird', { cachedAt: ago(8 * DAY) }, NOW), true);
});

// --- isExpired (domain-timestamp age) -----------------------------------

test('nodes evict at 7d, not at their 24h staleness — inactive nodes are kept', () => {
  // 26h-old node: stale, but NOT expired (must not lose inactive nodes).
  const node = { value: { last_heard: ago(26 * 60 * 60) }, cachedAt: ago(26 * 60 * 60) };
  assert.equal(isStale('nodes', node, NOW), true);
  assert.equal(isExpired('nodes', node, NOW), false);

  assert.equal(isExpired('nodes', { value: { last_heard: ago(3 * DAY) } }, NOW), false);
  assert.equal(isExpired('nodes', { value: { last_heard: ago(8 * DAY) } }, NOW), true);
});

test('traces/neighbors are retained 28 days; messages 7 days', () => {
  assert.equal(isExpired('traces', { value: { rx_time: ago(20 * DAY) } }, NOW), false);
  assert.equal(isExpired('traces', { value: { rx_time: ago(29 * DAY) } }, NOW), true);
  assert.equal(isExpired('neighbors', { value: { rx_time: ago(29 * DAY) } }, NOW), true);
  assert.equal(isExpired('messages', { value: { rx_time: ago(8 * DAY) } }, NOW), true);
});

test('nothing whose event is younger than 7 days is ever evicted', () => {
  for (const collection of ['nodes', 'messages', 'positions', 'telemetry', 'neighbors', 'traces']) {
    const entry = { value: { last_heard: ago(6 * DAY), rx_time: ago(6 * DAY) } };
    assert.equal(isExpired(collection, entry, NOW), false, `${collection} 6d should be retained`);
  }
});

test('isExpired retains entries with no usable domain timestamp', () => {
  assert.equal(isExpired('nodes', { value: { foo: 1 } }, NOW), false);
  assert.equal(isExpired('nodes', {}, NOW), false);
  assert.equal(isExpired('messages', null, NOW), false);
});

test('isExpired uses the 7-day default for an unknown collection', () => {
  assert.equal(isExpired('weird', { value: { rx_time: ago(6 * DAY) } }, NOW), false);
  assert.equal(isExpired('weird', { value: { rx_time: ago(8 * DAY) } }, NOW), true);
});

// --- policy tables -------------------------------------------------------

test('staleness and retention tables encode the agreed windows', () => {
  assert.equal(CACHE_STALENESS_SECONDS.nodes, DAY);
  assert.equal(CACHE_RETENTION_SECONDS.nodes, 7 * DAY);
  assert.equal(CACHE_STALENESS_SECONDS.traces, 28 * DAY);
  assert.equal(CACHE_RETENTION_SECONDS.neighbors, 28 * DAY);
  assert.equal(CACHE_STALENESS_SECONDS.messages, 7 * DAY);
});
