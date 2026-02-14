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

  assert.equal(model.channels.length, 6);
  assert.deepEqual(model.channels.map(channel => channel.label), [
    'EnvDefault',
    'Fallback',
    'MediumFast',
    'ShortFast',
    '1',
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

  const unnamedSecondaryChannel = channelByLabel['1'];
  assert.equal(unnamedSecondaryChannel.index, 1);
  assert.equal(unnamedSecondaryChannel.id, 'channel-1');
  assert.deepEqual(unnamedSecondaryChannel.entries.map(entry => entry.message.id), ['iso-ts']);

  const secondaryChannel = channelByLabel.BerlinMesh;
  assert.equal(secondaryChannel.index, 1);
  assert.equal(secondaryChannel.id, 'channel-secondary-1-berlinmesh');
  assert.equal(secondaryChannel.entries.length, 1);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), ['recent-alt']);
});

test('buildChatTabModel skips channel buckets when there are no messages', () => {
  const model = buildChatTabModel({ nodes: [], messages: [], nowSeconds: NOW, windowSeconds: WINDOW });
  assert.equal(model.channels.length, 0);
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
    traces: [{ id: 5_000, src: nodeId, hops: [neighborId], dest: '!charlie', rx_time: NOW - 5 }],
    messages: [],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const types = model.logEntries.map(entry => entry.type);
  assert.equal(types[0], CHAT_LOG_ENTRY_TYPES.NODE_NEW);
  assert.ok(types.includes(CHAT_LOG_ENTRY_TYPES.NODE_INFO));
  assert.ok(types.includes(CHAT_LOG_ENTRY_TYPES.TELEMETRY));
  assert.ok(types.includes(CHAT_LOG_ENTRY_TYPES.POSITION));
  assert.ok(types.includes(CHAT_LOG_ENTRY_TYPES.NEIGHBOR));
  assert.ok(types.includes(CHAT_LOG_ENTRY_TYPES.TRACE));
  assert.equal(model.logEntries[0].nodeId, nodeId);
  const neighborEntry = model.logEntries.find(entry => entry.type === CHAT_LOG_ENTRY_TYPES.NEIGHBOR);
  assert.ok(neighborEntry);
  assert.equal(neighborEntry.neighborId, neighborId);
  const traceEntry = model.logEntries.find(entry => entry.type === CHAT_LOG_ENTRY_TYPES.TRACE);
  assert.ok(traceEntry);
  assert.deepEqual(traceEntry.traceLabels, [nodeId, neighborId, '!charlie']);
});

test('buildChatTabModel normalises numeric traceroute hops into canonical IDs', () => {
  const source = 0xabcdef01;
  const hops = ['0xABCDEF02', '!abcdef03', 123];
  const dest = 0xabcdef04;
  const model = buildChatTabModel({
    nodes: [],
    traces: [{ rx_time: NOW - 5, src: source, hops, dest }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  const traceEntry = model.logEntries.find(entry => entry.type === CHAT_LOG_ENTRY_TYPES.TRACE);
  assert.ok(traceEntry);
  assert.equal(traceEntry.nodeId, '!abcdef01');
  assert.deepEqual(
    traceEntry.tracePath.map(hop => hop.id),
    ['!abcdef01', '!abcdef02', '!abcdef03', '!0000007b', '!abcdef04']
  );
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

test('buildChatTabModel keeps secondary channels distinct by index even with matching labels', () => {
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
  assert.equal(meshChannels.length, 3);

  const primaryChannel = meshChannels.find(channel => channel.index === 0);
  assert.ok(primaryChannel);
  assert.equal(primaryChannel.entries.length, 1);
  assert.equal(primaryChannel.entries[0]?.message?.id, primaryId);

  const secondaryFirstChannel = meshChannels.find(channel => channel.index === 7);
  assert.ok(secondaryFirstChannel);
  assert.equal(secondaryFirstChannel.id, 'channel-secondary-7-meshtown');
  assert.deepEqual(secondaryFirstChannel.entries.map(entry => entry.message.id), [secondaryFirstId]);

  const secondarySecondChannel = meshChannels.find(channel => channel.index === 3);
  assert.ok(secondarySecondChannel);
  assert.equal(secondarySecondChannel.id, 'channel-secondary-3-meshtown');
  assert.deepEqual(secondarySecondChannel.entries.map(entry => entry.message.id), [secondarySecondId]);
});

test('buildChatTabModel keeps unnamed secondary buckets separate when a label later arrives', () => {
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
  assert.equal(secondaryChannels.length, 2);
  const namedChannel = secondaryChannels.find(channel => channel.label === label);
  assert.ok(namedChannel);
  assert.equal(namedChannel.id, 'channel-secondary-4-sidemesh');
  assert.deepEqual(namedChannel.entries.map(entry => entry.message.id), [namedId]);
  const unnamedChannel = secondaryChannels.find(channel => channel.label === String(index));
  assert.ok(unnamedChannel);
  assert.equal(unnamedChannel.id, 'channel-4');
  assert.deepEqual(unnamedChannel.entries.map(entry => entry.message.id), [unnamedId]);
});

test('buildChatTabModel keeps unlabeled secondary messages separate from named buckets with same index', () => {
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
  assert.equal(secondaryChannels.length, 2);
  const namedChannel = secondaryChannels.find(channel => channel.label === label);
  assert.ok(namedChannel);
  assert.equal(namedChannel.id, 'channel-secondary-5-meshnorth');
  assert.deepEqual(namedChannel.entries.map(entry => entry.message.id), [namedId]);
  const unnamedChannel = secondaryChannels.find(channel => channel.label === String(index));
  assert.ok(unnamedChannel);
  assert.equal(unnamedChannel.id, 'channel-5');
  assert.deepEqual(unnamedChannel.entries.map(entry => entry.message.id), [unlabeledId]);
});

test('buildChatTabModel keeps same-index channels with different names in separate tabs', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'public-msg', rx_time: NOW - 12, channel: 1, channel_name: 'PUBLIC' },
      { id: 'berlin-msg', rx_time: NOW - 8, channel: 1, channel_name: 'BerlinMesh' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const publicChannel = model.channels.find(channel => channel.label === 'PUBLIC');
  assert.ok(publicChannel);
  assert.equal(publicChannel.id, 'channel-secondary-1-public');
  assert.deepEqual(publicChannel.entries.map(entry => entry.message.id), ['public-msg']);

  const berlinChannel = model.channels.find(channel => channel.label === 'BerlinMesh');
  assert.ok(berlinChannel);
  assert.equal(berlinChannel.id, 'channel-secondary-1-berlinmesh');
  assert.deepEqual(berlinChannel.entries.map(entry => entry.message.id), ['berlin-msg']);
});
