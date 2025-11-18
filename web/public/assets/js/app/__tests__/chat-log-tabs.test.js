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
    { id: 'primary-preset', rx_time: NOW - 8, channel: 0, modem_preset: ' ShortFast ' },
    { id: 'env-default', rx_time: NOW - 12, channel: 0 },
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
    primaryChannelFallbackLabel: '#EnvDefault',
    ...overrides
  });
}

test('buildChatTabModel returns sorted nodes and channel buckets', () => {
  const model = buildModel();
  assert.equal(model.logEntries.length, 3);
  assert.deepEqual(model.logEntries.map(entry => entry.type), [
    CHAT_LOG_ENTRY_TYPES.NODE_NEW,
    CHAT_LOG_ENTRY_TYPES.NODE_NEW,
    CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED
  ]);
  assert.deepEqual(
    model.logEntries.map(entry => entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED ? entry.message.id : entry.node.id),
    ['recent-node', 'iso-node', 'encrypted']
  );

  assert.equal(model.channels.length, 5);
  assert.deepEqual(model.channels.map(channel => channel.label), [
    'EnvDefault',
    'Fallback',
    'MediumFast',
    'ShortFast',
    'BerlinMesh'
  ]);

  const channelByLabel = Object.fromEntries(model.channels.map(channel => [channel.label, channel]));

  const envChannel = channelByLabel.EnvDefault;
  assert.equal(envChannel.index, 0);
  assert.equal(envChannel.id, 'channel-0-envdefault');
  assert.deepEqual(envChannel.entries.map(entry => entry.message.id), ['env-default']);

  const fallbackChannel = channelByLabel.Fallback;
  assert.equal(fallbackChannel.index, 0);
  assert.equal(fallbackChannel.id, 'channel-0-fallback');
  assert.deepEqual(fallbackChannel.entries.map(entry => entry.message.id), ['no-index']);

  const namedPrimaryChannel = channelByLabel.MediumFast;
  assert.equal(namedPrimaryChannel.index, 0);
  assert.equal(namedPrimaryChannel.id, 'channel-0-mediumfast');
  assert.deepEqual(namedPrimaryChannel.entries.map(entry => entry.message.id), ['recent-default']);

  const presetChannel = channelByLabel.ShortFast;
  assert.equal(presetChannel.index, 0);
  assert.equal(presetChannel.id, 'channel-0-shortfast');
  assert.deepEqual(presetChannel.entries.map(entry => entry.message.id), ['primary-preset']);

  const secondaryChannel = channelByLabel.BerlinMesh;
  assert.equal(secondaryChannel.index, 1);
  assert.equal(secondaryChannel.id, 'channel-secondary-berlinmesh');
  assert.equal(secondaryChannel.entries.length, 2);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), ['iso-ts', 'recent-alt']);
});

test('buildChatTabModel always includes channel zero bucket', () => {
  const model = buildChatTabModel({ nodes: [], messages: [], nowSeconds: NOW, windowSeconds: WINDOW });
  assert.equal(model.channels.length, 1);
  assert.equal(model.channels[0].index, 0);
  assert.equal(model.channels[0].entries.length, 0);
});

test('buildChatTabModel falls back to numeric label when no metadata provided', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [{ id: 'plain', rx_time: NOW - 5, channel: 0 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    primaryChannelFallbackLabel: ''
  });
  assert.equal(model.channels.length, 1);
  assert.equal(model.channels[0].label, '0');
  assert.equal(model.channels[0].id, 'channel-0');
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

test('buildChatTabModel merges dedicated encrypted log feed without altering channels', () => {
  const regularMessages = fixtureMessages().filter(message => !message.encrypted);
  const encryptedOnly = [
    { id: 'log-only', encrypted: true, rx_time: NOW - 3, channel: 7 }
  ];
  const model = buildChatTabModel({
    nodes: [],
    messages: regularMessages,
    logOnlyMessages: encryptedOnly,
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const encryptedEntries = model.logEntries.filter(entry => entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED);
  assert.equal(encryptedEntries.length, 1);
  assert.equal(encryptedEntries[0]?.message?.id, 'log-only');

  const channelMessageIds = model.channels.reduce((acc, channel) => {
    if (!channel || !Array.isArray(channel.entries)) {
      return acc;
    }
    for (const entry of channel.entries) {
      if (entry && entry.message && entry.message.id) {
        acc.push(entry.message.id);
      }
    }
    return acc;
  }, []);
  assert.ok(!channelMessageIds.includes('log-only'));
});

test('buildChatTabModel de-duplicates encrypted messages across feeds', () => {
  const duplicateMessage = { id: 'dup', encrypted: true, rx_time: NOW - 4 };
  const model = buildChatTabModel({
    nodes: [],
    messages: [duplicateMessage],
    logOnlyMessages: [duplicateMessage],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const encryptedEntries = model.logEntries.filter(entry => entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED);
  assert.equal(encryptedEntries.length, 1);
  assert.equal(encryptedEntries[0]?.message?.id, 'dup');
});

test('buildChatTabModel ignores plaintext log-only entries', () => {
  const logOnlyMessages = [
    { id: 'plain', encrypted: false, rx_time: NOW - 5 },
    { id: 'enc', encrypted: true, rx_time: NOW - 4 }
  ];

  const model = buildChatTabModel({
    nodes: [],
    messages: [],
    logOnlyMessages,
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const encryptedEntries = model.logEntries.filter(entry => entry.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED);
  assert.equal(encryptedEntries.length, 1);
  assert.equal(encryptedEntries[0]?.message?.id, 'enc');
});

test('buildChatTabModel merges secondary channels with matching labels regardless of index', () => {
  const primaryId = 'primary';
  const secondaryFirstId = 'secondary-one';
  const secondarySecondId = 'secondary-two';
  const label = 'MeshTown';
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: secondaryFirstId, rx_time: NOW - 12, channel: 7, channel_name: label },
      { id: primaryId, rx_time: NOW - 10, channel: 0, channel_name: label },
      { id: secondarySecondId, rx_time: NOW - 8, channel: 3, channel_name: ` ${label} ` }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const meshChannels = model.channels.filter(channel => channel.label === label);
  assert.equal(meshChannels.length, 2);

  const primaryChannel = meshChannels.find(channel => channel.index === 0);
  assert.ok(primaryChannel);
  assert.equal(primaryChannel.entries.length, 1);
  assert.equal(primaryChannel.entries[0]?.message?.id, primaryId);

  const secondaryChannel = meshChannels.find(channel => channel.index > 0);
  assert.ok(secondaryChannel);
  assert.equal(secondaryChannel.id, 'channel-secondary-meshtown');
  assert.equal(secondaryChannel.index, 3);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), [secondaryFirstId, secondarySecondId]);
});

test('buildChatTabModel rekeys unnamed secondary buckets when a label later arrives', () => {
  const unnamedId = 'unnamed';
  const namedId = 'named';
  const label = 'SideMesh';
  const index = 4;
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: unnamedId, rx_time: NOW - 15, channel: index },
      { id: namedId, rx_time: NOW - 10, channel: index, channel_name: label }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const secondaryChannels = model.channels.filter(channel => channel.index === index);
  assert.equal(secondaryChannels.length, 1);
  const [secondaryChannel] = secondaryChannels;
  assert.equal(secondaryChannel.id, 'channel-secondary-sidemesh');
  assert.equal(secondaryChannel.label, label);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), [unnamedId, namedId]);
});

test('buildChatTabModel merges unlabeled secondary messages into existing named buckets by index', () => {
  const namedId = 'named';
  const unlabeledId = 'unlabeled';
  const label = 'MeshNorth';
  const index = 5;
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: namedId, rx_time: NOW - 12, channel: index, channel_name: label },
      { id: unlabeledId, rx_time: NOW - 8, channel: index }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const secondaryChannels = model.channels.filter(channel => channel.index === index);
  assert.equal(secondaryChannels.length, 1);
  const [secondaryChannel] = secondaryChannels;
  assert.equal(secondaryChannel.id, 'channel-secondary-meshnorth');
  assert.equal(secondaryChannel.label, label);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), [namedId, unlabeledId]);
});
