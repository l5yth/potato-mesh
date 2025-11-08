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
  extractChatMessageMetadata,
  formatChatMessagePrefix,
  formatChatChannelTag,
  formatChatPresetTag,
  formatNodeAnnouncementPrefix,
  __test__
} from '../chat-format.js';

const {
  firstNonNull,
  normalizeString,
  normalizeFrequency,
  normalizeFrequencySlot,
  FREQUENCY_PLACEHOLDER,
  resolveModemPresetCandidate,
  normalizePresetString,
  abbreviatePreset,
  derivePresetInitials,
  normalizePresetSlot,
  PRESET_PLACEHOLDER
} = __test__;

test('extractChatMessageMetadata prefers explicit region_frequency and channel_name', () => {
  const payload = {
    region_frequency: 868,
    channel_name: ' Test Channel ',
    lora_freq: 915,
    channelName: 'Ignored'
  };
  const result = extractChatMessageMetadata(payload);
  assert.deepEqual(result, { frequency: '868', channelName: 'Test Channel', presetCode: null });
});

test('extractChatMessageMetadata falls back to LoRa metadata', () => {
  const payload = {
    lora_freq: 915,
    channelName: 'SpecChannel',
    modem_preset: 'MediumFast'
  };
  const result = extractChatMessageMetadata(payload);
  assert.deepEqual(result, { frequency: '915', channelName: 'SpecChannel', presetCode: 'MF' });
});

test('extractChatMessageMetadata returns null metadata for invalid input', () => {
  assert.deepEqual(extractChatMessageMetadata(null), { frequency: null, channelName: null, presetCode: null });
  assert.deepEqual(extractChatMessageMetadata(undefined), { frequency: null, channelName: null, presetCode: null });
});

test('extractChatMessageMetadata inspects nested node payloads for modem presets', () => {
  const payload = {
    node: {
      modem_preset: 'ShortTurbo'
    }
  };
  const result = extractChatMessageMetadata(payload);
  assert.equal(result.presetCode, 'ST');
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
    formatChatMessagePrefix({ timestamp: '11:46:48', frequency: '868' }),
    '[11:46:48][868]'
  );
  assert.equal(
    formatChatMessagePrefix({ timestamp: '16:19:19', frequency: null }),
    `[16:19:19][${FREQUENCY_PLACEHOLDER}]`
  );
  assert.equal(
    formatChatMessagePrefix({ timestamp: '09:00:00', frequency: '' }),
    `[09:00:00][${FREQUENCY_PLACEHOLDER}]`
  );
});

test('formatChatChannelTag wraps channel names after the short name slot', () => {
  assert.equal(
    formatChatChannelTag({ channelName: 'TEST' }),
    '[TEST]'
  );
  assert.equal(
    formatChatChannelTag({ channelName: '' }),
    '[]'
  );
  assert.equal(
    formatChatChannelTag({ channelName: null }),
    '[]'
  );
});

test('formatChatPresetTag renders preset hints with placeholders', () => {
  assert.equal(formatChatPresetTag({ presetCode: 'MF' }), '[MF]');
  assert.equal(formatChatPresetTag({ presetCode: null }), `[${PRESET_PLACEHOLDER}]`);
});

test('formatNodeAnnouncementPrefix includes optional frequency bracket', () => {
  assert.equal(
    formatNodeAnnouncementPrefix({ timestamp: '12:34:56', frequency: '868' }),
    '[12:34:56][868]'
  );
  assert.equal(
    formatNodeAnnouncementPrefix({ timestamp: '01:02:03', frequency: null }),
    `[01:02:03][${FREQUENCY_PLACEHOLDER}]`
  );
});

test('normalizeFrequencySlot returns placeholder when frequency is missing', () => {
  assert.equal(normalizeFrequencySlot(null), FREQUENCY_PLACEHOLDER);
  assert.equal(normalizeFrequencySlot(''), FREQUENCY_PLACEHOLDER);
  assert.equal(normalizeFrequencySlot(undefined), FREQUENCY_PLACEHOLDER);
  assert.equal(normalizeFrequencySlot('915'), '915');
});

test('resolveModemPresetCandidate walks nested payloads', () => {
  const nested = { node: { modemPreset: 'LongFast' } };
  assert.equal(resolveModemPresetCandidate(nested), 'LongFast');
});

test('normalizePresetString trims strings and ignores empties', () => {
  assert.equal(normalizePresetString(' MediumSlow '), 'MediumSlow');
  assert.equal(normalizePresetString('   '), null);
  assert.equal(normalizePresetString(null), null);
});

test('abbreviatePreset maps known presets to codes', () => {
  assert.equal(abbreviatePreset('VeryLongSlow'), 'VL');
  assert.equal(abbreviatePreset('customPreset'), 'CP');
  assert.equal(abbreviatePreset('X'), 'X?');
});

test('derivePresetInitials falls back to segmented tokens', () => {
  assert.equal(derivePresetInitials('Long Moderate'), 'LM');
  assert.equal(derivePresetInitials('ShortTurbo'), 'ST');
  assert.equal(derivePresetInitials('Z'), 'Z?');
});

test('normalizePresetSlot enforces placeholders and uppercase output', () => {
  assert.equal(normalizePresetSlot('mf'), 'MF');
  assert.equal(normalizePresetSlot(''), PRESET_PLACEHOLDER);
  assert.equal(normalizePresetSlot(null), PRESET_PLACEHOLDER);
});
