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

/**
 * Folded bursts in the Log view (SPEC LA4, design review rc4 L4): a node's
 * node info, position and telemetry within 60 s of a burst's first entry
 * read as one line at the first entry's place and time; one part per kind;
 * other nodes and kinds in between do not break a burst; the raw entries
 * stay unfolded; the folded line keeps its first entry's key.
 *
 * @module __tests__/chat-log-burst
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_LOG_ENTRY_TYPES } from '../chat-log-tabs.js';
import {
  CHAT_LOG_BURST_KINDS,
  CHAT_LOG_BURST_TYPE,
  CHAT_LOG_BURST_WINDOW_SECONDS,
  foldChatLogBursts,
} from '../chat-log-burst.js';
import { chatLogEntryKey } from '../main/chat-entry-keys.js';
import { innerHtml, withApp } from './main-app-test-helpers.js';
import { visibleText } from './visible-text.js';

const { NODE_INFO, POSITION, TELEMETRY, NEIGHBOR, MESSAGE_ENCRYPTED, NODE_NEW } = CHAT_LOG_ENTRY_TYPES;

/** 07:41:05 local time on 2026-10-08, Unix seconds. */
const T0 = Math.floor(new Date(2026, 9, 8, 7, 41, 5).getTime() / 1000);

/** The sensor node of the design's burst. */
const SNS1 = Object.freeze({
  node_id: '!5e4501',
  short_name: 'SNS1',
  long_name: 'Creek sensor',
  role: 'SENSOR',
  protocol: 'meshtastic',
  lora_freq: 869,
  modem_preset: 'MediumFast',
});

/**
 * A Log entry of ``type`` for ``nodeId`` at ``ts``.
 *
 * @param {string} type Entry type.
 * @param {number} ts Unix seconds.
 * @param {string} nodeId Node id.
 * @param {Object} [extra] More fields.
 * @returns {Object} Entry.
 */
function entry(type, ts, nodeId, extra = {}) {
  return { type, ts, nodeId, ...extra };
}

test('a node\'s node info, position and telemetry within 60 s fold into one entry at the first one\'s place (LA4)', () => {
  assert.equal(CHAT_LOG_BURST_WINDOW_SECONDS, 60);
  assert.deepEqual([...CHAT_LOG_BURST_KINDS], [NODE_INFO, POSITION, TELEMETRY]);
  const before = entry(MESSAGE_ENCRYPTED, T0 - 10, null, { message: { id: 1 } });
  const info = entry(NODE_INFO, T0, '!a', { reason: 'advert' });
  const position = entry(POSITION, T0 + 1, '!a');
  const telemetry = entry(TELEMETRY, T0 + 60, '!a');
  const view = foldChatLogBursts([before, info, position, telemetry]);
  assert.equal(view.length, 2);
  assert.equal(view[0], before, 'an entry that folds with nothing passes through as itself');
  assert.deepEqual(view[1], { type: CHAT_LOG_BURST_TYPE, ts: T0, nodeId: '!a', parts: [info, position, telemetry] });
  assert.ok(view[1].parts.every((part, index) => part === [info, position, telemetry][index]), 'the parts are the raw entries');
});

test('a part 61 s after the first, or a second part of a kind, starts a new burst (LA4)', () => {
  const late = foldChatLogBursts([entry(NODE_INFO, T0, '!a'), entry(POSITION, T0 + 61, '!a')]);
  assert.deepEqual(late.map(item => item.type), [NODE_INFO, POSITION]);

  const info = entry(NODE_INFO, T0, '!a');
  const position = entry(POSITION, T0 + 2, '!a');
  const secondInfo = entry(NODE_INFO, T0 + 3, '!a');
  const telemetry = entry(TELEMETRY, T0 + 4, '!a');
  const view = foldChatLogBursts([info, position, secondInfo, telemetry]);
  assert.equal(view.length, 2);
  assert.deepEqual(view[0].parts, [info, position]);
  assert.deepEqual(view[1].parts, [secondInfo, telemetry], 'the telemetry joins the burst the second node info started');
});

test('entries of other nodes or kinds in between do not break a burst; other kinds never fold (LA4)', () => {
  const info = entry(NODE_INFO, T0, '!a');
  const otherNode = entry(POSITION, T0 + 1, '!b');
  const neighbor = entry(NEIGHBOR, T0 + 2, '!a');
  const fresh = entry(NODE_NEW, T0 + 3, '!a');
  const telemetry = entry(TELEMETRY, T0 + 5, '!a');
  const otherTelemetry = entry(TELEMETRY, T0 + 6, '!b');
  const anonymous = entry(TELEMETRY, T0 + 7, null);
  const view = foldChatLogBursts([info, otherNode, neighbor, fresh, telemetry, otherTelemetry, anonymous, null]);
  assert.equal(view.length, 6);
  assert.deepEqual(view[0].parts, [info, telemetry]);
  assert.deepEqual(view[1].parts, [otherNode, otherTelemetry]);
  assert.equal(view[2], neighbor);
  assert.equal(view[3], fresh);
  assert.equal(view[4], anonymous, 'an entry without a node id never folds');
  assert.equal(view[5], null, 'a hole passes through for the renderer to skip');
});

test('folding leaves the raw entries and their list as they are (LA4)', () => {
  const entries = [entry(NODE_INFO, T0, '!a'), entry(TELEMETRY, T0 + 1, '!a')];
  const copy = structuredClone(entries);
  foldChatLogBursts(entries);
  assert.deepEqual(entries, copy);
  assert.deepEqual(foldChatLogBursts(entries, { windowSeconds: 0 }).map(item => item.type), [NODE_INFO, TELEMETRY]);
});

test('windowSeconds 0 folds nothing, not even entries of one second (LA4)', () => {
  const entries = [entry(NODE_INFO, T0, '!a'), entry(POSITION, T0, '!a'), entry(TELEMETRY, T0, '!a')];
  assert.deepEqual(foldChatLogBursts(entries, { windowSeconds: 0 }), entries);
  assert.equal(foldChatLogBursts(entries)[0].type, CHAT_LOG_BURST_TYPE, 'the default window folds them');
});

test('a folded line keeps its first entry\'s key, so the row that showed that entry alone is kept (LA4)', () => {
  const info = entry(NODE_INFO, T0, '!a', { reason: 'advert' });
  const [burst] = foldChatLogBursts([info, entry(POSITION, T0 + 1, '!a')]);
  assert.equal(chatLogEntryKey(burst), chatLogEntryKey(info));
  assert.equal(chatLogEntryKey({ type: CHAT_LOG_BURST_TYPE, parts: [] }), 'log:node-burst::::', 'an empty burst keys like any entry');
});

test('the Log renders a burst as "SNS1 node info · advert · position … · telemetry …", updated in place (LA4)', () => {
  withApp((t) => {
    const parts = [
      entry(NODE_INFO, T0, SNS1.node_id, { reason: 'advert', node: SNS1 }),
      entry(POSITION, T0 + 1, SNS1.node_id, { node: SNS1, position: { latitude: 38.0249, longitude: -123.0132 } }),
      entry(TELEMETRY, T0 + 4, SNS1.node_id, {
        node: SNS1,
        telemetry: { battery_level: 61, voltage: 3.84, channel_utilization: 0.21 },
      }),
    ];
    const [burst] = foldChatLogBursts(parts);
    const line = t.buildChatLogEntryParts(burst, { uniform: true });
    assert.equal(line.className, 'chat-entry-node');
    assert.equal(line.inPlace, true, 'the burst updates its row in place');
    assert.ok(
      line.html.startsWith('<span class="chat-entry-time" title="07:41:05 · 869 MHz · MediumFast">07:41</span> <span class="chat-entry-body"><span class="short-name"'),
      line.html,
    );
    const words = visibleText(innerHtml({ innerHTML: line.html }));
    assert.equal(words, '07:41 SNS1 node info · advert · position 38.0249, -123.0132 · telemetry 61% · 3.84 V · util 0.2%');
    assert.ok(line.html.includes('title="07:41:06"'), 'the position keeps its own time');
    assert.ok(line.html.includes('title="07:41:09 · Battery: 61%'), 'the telemetry keeps its own time and full set');
    assert.equal(t.buildChatLogEntryParts(parts[0]).inPlace, undefined, 'a lone entry is rebuilt as before');
  });
});
