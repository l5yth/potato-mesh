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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractModemMetadata, formatLoraFrequencyMHz, formatModemDisplay, __testUtils } from '../node-modem-metadata.js';

describe('node-modem-metadata', () => {
  it('extracts modem preset and frequency from mixed payloads', () => {
    const payload = {
      modem_preset: '  MediumFast  ',
      lora_freq: '915',
    };
    assert.deepEqual(extractModemMetadata(payload), { modemPreset: 'MediumFast', loraFreq: 915 });
  });

  it('falls back across naming conventions when extracting metadata', () => {
    const payload = {
      modemPreset: 'LongSlow',
      frequency: 868,
    };
    assert.deepEqual(extractModemMetadata(payload), { modemPreset: 'LongSlow', loraFreq: 868 });
  });

  it('ignores invalid modem metadata entries', () => {
    assert.deepEqual(extractModemMetadata({ modem_preset: '  ', lora_freq: 'NaN' }), {
      modemPreset: null,
      loraFreq: null,
    });
  });

  it('formats positive frequencies with MHz suffix', () => {
    assert.equal(formatLoraFrequencyMHz(915), '915MHz');
    assert.equal(formatLoraFrequencyMHz(867.5), '867.5MHz');
    assert.equal(formatLoraFrequencyMHz('433.1234'), '433.123MHz');
    assert.equal(formatLoraFrequencyMHz(null), null);
  });

  it('combines preset and frequency for overlay display', () => {
    assert.equal(formatModemDisplay('MediumFast', 868), 'MediumFast (868MHz)');
    assert.equal(formatModemDisplay('ShortSlow', null), 'ShortSlow');
    assert.equal(formatModemDisplay(null, 433), '433MHz');
    assert.equal(formatModemDisplay(undefined, undefined), null);
  });

  it('exposes trimmed string helper for targeted assertions', () => {
    const { toTrimmedString } = __testUtils;
    assert.equal(toTrimmedString(' hello '), 'hello');
    assert.equal(toTrimmedString(''), null);
    assert.equal(toTrimmedString(null), null);
  });
});
