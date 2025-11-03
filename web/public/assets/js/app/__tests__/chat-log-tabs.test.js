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

import {
  CHAT_LOG_ENTRY_TYPES,
  buildChatTabModel,
  MAX_CHANNEL_INDEX,
  normaliseChannelIndex,
  normaliseChannelName,
  resolveTimestampSeconds
} from '../chat-log-tabs.js';

const NOW = 1_000_000;
const WINDOW = 60 * 60; // one hour

function fixtureNodes() {
  return [
    { id: 'recent-node', first_heard: NOW - 120 },
    { id: 'stale-node', first_heard: NOW - WINDOW - 1 },
    { id: 'iso-node', firstHeard: null, first_heard_iso: new Date((NOW - 30) * 1000).toISOString() }
  ];
}

function fixtureMessages() {
  return [
    { id: 'recent-default', rx_time: NOW - 5, channel: 0, channel_name: ' MediumFast ' },
    { id: 'recent-alt', rx_time: NOW - 10, channel_index: '1', channel_name: ' BerlinMesh ' },
    { id: 'stale', rx_time: NOW - WINDOW - 5, channel: 2 },
    { id: 'encrypted', rx_time: NOW - 20, channel: 3, encrypted: true },
    { id: 'no-index', rx_time: NOW - 15, channel_name: 'Fallback' },
    { id: 'too-high', rx_time: NOW - 25, channel: MAX_CHANNEL_INDEX + 5, channel_name: 'Ignored' },
    { id: 'iso-ts', rxTime: null, rx_iso: new Date((NOW - 40) * 1000).toISOString(), channel: 1 }
  ];
}

function buildModel(overrides = {}) {
  return buildChatTabModel({
    nodes: fixtureNodes(),
    messages: fixtureMessages(),
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    ...overrides
  });
}

test('buildChatTabModel returns sorted nodes and channel buckets', () => {
  const model = buildModel();
  assert.equal(model.logEntries.length, 2);
  assert.deepEqual(model.logEntries.map(entry => entry.type), [
    CHAT_LOG_ENTRY_TYPES.NODE_NEW,
    CHAT_LOG_ENTRY_TYPES.NODE_NEW
  ]);
  assert.deepEqual(model.logEntries.map(entry => entry.node.id), ['recent-node', 'iso-node']);

  assert.equal(model.channels.length, 2);
  const [channel0, channel1] = model.channels;
  assert.equal(channel0.index, 0);
  assert.equal(channel0.label, 'MediumFast');
  assert.equal(channel0.entries.length, 2);
  assert.deepEqual(channel0.entries.map(entry => entry.message.id), ['no-index', 'recent-default']);

  assert.equal(channel1.index, 1);
  assert.equal(channel1.label, 'BerlinMesh');
  assert.equal(channel1.entries.length, 2);
  assert.deepEqual(channel1.entries.map(entry => entry.message.id), ['iso-ts', 'recent-alt']);
});

test('buildChatTabModel always includes channel zero bucket', () => {
  const model = buildChatTabModel({ nodes: [], messages: [], nowSeconds: NOW, windowSeconds: WINDOW });
  assert.equal(model.channels.length, 1);
  assert.equal(model.channels[0].index, 0);
  assert.equal(model.channels[0].entries.length, 0);
});

test('normaliseChannelIndex handles numeric and textual input', () => {
  assert.equal(normaliseChannelIndex(2.9), 2);
  assert.equal(normaliseChannelIndex(' 7 '), 7);
  assert.equal(normaliseChannelIndex('bad'), null);
  assert.equal(normaliseChannelIndex(null), null);
});

test('normaliseChannelName trims strings and allows numeric values', () => {
  assert.equal(normaliseChannelName(' Berlin '), 'Berlin');
  assert.equal(normaliseChannelName(5), '5');
  assert.equal(normaliseChannelName(''), null);
  assert.equal(normaliseChannelName(undefined), null);
});

test('resolveTimestampSeconds prefers numeric but falls back to ISO parsing', () => {
  assert.equal(resolveTimestampSeconds(1234, null), 1234);
  const iso = '1970-01-01T00:10:00Z';
  assert.equal(resolveTimestampSeconds('not-numeric', iso), 600);
  assert.equal(resolveTimestampSeconds('bad', 'invalid'), null);
});

test('buildChatTabModel includes telemetry, position, and neighbor events', () => {
  const nodeId = '!node';
  const neighborId = '!peer';
  const model = buildChatTabModel({
    nodes: [{
      node_id: nodeId,
      first_heard: NOW - 50,
      last_heard: NOW - 40,
      short_name: 'NODE',
      long_name: 'Node Example'
    }],
    telemetry: [{ node_id: nodeId, rx_time: NOW - 30 }],
    positions: [{ node_id: nodeId, rx_time: NOW - 20 }],
    neighbors: [{ node_id: nodeId, neighbor_id: neighborId, rx_time: NOW - 10 }],
    messages: [],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  assert.deepEqual(model.logEntries.map(entry => entry.type), [
    CHAT_LOG_ENTRY_TYPES.NODE_NEW,
    CHAT_LOG_ENTRY_TYPES.NODE_INFO,
    CHAT_LOG_ENTRY_TYPES.TELEMETRY,
    CHAT_LOG_ENTRY_TYPES.POSITION,
    CHAT_LOG_ENTRY_TYPES.NEIGHBOR
  ]);
  assert.equal(model.logEntries[0].nodeId, nodeId);
  const lastEntry = model.logEntries[model.logEntries.length - 1];
  assert.equal(lastEntry.neighborId, neighborId);
});
