/*
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

import { extractChatMessageMetadata, formatChatMessagePrefix, formatNodeAnnouncementPrefix, __test__ } from '../chat-format.js';

const { firstNonNull, normalizeString, normalizeFrequency } = __test__;

test('extractChatMessageMetadata prefers explicit region_frequency and channel_name', () => {
  const payload = {
    region_frequency: 868,
    channel_name: ' Test Channel ',
    lora_freq: 915,
    channelName: 'Ignored'
  };
  const result = extractChatMessageMetadata(payload);
  assert.deepEqual(result, { frequency: '868', channelName: 'Test Channel' });
});

test('extractChatMessageMetadata falls back to LoRa metadata', () => {
  const payload = {
    lora_freq: 915,
    channelName: 'SpecChannel'
  };
  const result = extractChatMessageMetadata(payload);
  assert.deepEqual(result, { frequency: '915', channelName: 'SpecChannel' });
});

test('extractChatMessageMetadata returns null metadata for invalid input', () => {
  assert.deepEqual(extractChatMessageMetadata(null), { frequency: null, channelName: null });
  assert.deepEqual(extractChatMessageMetadata(undefined), { frequency: null, channelName: null });
});

test('firstNonNull returns the first non-null candidate', () => {
  assert.equal(firstNonNull(null, undefined, '', 'value'), '');
  assert.equal(firstNonNull(undefined, null), null);
});

test('normalizeString trims strings and rejects empties', () => {
  assert.equal(normalizeString(' Spec '), 'Spec');
  assert.equal(normalizeString('   '), null);
  assert.equal(normalizeString(123), '123');
  assert.equal(normalizeString(Number.POSITIVE_INFINITY), null);
});

test('normalizeFrequency handles numeric and string inputs', () => {
  assert.equal(normalizeFrequency(915), '915');
  assert.equal(normalizeFrequency(868.125), '868.125');
  assert.equal(normalizeFrequency(' 868MHz '), '868');
  assert.equal(normalizeFrequency('n/a'), 'n/a');
  assert.equal(normalizeFrequency(-5), null);
  assert.equal(normalizeFrequency(null), null);
});

test('formatChatMessagePrefix preserves bracket placeholders', () => {
  assert.equal(
    formatChatMessagePrefix({ timestamp: '11:46:48', frequency: '868', channelName: 'TEST' }),
    '[11:46:48][868][TEST]'
  );
  assert.equal(
    formatChatMessagePrefix({ timestamp: '16:19:19', frequency: null, channelName: 'MediumFast' }),
    '[16:19:19][][MediumFast]'
  );
  assert.equal(
    formatChatMessagePrefix({ timestamp: '09:00:00', frequency: '', channelName: '' }),
    '[09:00:00][][]'
  );
});

test('formatNodeAnnouncementPrefix includes optional frequency bracket', () => {
  assert.equal(
    formatNodeAnnouncementPrefix({ timestamp: '12:34:56', frequency: '868' }),
    '[12:34:56][868]'
  );
  assert.equal(formatNodeAnnouncementPrefix({ timestamp: '01:02:03', frequency: null }), '[01:02:03][]');
});
