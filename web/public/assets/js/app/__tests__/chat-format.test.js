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

// ---------------------------------------------------------------------------
// abbreviatePreset — MeshCore SF/BW/CR presets
// ---------------------------------------------------------------------------

// [description, preset, freqMHz, expectedCode]
const ABBREVIATE_MESHCORE_CASES = [
  ['AU/NZ Wide → Wi',                         'SF10/BW250/CR5', null, 'Wi'],
  ['EU/UK Narrow → Na',                        'SF8/BW62/CR8',   null, 'Na'],
  ['CZ/SK Narrow at 868 MHz → Na',             'SF7/BW62/CR5',   868,  'Na'],
  ['US/CA Narrow at 915 MHz → Na',             'SF7/BW62/CR5',   915,  'Na'],
  ['US/CA Narrow at exact 900 MHz boundary',   'SF7/BW62/CR5',   900,  'Na'],
  ['BW fallback Na when freq unknown',         'SF7/BW62/CR5',   null, 'Na'],
  ['125 kHz BW fallback → St',                 'SF9/BW125/CR6',  null, 'St'],
  ['unknown BW → null',                        'SF12/BW500/CR7', null,  null],
];
for (const [desc, preset, freq, expected] of ABBREVIATE_MESHCORE_CASES) {
  test(`abbreviatePreset MeshCore: ${desc}`, () => {
    assert.equal(abbreviatePreset(preset, freq), expected);
  });
}

test('abbreviatePreset leaves Meshtastic named presets unaffected', () => {
  assert.equal(abbreviatePreset('MediumFast', null), 'MF');
  assert.equal(abbreviatePreset('LongSlow', null), 'LS');
});

// ---------------------------------------------------------------------------
// extractChatMessageMetadata — SF/BW/CR preset + frequency
// ---------------------------------------------------------------------------

test('extractChatMessageMetadata produces Wi code for AU/NZ Wide with freq', () => {
  const result = extractChatMessageMetadata({
    region_frequency: 915,
    modem_preset: 'SF10/BW250/CR5',
  });
  assert.equal(result.presetCode, 'Wi');
  assert.equal(result.frequency, '915');
});

test('extractChatMessageMetadata produces Na code for EU/UK Narrow with freq', () => {
  const result = extractChatMessageMetadata({
    lora_freq: 868,
    modem_preset: 'SF8/BW62/CR8',
  });
  assert.equal(result.presetCode, 'Na');
});

test('extractChatMessageMetadata uses BW fallback Na when freq is absent', () => {
  const result = extractChatMessageMetadata({
    modem_preset: 'SF7/BW62/CR5',
  });
  assert.equal(result.presetCode, 'Na');
});
