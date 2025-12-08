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
