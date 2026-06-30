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
  isTestChannelLabel,
  MAX_CHANNEL_INDEX,
  normaliseChannelIndex,
  normaliseChannelName,
  resolveTimestampSeconds
} from '../chat-log-tabs.js';

const NOW = 1_000_000;

// ---------------------------------------------------------------------------
// isTestChannelLabel — word-boundary ping/test/bot detection (SPEC F2)
// ---------------------------------------------------------------------------

test('isTestChannelLabel: matches standalone keywords case-insensitively', () => {
  for (const label of ['test', 'TEST', 'Ping', 'bot', '#test', '#ping', '#bot']) {
    assert.equal(isTestChannelLabel(label), true, `${label} should be a test channel`);
  }
});

test('isTestChannelLabel: matches a keyword as one word among others', () => {
  for (const label of ['test channel', 'my bot', 'ping pong', 'daily-test', 'bot 2', 'EU ping']) {
    assert.equal(isTestChannelLabel(label), true, `${label} should be a test channel`);
  }
});

test('isTestChannelLabel: does NOT match keywords embedded in larger words', () => {
  // The false positives the word-boundary rule exists to avoid (SPEC F2).
  for (const label of ['Camping', 'Robotics', 'RobotWars', 'Contest', 'Botswana', 'Testing', 'testbed', 'MyBot', 'test2', 'pingu']) {
    assert.equal(isTestChannelLabel(label), false, `${label} should NOT be a test channel`);
  }
});

test('isTestChannelLabel: real default/custom channel names are not test channels', () => {
  for (const label of ['Public', 'MediumFast', 'LongFast', '0', '#BerlinMesh', 'MeshTown']) {
    assert.equal(isTestChannelLabel(label), false, `${label} should NOT be a test channel`);
  }
});

test('isTestChannelLabel: non-string input returns false', () => {
  assert.equal(isTestChannelLabel(null), false);
  assert.equal(isTestChannelLabel(undefined), false);
  assert.equal(isTestChannelLabel(7), false);
  assert.equal(isTestChannelLabel(''), false);
});
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

function findChannelByLabel(model, label) {
  return model.channels.find(channel => channel.label === label);
}

function assertChannelMessages(model, { label, id, index, messageIds }) {
  const channel = findChannelByLabel(model, label);
  assert.ok(channel);
  if (id instanceof RegExp) {
    assert.match(channel.id, id);
  } else {
    assert.equal(channel.id, id);
  }
  assert.equal(channel.index, index);
  assert.deepEqual(channel.entries.map(entry => entry.message.id), messageIds);
}

test('buildChatTabModel returns sorted nodes and channel buckets', () => {
  const model = buildModel();
  // Message bodies never reach the Log feed (LV7 amended); these fixture
  // messages carry no sender id, so they appear only in their channel tabs.
  // The Log holds the two in-window node-join events plus the lone encrypted
  // message.  Assert by type counts so the test is robust to interleaving.
  const typeCounts = model.logEntries.reduce((acc, entry) => {
    acc[entry.type] = (acc[entry.type] || 0) + 1;
    return acc;
  }, {});
  assert.equal(typeCounts[CHAT_LOG_ENTRY_TYPES.NODE_NEW], 2);
  assert.equal(typeCounts[CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED], 1);
  // No plaintext MESSAGE entries ever reach the Log.
  assert.equal(typeCounts[CHAT_LOG_ENTRY_TYPES.MESSAGE] ?? 0, 0);
  assert.equal(model.logEntries.length, 3);
  // Log entries are sorted chronologically.
  for (let i = 1; i < model.logEntries.length; i += 1) {
    assert.ok(model.logEntries[i].ts >= model.logEntries[i - 1].ts);
  }

  assert.equal(model.channels.length, 6);
  // Default/primary channels (index 0) lead, then custom channels (index > 0);
  // these fixtures contain no test channels, so the third (test) tier is
  // exercised by the dedicated three-tier ordering tests below.  Within each
  // tier, ties on messageCount are broken alphabetically by label.
  assert.deepEqual(model.channels.map(channel => channel.label), [
    'EnvDefault',
    'Fallback',
    'MediumFast',
    'ShortFast',
    '1',
    'BerlinMesh',
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
  assert.match(secondaryChannel.id, /^channel-secondary-name-berlinmesh-[a-z0-9]+$/);
  assert.equal(secondaryChannel.entries.length, 1);
  assert.deepEqual(secondaryChannel.entries.map(entry => entry.message.id), ['recent-alt']);
});

test('buildChatTabModel skips channel buckets when there are no messages', () => {
  const model = buildChatTabModel({ nodes: [], messages: [], nowSeconds: NOW, windowSeconds: WINDOW });
  assert.equal(model.channels.length, 0);
});

// ---------------------------------------------------------------------------
// Log feed is node-centric: message bodies never reach the Log (LV7 amended).
// Each event yields one Log entry; a decrypted message is recorded as a
// node-info update (reason "message"), never its text.  An "updated node info
// (advert)" entry is emitted only when no more-specific event already
// represents that heard.
// ---------------------------------------------------------------------------

test('buildChatTabModel keeps decrypted message bodies out of the Log (LV7 amended)', () => {
  const model = buildChatTabModel({
    nodes: [{ node_id: '!00000001', long_name: 'Alice', last_heard: NOW - 5 }],
    messages: [{ id: 'm1', channel: 0, from_id: '!00000001', text: 'secret words', rx_time: NOW - 5 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  // No plaintext MESSAGE entries: message bodies never reach the Log feed.
  const messageEntries = model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.MESSAGE);
  assert.equal(messageEntries.length, 0);
  // The decrypted message is represented as a node-info update, reason "message".
  const infoEntries = model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO);
  assert.ok(infoEntries.some(e => e.reason === 'message' && e.nodeId === '!00000001'));
  // The raw text appears nowhere in the Log feed.
  assert.ok(!JSON.stringify(model.logEntries).includes('secret words'));
  // The body still lives in its channel tab.
  assert.equal(model.channels[0].entries[0].message.id, 'm1');
});

test('buildChatTabModel emits node-info (advert) only when no specific event claims the heard', () => {
  // Pure advert: node heard with no position/message/etc. at that ts.
  const advertOnly = buildChatTabModel({
    nodes: [{ node_id: '!a', last_heard: NOW - 5 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  const advertInfos = advertOnly.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO);
  assert.equal(advertInfos.length, 1);
  assert.equal(advertInfos[0].reason, 'advert');

  // Same node heard via a position at the same ts: only the position entry,
  // no redundant "updated node info" (the position is the specific type).
  const withPosition = buildChatTabModel({
    nodes: [{ node_id: '!a', last_heard: NOW - 5 }],
    positions: [{ node_id: '!a', rx_time: NOW - 5, latitude: 1, longitude: 2 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.ok(withPosition.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.POSITION));
  assert.equal(
    withPosition.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO).length,
    0
  );
});

test('buildChatTabModel does not emit redundant node-info for telemetry/neighbor/trace', () => {
  const model = buildChatTabModel({
    nodes: [{ node_id: '!a', last_heard: NOW - 5 }],
    telemetry: [{ node_id: '!a', rx_time: NOW - 5, battery_level: 80 }],
    neighbors: [{ node_id: '!a', neighbor_id: '!b', rx_time: NOW - 5 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  // Telemetry + neighbor each emit their own specific entry...
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.TELEMETRY));
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.NEIGHBOR));
  // ...and the advert is claimed by them, so no "updated node info" duplicate.
  assert.equal(
    model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO).length,
    0
  );
});

test('buildChatTabModel suppresses the advert when the specific event omits node_num (A2)', () => {
  // Real-world shape: the node record carries a node_num, but the telemetry /
  // position rows carry only node_id (node_num is int|nil per CONTRACTS, and is
  // frequently nil — notably for MeshCore). The heard is the same node + ts, so
  // the specific events must still claim it and suppress the redundant advert.
  const model = buildChatTabModel({
    nodes: [{ node_id: '!a', node_num: 10, last_heard: NOW - 5 }],
    telemetry: [{ node_id: '!a', rx_time: NOW - 5, battery_level: 80 }],
    positions: [{ node_id: '!a', rx_time: NOW - 5, latitude: 1, longitude: 2 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  // The specific events still render their own entries...
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.TELEMETRY));
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.POSITION));
  // ...and no redundant "Updated node info (advert)" appears despite the
  // node_num mismatch between the node record and the telemetry/position rows.
  assert.equal(
    model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO).length,
    0
  );
});

test('buildChatTabModel suppresses the advert when a node was heard via an encrypted message (A3, logOnly feed)', () => {
  // Production shape: encrypted messages arrive via logOnlyMessages. The
  // "🔒 encrypted message" line is the sender's Log representation for that heard,
  // so the redundant "Updated node info (advert)" must be suppressed (LV7).
  const model = buildChatTabModel({
    nodes: [{ node_id: '!a', last_heard: NOW - 5 }],
    logOnlyMessages: [{ id: 'e1', encrypted: true, from_id: '!a', channel: 78, rx_time: NOW - 5 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED));
  assert.equal(model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO).length, 0);
});

test('buildChatTabModel suppresses the advert for an encrypted message in the messages feed (A3)', () => {
  const model = buildChatTabModel({
    nodes: [{ node_id: '!a', last_heard: NOW - 5 }],
    messages: [{ id: 'e2', encrypted: true, from_id: '!a', channel: 78, rx_time: NOW - 5 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED));
  assert.equal(model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO).length, 0);
});

test('buildChatTabModel keeps an id-less heard from claiming or being suppressed (A2 edge)', () => {
  const model = buildChatTabModel({
    // A node heard with neither node_id nor node_num: its advert still renders,
    // and the unresolved (null) id is never used to suppress another heard.
    nodes: [{ last_heard: NOW - 5 }],
    // A telemetry row with no node_id/node_num: it renders its own entry but
    // claims nothing — an id-less heard cannot stand in for any node's advert.
    telemetry: [{ rx_time: NOW - 6, battery_level: 1 }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.ok(model.logEntries.some(e => e.type === CHAT_LOG_ENTRY_TYPES.TELEMETRY));
  const adverts = model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO);
  assert.equal(adverts.length, 1);
  assert.equal(adverts[0].reason, 'advert');
});

test('buildChatTabModel attributes a message whose sender is absent from the nodes feed', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [{ id: 'm1', channel: 0, from_id: '!00000002', text: 'hi', rx_time: NOW }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  const infoEntries = model.logEntries.filter(e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO);
  assert.equal(infoEntries.length, 1);
  assert.equal(infoEntries[0].reason, 'message');
  assert.equal(infoEntries[0].nodeId, '!00000002');
  // No node object and no node number could be resolved for an RF-only sender.
  assert.equal(infoEntries[0].node, null);
  assert.equal(infoEntries[0].nodeNum, null);
});

test('buildChatTabModel falls back to the hydrated message.node for an off-feed sender', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [{
      id: 'm1',
      channel: 0,
      from_id: '!00000003',
      text: 'hi',
      rx_time: NOW,
      node: { node_id: '!00000003', long_name: 'Carol' }
    }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  const info = model.logEntries.find(
    e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO && e.reason === 'message'
  );
  assert.ok(info);
  assert.equal(info.node.long_name, 'Carol');
});

test('buildChatTabModel records one message node-info per sender per timestamp', () => {
  const model = buildChatTabModel({
    nodes: [{ node_id: '!00000001', last_heard: NOW }],
    messages: [
      { id: 'm1', channel: 0, from_id: '!00000001', text: 'a', rx_time: NOW },
      { id: 'm2', channel: 0, from_id: '!00000001', text: 'b', rx_time: NOW }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  // Two bodies in the channel tab, but the Log holds a single node-info update.
  assert.equal(model.channels[0].entries.length, 2);
  assert.equal(
    model.logEntries.filter(
      e => e.type === CHAT_LOG_ENTRY_TYPES.NODE_INFO && e.reason === 'message'
    ).length,
    1
  );
});

// ---------------------------------------------------------------------------
// Three-tier channel ordering: default -> custom -> test (SPEC F1/F3/F4)
// ---------------------------------------------------------------------------

test('buildChatTabModel sinks test channels below custom channels even with more activity (F1)', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      // Custom channel, low activity (1 message).
      { id: 'c1', rx_time: NOW - 5, channel: 1, channel_name: 'BerlinMesh' },
      // Test channel, HIGH activity (3 messages) — must still sort last.
      { id: 't1', rx_time: NOW - 4, channel: 2, channel_name: 'test' },
      { id: 't2', rx_time: NOW - 3, channel: 2, channel_name: 'test' },
      { id: 't3', rx_time: NOW - 2, channel: 2, channel_name: 'test' },
      // Default/primary channel, low activity (1 message) — must lead.
      { id: 'p1', rx_time: NOW - 6, channel: 0, channel_name: 'MediumFast' },
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    primaryChannelFallbackLabel: '',
  });
  assert.deepEqual(model.channels.map(channel => channel.label), ['MediumFast', 'BerlinMesh', 'test']);
  // Presentation-only (F4): the demoted test channel keeps all its messages.
  assert.equal(findChannelByLabel(model, 'test').messageCount, 3);
});

test('buildChatTabModel never demotes an index-0 channel even if its name matches a keyword (F3)', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'cust', rx_time: NOW - 5, channel: 1, channel_name: 'BerlinMesh' },
      { id: 'prim', rx_time: NOW - 4, channel: 0, channel_name: 'test' }, // primary literally named "test"
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    primaryChannelFallbackLabel: '',
  });
  // The index-0 "test" channel still leads; it is NOT sunk to the test tier.
  assert.deepEqual(model.channels.map(channel => channel.label), ['test', 'BerlinMesh']);
  assert.equal(model.channels[0].index, 0);
});

test('buildChatTabModel orders channels within the test tier by activity then label (F1)', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'a1', rx_time: NOW - 5, channel: 1, channel_name: 'AlphaMesh' }, // custom (tier 1)
      { id: 'pb1', rx_time: NOW - 4, channel: 2, channel_name: 'ping-bot' }, // test, 1 message
      { id: 'tt1', rx_time: NOW - 3, channel: 3, channel_name: 'test' },     // test, 2 messages
      { id: 'tt2', rx_time: NOW - 2, channel: 3, channel_name: 'test' },
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW,
    primaryChannelFallbackLabel: '',
  });
  // Custom first; then test channels, busier ('test', 2) before quieter ('ping-bot', 1).
  assert.deepEqual(model.channels.map(channel => channel.label), ['AlphaMesh', 'test', 'ping-bot']);
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

test('buildChatTabModel merges secondary channels with matching labels across indexes', () => {
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

  const mergedSecondaryChannel = meshChannels.find(channel => channel.index === 3);
  assert.ok(mergedSecondaryChannel);
  assert.match(mergedSecondaryChannel.id, /^channel-secondary-name-meshtown-[a-z0-9]+$/);
  assert.deepEqual(
    mergedSecondaryChannel.entries.map(entry => entry.message.id),
    [secondaryFirstId, secondarySecondId]
  );
});

test('buildChatTabModel keeps unnamed secondary buckets separate when a label later arrives', () => {
  const scenarios = [
    {
      index: 4,
      label: 'SideMesh',
      messages: [
        { id: 'unnamed', rx_time: NOW - 15, channel: 4 },
        { id: 'named', rx_time: NOW - 10, channel: 4, channel_name: 'SideMesh' }
      ],
      namedId: /^channel-secondary-name-sidemesh-[a-z0-9]+$/,
      namedMessages: ['named'],
      unnamedMessages: ['unnamed']
    },
    {
      index: 5,
      label: 'MeshNorth',
      messages: [
        { id: 'named', rx_time: NOW - 12, channel: 5, channel_name: 'MeshNorth' },
        { id: 'unlabeled', rx_time: NOW - 8, channel: 5 }
      ],
      namedId: /^channel-secondary-name-meshnorth-[a-z0-9]+$/,
      namedMessages: ['named'],
      unnamedMessages: ['unlabeled']
    }
  ];

  for (const scenario of scenarios) {
    const model = buildChatTabModel({
      nodes: [],
      messages: scenario.messages,
      nowSeconds: NOW,
      windowSeconds: WINDOW
    });
    const secondaryChannels = model.channels.filter(channel => channel.index === scenario.index);
    assert.equal(secondaryChannels.length, 2);
    assertChannelMessages(model, {
      label: scenario.label,
      id: scenario.namedId,
      index: scenario.index,
      messageIds: scenario.namedMessages
    });
    assertChannelMessages(model, {
      label: String(scenario.index),
      id: `channel-${scenario.index}`,
      index: scenario.index,
      messageIds: scenario.unnamedMessages
    });
  }
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

  assertChannelMessages(model, {
    label: 'PUBLIC',
    id: /^channel-secondary-name-public-[a-z0-9]+$/,
    index: 1,
    messageIds: ['public-msg']
  });
  assertChannelMessages(model, {
    label: 'BerlinMesh',
    id: /^channel-secondary-name-berlinmesh-[a-z0-9]+$/,
    index: 1,
    messageIds: ['berlin-msg']
  });
});

test('buildChatTabModel merges same-name channels even when indexes differ', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'test-1', rx_time: NOW - 12, channel: 1, channel_name: 'TEST' },
      { id: 'test-2', rx_time: NOW - 8, channel: 2, channel_name: 'TEST' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  assertChannelMessages(model, {
    label: 'TEST',
    id: /^channel-secondary-name-test-[a-z0-9]+$/,
    index: 1,
    messageIds: ['test-1', 'test-2']
  });
});

test('buildChatTabModel keeps same-index slug-colliding labels on distinct tab ids', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'foo-space', rx_time: NOW - 10, channel: 1, channel_name: 'Foo Bar' },
      { id: 'foo-dash', rx_time: NOW - 8, channel: 1, channel_name: 'Foo-Bar' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });

  const fooSpaceChannel = findChannelByLabel(model, 'Foo Bar');
  const fooDashChannel = findChannelByLabel(model, 'Foo-Bar');
  assert.ok(fooSpaceChannel);
  assert.ok(fooDashChannel);
  assert.match(fooSpaceChannel.id, /^channel-secondary-name-foo-bar-[a-z0-9]+$/);
  assert.match(fooDashChannel.id, /^channel-secondary-name-foo-bar-[a-z0-9]+$/);
  assert.notEqual(fooSpaceChannel.id, fooDashChannel.id);
});

test('buildChatTabModel falls back to hashed id for unsluggable secondary labels', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [{ id: 'hash-fallback', rx_time: NOW - 5, channel: 2, channel_name: '###' }],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  const channel = findChannelByLabel(model, '###');
  assert.ok(channel);
  assert.equal(channel.index, 2);
  assert.ok(channel.id.startsWith('channel-secondary-name-'));
  assert.ok(channel.id.length > 'channel-secondary-name-'.length);
});

test('buildChatTabModel sets messageCount equal to entries.length on each channel', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'a', rx_time: NOW - 10, channel: 0, channel_name: 'Primary' },
      { id: 'b', rx_time: NOW - 8, channel: 0, channel_name: 'Primary' },
      { id: 'c', rx_time: NOW - 6, channel: 1, channel_name: 'Secondary' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  for (const channel of model.channels) {
    assert.equal(channel.messageCount, channel.entries.length);
  }
  const primary = model.channels.find(channel => channel.label === 'Primary');
  assert.ok(primary);
  assert.equal(primary.messageCount, 2);
});

test('buildChatTabModel sorts channels by messageCount descending', () => {
  // Channel A has 3 messages, Channel B has 1. A must come first.
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'b1', rx_time: NOW - 15, channel: 1, channel_name: 'Beta' },
      { id: 'a1', rx_time: NOW - 12, channel: 2, channel_name: 'Alpha' },
      { id: 'a2', rx_time: NOW - 10, channel: 2, channel_name: 'Alpha' },
      { id: 'a3', rx_time: NOW - 8, channel: 2, channel_name: 'Alpha' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.equal(model.channels.length, 2);
  assert.equal(model.channels[0].label, 'Alpha');
  assert.equal(model.channels[0].messageCount, 3);
  assert.equal(model.channels[1].label, 'Beta');
  assert.equal(model.channels[1].messageCount, 1);
});

test('buildChatTabModel breaks messageCount ties alphabetically', () => {
  // Zebra and Apple each have 2 messages; Apple should sort first.
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      { id: 'z1', rx_time: NOW - 20, channel: 1, channel_name: 'Zebra' },
      { id: 'z2', rx_time: NOW - 18, channel: 1, channel_name: 'Zebra' },
      { id: 'ap1', rx_time: NOW - 16, channel: 2, channel_name: 'Apple' },
      { id: 'ap2', rx_time: NOW - 14, channel: 2, channel_name: 'Apple' }
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.equal(model.channels.length, 2);
  assert.equal(model.channels[0].label, 'Apple');
  assert.equal(model.channels[1].label, 'Zebra');
});

test('buildChatTabModel puts primary channels (index 0) before secondary channels', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      // Secondary channels with many messages
      { id: 's1', rx_time: NOW - 30, channel: 2, channel_name: 'SecondaryA' },
      { id: 's2', rx_time: NOW - 28, channel: 2, channel_name: 'SecondaryA' },
      { id: 's3', rx_time: NOW - 26, channel: 2, channel_name: 'SecondaryA' },
      // Primary channel (index 0) with fewer messages
      { id: 'p1', rx_time: NOW - 20, channel: 0, channel_name: 'LongFast' },
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.equal(model.channels.length, 2);
  assert.equal(model.channels[0].label, 'LongFast', 'primary channel must come first regardless of activity');
  assert.equal(model.channels[0].index, 0);
  assert.equal(model.channels[1].label, 'SecondaryA', 'secondary channel must come second');
});

test('buildChatTabModel sorts primary channels by activity then alpha within the primary tier', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      // LongFast: 1 message
      { id: 'lf1', rx_time: NOW - 30, channel: 0, channel_name: 'LongFast' },
      // MediumFast: 3 messages (most active primary)
      { id: 'mf1', rx_time: NOW - 28, channel: 0, channel_name: 'MediumFast' },
      { id: 'mf2', rx_time: NOW - 26, channel: 0, channel_name: 'MediumFast' },
      { id: 'mf3', rx_time: NOW - 24, channel: 0, channel_name: 'MediumFast' },
      // Public: 2 messages
      { id: 'pb1', rx_time: NOW - 22, channel: 0, channel_name: 'Public' },
      { id: 'pb2', rx_time: NOW - 20, channel: 0, channel_name: 'Public' },
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.equal(model.channels.length, 3);
  assert.equal(model.channels[0].label, 'MediumFast', 'most active primary first');
  assert.equal(model.channels[1].label, 'Public', 'second most active primary second');
  assert.equal(model.channels[2].label, 'LongFast', 'least active primary last');
});

test('buildChatTabModel sorts secondary channels by activity then alpha after all primaries', () => {
  const model = buildChatTabModel({
    nodes: [],
    messages: [
      // Primary with 1 message
      { id: 'p1', rx_time: NOW - 50, channel: 0, channel_name: 'LongFast' },
      // Secondary channels
      { id: 'b1', rx_time: NOW - 40, channel: 3, channel_name: 'Beta' },
      { id: 'a1', rx_time: NOW - 38, channel: 1, channel_name: 'Alpha' },
      { id: 'a2', rx_time: NOW - 36, channel: 1, channel_name: 'Alpha' },
      { id: 'a3', rx_time: NOW - 34, channel: 1, channel_name: 'Alpha' },
      { id: 'g1', rx_time: NOW - 32, channel: 2, channel_name: 'Gamma' },
      { id: 'g2', rx_time: NOW - 30, channel: 2, channel_name: 'Gamma' },
    ],
    nowSeconds: NOW,
    windowSeconds: WINDOW
  });
  assert.equal(model.channels.length, 4);
  assert.equal(model.channels[0].label, 'LongFast', 'primary always first');
  assert.equal(model.channels[1].label, 'Alpha', 'most active secondary first');
  assert.equal(model.channels[2].label, 'Gamma', 'second most active secondary second');
  assert.equal(model.channels[3].label, 'Beta', 'least active secondary last');
});
