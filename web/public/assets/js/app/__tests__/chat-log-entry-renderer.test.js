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

import { createBroadcastLogEntryElement, EVENT_LABELS, __test__ } from '../chat-log-entry-renderer.js';
import { createDomEnvironment } from './dom-environment.js';

const { selectBadgeSource, resolveFrequency } = __test__;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('createBroadcastLogEntryElement renders telemetry entry with frequency', () => {
  const env = createDomEnvironment();
  const logEntry = {
    ts: 1_000_000,
    kind: 'telemetry',
    node: { short_name: 'TLM', role: 'CLIENT', long_name: 'Telemetry Node' },
    entry: { lora_freq: 915.0 }
  };
  const element = createBroadcastLogEntryElement({
    document: env.document,
    logEntry,
    renderShortHtml: short => `<span class="short">${short ?? '?'}</span>`,
    extractChatMessageMetadata: source => ({ frequency: source?.lora_freq ?? source?.frequency ?? null }),
    formatNodeAnnouncementPrefix: ({ timestamp, frequency }) => `[${timestamp}][${frequency}]`,
    escapeHtml,
    formatTime: () => '12:00:00'
  });
  assert.ok(element);
  assert.equal(element.className, 'chat-entry-event chat-entry-telemetry');
  assert.equal(element.innerHTML, `[12:00:00][915] <span class="short">TLM</span> ${EVENT_LABELS.telemetry}`);
  env.cleanup();
});

test('createBroadcastLogEntryElement falls back to node metadata for frequency', () => {
  const env = createDomEnvironment();
  const logEntry = {
    ts: 1_000_100,
    kind: 'position',
    node: { short_name: 'POS', role: 'CLIENT', long_name: 'Position Node', frequency: '433' },
    entry: {}
  };
  const element = createBroadcastLogEntryElement({
    document: env.document,
    logEntry,
    renderShortHtml: short => `<span>${short ?? '?'}</span>`,
    extractChatMessageMetadata: source => ({ frequency: source?.frequency ?? null }),
    formatNodeAnnouncementPrefix: ({ timestamp, frequency }) => `[${timestamp}][${frequency}]`,
    escapeHtml,
    formatTime: () => '00:00:00'
  });
  assert.ok(element);
  assert.equal(element.innerHTML, `[00:00:00][433] <span>POS</span> ${EVENT_LABELS.position}`);
  env.cleanup();
});

test('createBroadcastLogEntryElement returns null for unsupported kinds', () => {
  const env = createDomEnvironment();
  const element = createBroadcastLogEntryElement({
    document: env.document,
    logEntry: { ts: 0, kind: 'unknown', entry: {} },
    renderShortHtml: () => '',
    extractChatMessageMetadata: () => ({}),
    formatNodeAnnouncementPrefix: () => '',
    escapeHtml,
    formatTime: () => ''
  });
  assert.equal(element, null);
  env.cleanup();
});

test('selectBadgeSource prefers node details but falls back to entry', () => {
  const node = { short_name: 'NODE', role: 'CLIENT', long_name: 'Mesh Node' };
  const entry = { short_name: 'PACK', role: 'REPEATER', long_name: 'Packet Source' };
  const fromNode = selectBadgeSource({ node, entry });
  assert.equal(fromNode.shortName, 'NODE');
  const fromEntry = selectBadgeSource({ node: null, entry });
  assert.equal(fromEntry.role, 'REPEATER');
});

test('resolveFrequency extracts first available frequency', () => {
  const logEntry = {
    entry: { frequency: '915' },
    node: { frequency: '433' }
  };
  const freq = resolveFrequency({
    logEntry,
    extractChatMessageMetadata: source => ({ frequency: source.frequency ?? null })
  });
  assert.equal(freq, '915');
});
