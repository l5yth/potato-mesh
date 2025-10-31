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
    { node_id: 'recent-node', short_name: 'RCNT', first_heard: NOW - 120 },
    { node_id: 'stale-node', short_name: 'STAL', first_heard: NOW - WINDOW - 1 },
    { node_id: 'iso-node', short_name: 'ISON', firstHeard: null, first_heard_iso: new Date((NOW - 30) * 1000).toISOString() }
  ];
}

function fixtureTelemetry() {
  return [
    { node_id: 'recent-node', rx_time: NOW - 15 },
    { node_id: 'iso-node', rx_time: NOW - 6 },
    { node_id: 'stale-node', rx_time: NOW - WINDOW - 5 }
  ];
}

function fixturePositions() {
  return [
    { node_id: 'recent-node', rx_time: NOW - 10 },
    { node_id: 'unknown-node', rx_time: NOW - 12 }
  ];
}

function fixtureNeighbors() {
  return [
    { node_id: 'iso-node', rx_time: NOW - 8 },
    { node_id: 'stale-node', rx_time: NOW - WINDOW - 2 }
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
    telemetry: fixtureTelemetry(),
    positions: fixturePositions(),
    neighbors: fixtureNeighbors(),
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    ...overrides
  });
}

test('buildChatTabModel returns sorted nodes and channel buckets', () => {
  const model = buildModel();
  assert.equal(model.logEntries.length, 7);
  assert.deepEqual(
    model.logEntries.map(entry => entry.kind),
    ['node', 'node', 'telemetry', 'position', 'position', 'neighbor', 'telemetry']
  );
  const [firstNode, secondNode] = model.logEntries;
  assert.equal(firstNode.node.node_id, 'recent-node');
  assert.equal(secondNode.node.node_id, 'iso-node');
  const telemetryEntry = model.logEntries[2];
  assert.equal(telemetryEntry.record.node_id, 'recent-node');
  assert.equal(telemetryEntry.node.node_id, 'recent-node');
  const orphanPosition = model.logEntries[3];
  assert.equal(orphanPosition.record.node_id, 'unknown-node');
  assert.equal(orphanPosition.node, null);
  const positionEntry = model.logEntries[4];
  assert.equal(positionEntry.record.node_id, 'recent-node');
  const neighborEntry = model.logEntries[5];
  assert.equal(neighborEntry.record.node_id, 'iso-node');

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
