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

import { CHAT_LOG_ENTRY_TYPES } from '../chat-log-tabs.js';
import { CHAT_LOG_BURST_TYPE } from '../chat-log-burst.js';
import {
  chatLogEntryMatchesQuery,
  chatMessageMatchesQuery,
  filterChatModel,
  normaliseChatFilterQuery
} from '../chat-search.js';

test('normaliseChatFilterQuery lower-cases and trims user input', () => {
  assert.equal(normaliseChatFilterQuery('  MIXED Case  '), 'mixed case');
  assert.equal(normaliseChatFilterQuery(null), '');
});

test('chatMessageMatchesQuery inspects text and node metadata', () => {
  const message = { text: 'Hello Mesh', node: { short_name: 'ALFA', long_name: 'Alpha Node' } };
  const helloQuery = normaliseChatFilterQuery('mesh');
  assert.equal(chatMessageMatchesQuery(message, helloQuery), true);
  const aliasQuery = normaliseChatFilterQuery('alfa');
  assert.equal(chatMessageMatchesQuery(message, aliasQuery), true);
  const missQuery = normaliseChatFilterQuery('bravo');
  assert.equal(chatMessageMatchesQuery(message, missQuery), false);
});

test('chatLogEntryMatchesQuery recognises position highlight values', () => {
  const entry = {
    type: CHAT_LOG_ENTRY_TYPES.POSITION,
    ts: 1,
    position: { latitude: 51.5, longitude: 0 },
    node: { node_id: '!alpha', short_name: 'Alpha' }
  };
  const query = normaliseChatFilterQuery('51.50000');
  assert.equal(chatLogEntryMatchesQuery(entry, query), true);
  const missQuery = normaliseChatFilterQuery('bravo');
  assert.equal(chatLogEntryMatchesQuery(entry, missQuery), false);
});

test('chatLogEntryMatchesQuery uses enriched node context for lookups', () => {
  const entry = {
    type: CHAT_LOG_ENTRY_TYPES.TELEMETRY,
    nodeId: '!alpha',
    telemetry: { voltage: 12.1 },
    node: { short_name: 'ALFA', long_name: 'Alpha Node' }
  };
  const query = normaliseChatFilterQuery('alpha node');
  assert.equal(chatLogEntryMatchesQuery(entry, query), true);
});

test('chatLogEntryMatchesQuery inspects neighbor node context', () => {
  const entry = {
    type: CHAT_LOG_ENTRY_TYPES.NEIGHBOR,
    neighborId: '!bravo',
    neighborNode: { short_name: 'BRAV', long_name: 'Bravo Station' }
  };
  const query = normaliseChatFilterQuery('bravo station');
  assert.equal(chatLogEntryMatchesQuery(entry, query), true);
});

test('chatLogEntryMatchesQuery inspects traceroute hop labels', () => {
  const entry = {
    type: CHAT_LOG_ENTRY_TYPES.TRACE,
    traceLabels: ['!alpha', '!bravo', '!charlie'],
    tracePath: [{ id: '!alpha' }, { id: '!bravo' }, { id: '!charlie' }]
  };
  const query = normaliseChatFilterQuery('bravo');
  assert.equal(chatLogEntryMatchesQuery(entry, query), true);
  const missQuery = normaliseChatFilterQuery('delta');
  assert.equal(chatLogEntryMatchesQuery(entry, missQuery), false);
});

test('filterChatModel filters both log entries and channel messages', () => {
  const model = {
    logEntries: [
      { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, nodeId: '!alpha', node: { short_name: 'Alpha' } },
      { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, nodeId: '!bravo', node: { short_name: 'Bravo' } }
    ],
    channels: [
      {
        index: 0,
        label: '0',
        entries: [
          { ts: 1, message: { text: 'Ping Alpha', node: { short_name: 'Alpha' } } },
          { ts: 2, message: { text: 'Ack Bravo', node: { short_name: 'Bravo' } } }
        ]
      }
    ]
  };
  const result = filterChatModel(model, 'bravo');
  assert.equal(result.logEntries.length, 1);
  assert.equal(result.logEntries[0].nodeId, '!bravo');
  assert.equal(result.channels.length, 1);
  assert.deepEqual(result.channels[0].entries.map(entry => entry.message.text), ['Ack Bravo']);
});

test('filterChatModel returns original references when query is empty', () => {
  const model = {
    logEntries: [{ type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, nodeId: '!alpha', node: { short_name: 'Alpha' } }],
    channels: [{ index: 0, label: '0', entries: [] }]
  };
  const result = filterChatModel(model, ' ');
  assert.strictEqual(result.logEntries, model.logEntries);
  assert.strictEqual(result.channels, model.channels);
});

test('a Log entry matches the kind word and detail its line shows, and its type token (LA3)', () => {
  const q = normaliseChatFilterQuery;
  const telemetry = {
    type: CHAT_LOG_ENTRY_TYPES.TELEMETRY,
    ts: 2,
    nodeId: '!a',
    telemetry: { battery_level: 61, voltage: 3.84, channel_utilization: 0.21 },
    previousTelemetryValues: new Map([['battery', '61%']]),
  };
  assert.equal(chatLogEntryMatchesQuery(telemetry, q('3.84 V')), true, 'a value as the line shows it');
  assert.equal(chatLogEntryMatchesQuery(telemetry, q('telemetry · 3.84 V · util 0.2%')), true, 'the changed values');
  assert.equal(chatLogEntryMatchesQuery(telemetry, q('telemetry · 61%')), false, 'an unchanged value is not in the line');
  const info = { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, ts: 1, nodeId: '!a', reason: 'advert' };
  assert.equal(chatLogEntryMatchesQuery(info, q('node info · advert')), true);
  assert.equal(chatLogEntryMatchesQuery(info, q('node-info')), true, 'the type token still matches');
  const fresh = { type: CHAT_LOG_ENTRY_TYPES.NODE_NEW, ts: 1, nodeId: '!a', node: { node_id: '!a', long_name: 'Gate router' } };
  assert.equal(chatLogEntryMatchesQuery(fresh, q('new node · gate')), true);
  const position = { type: CHAT_LOG_ENTRY_TYPES.POSITION, ts: 3, nodeId: '!a', position: { latitude: 38.0249012, longitude: -123.0131987 } };
  assert.equal(chatLogEntryMatchesQuery(position, q('position · 38.0249, -123.0132')), true);
  const neighbor = { type: CHAT_LOG_ENTRY_TYPES.NEIGHBOR, ts: 4, nodeId: '!a', neighborId: '!c', neighborNode: { short_name: 'CAMP' } };
  assert.equal(chatLogEntryMatchesQuery(neighbor, q('neighbor · camp')), true);
  assert.equal(chatLogEntryMatchesQuery({ ...neighbor, neighborNode: undefined }, q('neighbor · !c')), true, 'an unknown neighbour by id');
  const trace = { type: CHAT_LOG_ENTRY_TYPES.TRACE, ts: 5, hopLabels: ['redw', 'CAMP', 'GATE'], traceLabels: ['!1', '!2', '!3'] };
  assert.equal(chatLogEntryMatchesQuery(trace, q('trace · redw → camp')), true, 'the hops as the badges name them');
  assert.equal(chatLogEntryMatchesQuery({ ...trace, hopLabels: undefined }, q('!1 → !2')), true, 'ids without names');
  const waypoint = { type: CHAT_LOG_ENTRY_TYPES.WAYPOINT, ts: 6, nodeId: '!a', waypoint: { icon: 0x2708, name: 'Field', expire: null } };
  assert.equal(chatLogEntryMatchesQuery(waypoint, q('waypoint · ✈ field · expires never')), true);
  const encrypted = { type: CHAT_LOG_ENTRY_TYPES.MESSAGE_ENCRYPTED, ts: 7, message: { encrypted: true, channel: 1, to_id: '^all' } };
  assert.equal(chatLogEntryMatchesQuery(encrypted, q('encrypted · channel 1')), true);
  const direct = { ...encrypted, message: { encrypted: true, to_id: '!0000beef' } };
  assert.equal(chatLogEntryMatchesQuery(direct, q('encrypted · to !0000beef')), true);
  assert.equal(chatLogEntryMatchesQuery({ type: 'unknown', ts: 8 }, q('node info')), false);
});

test('a folded burst matches any of its parts, also across them, and stays whole (LA4)', () => {
  const q = normaliseChatFilterQuery;
  const parts = [
    { type: CHAT_LOG_ENTRY_TYPES.NODE_INFO, ts: 1, nodeId: '!a', reason: 'advert', node: { node_id: '!a', short_name: 'SNS1' } },
    { type: CHAT_LOG_ENTRY_TYPES.POSITION, ts: 2, nodeId: '!a', position: { latitude: 38.0249, longitude: -123.0132 } },
    { type: CHAT_LOG_ENTRY_TYPES.TELEMETRY, ts: 4, nodeId: '!a', telemetry: { battery_level: 61 } },
  ];
  const burst = { type: CHAT_LOG_BURST_TYPE, ts: 1, nodeId: '!a', parts };
  assert.equal(chatLogEntryMatchesQuery(burst, q('telemetry 61%')), true, 'a later part as the folded line shows it');
  assert.equal(chatLogEntryMatchesQuery(burst, q('advert · position 38.0249')), true, 'across two parts');
  assert.equal(chatLogEntryMatchesQuery(burst, q('sns1')), true, 'a part\'s node');
  assert.equal(chatLogEntryMatchesQuery(burst, q('neighbor')), false);
  const { logEntries } = filterChatModel({ logEntries: [burst], channels: [] }, 'position');
  assert.deepEqual(logEntries, [burst], 'the burst is kept with all its parts');
});
