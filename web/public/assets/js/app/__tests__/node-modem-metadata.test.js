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
import {
  extractModemMetadata,
  formatLoraFrequencyMHz,
  formatModemDisplay,
  resolveMeshcorePresetDisplay,
  formatPresetDisplay,
  __testUtils,
} from '../node-modem-metadata.js';

const { toTrimmedString, parseMeshcorePresetTokens, bwToShortCode } = __testUtils;

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

  it('returns null metadata for null and non-object input', () => {
    assert.deepEqual(extractModemMetadata(null), { modemPreset: null, loraFreq: null });
    assert.deepEqual(extractModemMetadata('string'), { modemPreset: null, loraFreq: null });
    assert.deepEqual(extractModemMetadata(42), { modemPreset: null, loraFreq: null });
  });

  it('formats positive frequencies with MHz suffix', () => {
    assert.equal(formatLoraFrequencyMHz(915), '915MHz');
    assert.equal(formatLoraFrequencyMHz(867.5), '867.5MHz');
    assert.equal(formatLoraFrequencyMHz('433.1234'), '433.123MHz');
    assert.equal(formatLoraFrequencyMHz(null), null);
  });

  it('combines preset and frequency for overlay display — Meshtastic named preset', () => {
    assert.equal(formatModemDisplay('MediumFast', 868), 'MediumFast (868MHz)');
    assert.equal(formatModemDisplay('ShortSlow', null), 'ShortSlow');
    assert.equal(formatModemDisplay(null, 433), '433MHz');
    assert.equal(formatModemDisplay(undefined, undefined), null);
  });

  it('combines named MeshCore preset and frequency for overlay display', () => {
    assert.equal(formatModemDisplay('SF10/BW250/CR5', 868), 'AU/NZ Wide (868MHz)');
  });

  it('handles string frequency in formatModemDisplay for MeshCore presets', () => {
    // frequency is a string here; exercises the Number(frequency) branch.
    assert.equal(formatModemDisplay('SF10/BW250/CR5', '915'), 'AU/NZ Wide (915MHz)');
  });

  it('passes null frequency to formatModemDisplay gracefully', () => {
    assert.equal(formatModemDisplay('SF10/BW62/CR5', null), 'AU/NZ Narrow');
  });

  it('exposes trimmed string helper for targeted assertions', () => {
    assert.equal(toTrimmedString(' hello '), 'hello');
    assert.equal(toTrimmedString(''), null);
    assert.equal(toTrimmedString(null), null);
  });

  // ---------------------------------------------------------------------------
  // parseMeshcorePresetTokens
  // ---------------------------------------------------------------------------
  describe('parseMeshcorePresetTokens', () => {
    it('returns null for non-SF/BW/CR strings', () => {
      assert.equal(parseMeshcorePresetTokens('MediumFast'), null);
      assert.equal(parseMeshcorePresetTokens('LongSlow'), null);
      assert.equal(parseMeshcorePresetTokens(''), null);
      assert.equal(parseMeshcorePresetTokens(null), null);
    });

    it('returns null when any token is missing', () => {
      assert.equal(parseMeshcorePresetTokens('SF10/BW250'), null);
      assert.equal(parseMeshcorePresetTokens('BW250/CR5'), null);
    });

    it('returns null when a token does not match the expected format', () => {
      assert.equal(parseMeshcorePresetTokens('SF10/BW250/XX5'), null);
      assert.equal(parseMeshcorePresetTokens('SF10/BW250/CR'), null);
    });

    it('parses a valid SF/BW/CR string', () => {
      assert.deepEqual(parseMeshcorePresetTokens('SF10/BW250/CR5'), { sf: 10, bw: 250, cr: 5 });
    });

    it('is case-insensitive', () => {
      assert.deepEqual(parseMeshcorePresetTokens('sf10/bw62/cr5'), { sf: 10, bw: 62, cr: 5 });
    });

    it('accepts tokens in any order', () => {
      assert.deepEqual(parseMeshcorePresetTokens('CR5/SF7/BW62'), { sf: 7, bw: 62, cr: 5 });
    });

    it('handles decimal bandwidth values like 62.5', () => {
      assert.deepEqual(parseMeshcorePresetTokens('SF7/BW62.5/CR5'), { sf: 7, bw: 62.5, cr: 5 });
    });
  });

  // ---------------------------------------------------------------------------
  // bwToShortCode
  // ---------------------------------------------------------------------------
  describe('bwToShortCode', () => {
    it('maps 62 to Na', () => assert.equal(bwToShortCode(62), 'Na'));
    it('maps 62.5 to Na', () => assert.equal(bwToShortCode(62.5), 'Na'));
    it('maps 125 to St', () => assert.equal(bwToShortCode(125), 'St'));
    it('maps 250 to Wi', () => assert.equal(bwToShortCode(250), 'Wi'));
    it('returns null for unknown bandwidths', () => {
      assert.equal(bwToShortCode(500), null);
      assert.equal(bwToShortCode(31), null);
    });
  });

  // ---------------------------------------------------------------------------
  // resolveMeshcorePresetDisplay
  // ---------------------------------------------------------------------------
  describe('resolveMeshcorePresetDisplay', () => {
    it('returns null for non-SF/BW/CR input', () => {
      assert.equal(resolveMeshcorePresetDisplay('MediumFast', null), null);
      assert.equal(resolveMeshcorePresetDisplay(null, null), null);
    });

    // Named preset table: [description, preset, freqMHz, expected]
    const NAMED_CASES = [
      ['AU/NZ Wide',                       'SF10/BW250/CR5', 915,  { longName: 'AU/NZ Wide',   shortCode: 'Wi', displayString: 'AU/NZ Wide'   }],
      ['AU/NZ Narrow',                     'SF10/BW62/CR5',  915,  { longName: 'AU/NZ Narrow', shortCode: 'Na', displayString: 'AU/NZ Narrow' }],
      ['EU/UK Wide',                       'SF11/BW250/CR5', 868,  { longName: 'EU/UK Wide',   shortCode: 'Wi', displayString: 'EU/UK Wide'   }],
      ['EU/UK Narrow',                     'SF8/BW62/CR8',   868,  { longName: 'EU/UK Narrow', shortCode: 'Na', displayString: 'EU/UK Narrow' }],
      ['CZ/SK Narrow (freq < 900)',        'SF7/BW62/CR5',   868,  { longName: 'CZ/SK Narrow', shortCode: 'Na', displayString: 'CZ/SK Narrow' }],
      ['US/CA Narrow (freq >= 900)',        'SF7/BW62/CR5',   915,  { longName: 'US/CA Narrow', shortCode: 'Na', displayString: 'US/CA Narrow' }],
      ['US/CA Narrow (exact 900 boundary)', 'SF7/BW62/CR5',   900,  { longName: 'US/CA Narrow', shortCode: 'Na', displayString: 'US/CA Narrow' }],
    ];
    for (const [desc, preset, freq, expected] of NAMED_CASES) {
      it(`resolves ${desc}`, () => {
        assert.deepEqual(resolveMeshcorePresetDisplay(preset, freq), expected);
      });
    }

    // Fallback cases: [description, preset, freqMHz, expected]
    const FALLBACK_CASES = [
      ['SF7/BW62/CR5 with unknown freq uses BW fallback', 'SF7/BW62/CR5',  null, { longName: null, shortCode: 'Na', displayString: 'BW62/SF7/CR5'   }],
      ['unknown BW has no short code',                    'SF12/BW500/CR7', null, { longName: null, shortCode: null, displayString: 'BW500/SF12/CR7' }],
      ['125 kHz BW gives St short code',                  'SF9/BW125/CR6',  null, { longName: null, shortCode: 'St', displayString: 'BW125/SF9/CR6'  }],
    ];
    for (const [desc, preset, freq, expected] of FALLBACK_CASES) {
      it(`falls back: ${desc}`, () => {
        assert.deepEqual(resolveMeshcorePresetDisplay(preset, freq), expected);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // formatPresetDisplay
  // ---------------------------------------------------------------------------
  describe('formatPresetDisplay', () => {
    it('returns long name for named MeshCore presets', () => {
      assert.equal(formatPresetDisplay('SF10/BW250/CR5', 915), 'AU/NZ Wide');
    });

    it('returns re-ordered BW/SF/CR for unknown SF/BW/CR presets', () => {
      assert.equal(formatPresetDisplay('SF12/BW500/CR7', null), 'BW500/SF12/CR7');
    });

    it('returns raw string for non-SF/BW/CR presets', () => {
      assert.equal(formatPresetDisplay('MediumFast', null), 'MediumFast');
    });

    it('returns null when preset is absent', () => {
      assert.equal(formatPresetDisplay(null, null), null);
      assert.equal(formatPresetDisplay('  ', null), null);
    });
  });
});
